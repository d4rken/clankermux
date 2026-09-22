import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mockFetch } from "@clankermux/test-support";
import {
	clearGrokSubscriptionUserIdCache,
	fetchGrokSubscriptionUsage,
	GROK_SUBSCRIPTION_BILLING_ENDPOINT,
	parseGrokSubscriptionBilling,
	peekGrokSubscriptionUserIdMemo,
} from "../grok-subscription-usage-fetcher";

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);

/**
 * The live payload, as the billing endpoint served it on 2026-09-22. Cents are
 * wrapped as `{val}`; `creditUsagePercent` is ABSENT, which is the case the
 * whole fetcher is built around.
 */
function billingBody(
	patch: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		config: {
			currentPeriod: {
				type: "USAGE_PERIOD_TYPE_WEEKLY",
				start: new Date(NOW - 24 * HOUR).toISOString(),
				end: new Date(NOW + 6 * 24 * HOUR).toISOString(),
			},
			onDemandCap: { val: 0 },
			onDemandUsed: { val: 250 },
			prepaidBalance: { val: 1000 },
			isUnifiedBillingUser: true,
			...patch,
		},
	};
}

describe("parseGrokSubscriptionBilling", () => {
	it("reads the weekly pool, its reset and the cents wrappers", () => {
		const outcome = parseGrokSubscriptionBilling(
			billingBody({ creditUsagePercent: 41.5 }),
			NOW,
		);
		expect(outcome).toEqual({
			status: "ok",
			data: {
				kind: "grok-subscription",
				weeklyUtilization: 41.5,
				weeklyResetAt: NOW + 6 * 24 * HOUR,
				weeklyPeriodStartAt: NOW - 24 * HOUR,
				onDemandCapCents: 0,
				onDemandUsedCents: 250,
				prepaidBalanceCents: 1000,
			},
		});
	});

	it("reports an ABSENT creditUsagePercent as unknown, never as 0", () => {
		// The field was missing from the live probe. Proto3 omits zero-valued
		// scalars, which explains how a zero COULD vanish — it does not establish
		// that this endpoint ever populates the field for this billing mode. A
		// fabricated 0% is actionable headroom evidence and could release a
		// cooldown on an account that is in fact exhausted.
		const outcome = parseGrokSubscriptionBilling(billingBody(), NOW);
		expect(outcome.status).toBe("ok");
		if (outcome.status !== "ok") return;
		expect(outcome.data.weeklyUtilization).toBeNull();
		expect(outcome.data.weeklyUtilization).not.toBe(0);
		// The rest of the reading still stands: the reset is what the tile needs.
		expect(outcome.data.weeklyResetAt).toBe(NOW + 6 * 24 * HOUR);
	});

	it("treats an explicit null percentage as unknown too", () => {
		const outcome = parseGrokSubscriptionBilling(
			billingBody({ creditUsagePercent: null }),
			NOW,
		);
		expect(outcome.status).toBe("ok");
		if (outcome.status !== "ok") return;
		expect(outcome.data.weeklyUtilization).toBeNull();
	});

	it.each([
		["a string", "41.5"],
		["NaN", Number.NaN],
		["a negative percent", -1],
		["a percent above 100", 101],
	])("reports %s percentage as no reading at all", (_label, value) => {
		// Present but unusable is NOT the same as absent: clamping or coercing
		// would invent a number in the most damaging direction available.
		expect(
			parseGrokSubscriptionBilling(
				billingBody({ creditUsagePercent: value }),
				NOW,
			),
		).toEqual({ status: "failed" });
	});

	it.each([
		[
			"a non-weekly period",
			{ currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", end: null } },
		],
		[
			"a period that already ended",
			{
				currentPeriod: {
					type: "USAGE_PERIOD_TYPE_WEEKLY",
					end: new Date(NOW - HOUR).toISOString(),
				},
			},
		],
		[
			"an unparseable period end",
			{ currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "soon" } },
		],
		["a non-unified billing user", { isUnifiedBillingUser: false }],
		["no unified-billing flag at all", { isUnifiedBillingUser: undefined }],
	])("answers `unrecognized` for %s", (_label, patch) => {
		// A third outcome, distinct from data and from failure: folding it into a
		// failure would back the poller off toward its 30-minute ceiling, spacing
		// out the very warning that names the unknown shape.
		expect(parseGrokSubscriptionBilling(billingBody(patch), NOW)).toEqual({
			status: "unrecognized",
		});
	});

	it.each([
		["a non-object body", 42],
		["a null body", null],
		["a body with no config", { billingPeriodStart: "2026-09-22" }],
		["a config that is not an object", { config: "credits" }],
	])("fails on %s", (_label, body) => {
		expect(parseGrokSubscriptionBilling(body, NOW)).toEqual({
			status: "failed",
		});
	});
});

describe("fetchGrokSubscriptionUsage", () => {
	let originalFetch: typeof globalThis.fetch;
	let dialled: { url: string; headers: Headers }[] = [];

	/**
	 * Route `/v1/user` and `/v1/billing` separately: the billing call carries
	 * `x-userid`, which is resolved from the profile read.
	 */
	function stubEndpoints(options: {
		user?: Response | (() => Response);
		billing: Response | (() => Response);
	}): void {
		globalThis.fetch = mockFetch(async (input, init) => {
			const url = String(input instanceof Request ? input.url : input);
			dialled.push({ url, headers: new Headers(init?.headers) });
			const pick = url.includes("/v1/user")
				? (options.user ?? Response.json({ userId: "user-abc" }))
				: options.billing;
			return typeof pick === "function" ? pick() : pick;
		});
	}

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		dialled = [];
		clearGrokSubscriptionUserIdCache();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearGrokSubscriptionUserIdCache();
	});

	it("dials the billing endpoint with the CLI identity headers and x-userid", async () => {
		stubEndpoints({ billing: () => Response.json(billingBody()) });

		const outcome = await fetchGrokSubscriptionUsage("grok-token", {
			accountId: "acc",
		});

		expect(outcome.status).toBe("ok");
		const billing = dialled.find((d) => d.url.includes("/v1/billing"));
		expect(billing?.url).toBe(GROK_SUBSCRIPTION_BILLING_ENDPOINT);
		expect(billing?.headers.get("authorization")).toBe("Bearer grok-token");
		// A bearer token on its own is refused with 426; the identity set is
		// load-bearing on this host.
		expect(billing?.headers.get("x-grok-client-identifier")).toBe("grok-shell");
		expect(billing?.headers.get("X-XAI-Token-Auth")).toBe("xai-grok-cli");
		expect(billing?.headers.get("x-userid")).toBe("user-abc");
	});

	it("still reads billing when the profile read fails, without x-userid", async () => {
		// `x-userid` changed nothing in the probe, so an unavailable profile must
		// not cost the account its quota reading.
		stubEndpoints({
			user: () => new Response("nope", { status: 403 }),
			billing: () => Response.json(billingBody({ creditUsagePercent: 12 })),
		});

		const outcome = await fetchGrokSubscriptionUsage("grok-token", {
			accountId: "acc",
		});

		expect(outcome.status).toBe("ok");
		const billing = dialled.find((d) => d.url.includes("/v1/billing"));
		expect(billing?.headers.has("x-userid")).toBe(false);
	});

	it("resolves the user id once per account while the token is unchanged", async () => {
		stubEndpoints({ billing: () => Response.json(billingBody()) });

		await fetchGrokSubscriptionUsage("grok-token", { accountId: "acc" });
		await fetchGrokSubscriptionUsage("grok-token", { accountId: "acc" });

		expect(dialled.filter((d) => d.url.includes("/v1/user"))).toHaveLength(1);
		expect(dialled.filter((d) => d.url.includes("/v1/billing"))).toHaveLength(
			2,
		);
	});

	it("re-resolves the user id after the access token rotates", async () => {
		stubEndpoints({ billing: () => Response.json(billingBody()) });

		await fetchGrokSubscriptionUsage("grok-token", { accountId: "acc" });
		await fetchGrokSubscriptionUsage("rotated-token", { accountId: "acc" });

		expect(dialled.filter((d) => d.url.includes("/v1/user"))).toHaveLength(2);
	});

	it("memoises a digest of the access token, never the token itself", async () => {
		stubEndpoints({ billing: () => Response.json(billingBody()) });

		await fetchGrokSubscriptionUsage("grok-secret-token", { accountId: "acc" });

		const memo = peekGrokSubscriptionUserIdMemo("acc");
		expect(memo?.userId).toBe("user-abc");
		expect(JSON.stringify(memo)).not.toContain("grok-secret-token");
	});

	it("drops one account's memo entry and leaves the others", async () => {
		stubEndpoints({ billing: () => Response.json(billingBody()) });
		await fetchGrokSubscriptionUsage("grok-token", { accountId: "acc" });
		await fetchGrokSubscriptionUsage("grok-token", { accountId: "other" });

		clearGrokSubscriptionUserIdCache("acc");

		expect(peekGrokSubscriptionUserIdMemo("acc")).toBeUndefined();
		expect(peekGrokSubscriptionUserIdMemo("other")?.userId).toBe("user-abc");
	});

	it("fails on a non-2xx billing response", async () => {
		stubEndpoints({ billing: () => new Response("", { status: 500 }) });
		expect(await fetchGrokSubscriptionUsage("grok-token")).toEqual({
			status: "failed",
		});
	});

	it("fails on a body that is not JSON", async () => {
		stubEndpoints({ billing: () => new Response("<html>login</html>") });
		expect(await fetchGrokSubscriptionUsage("grok-token")).toEqual({
			status: "failed",
		});
	});

	it.each([
		"declared by content-length",
		"streamed in chunks",
	])("refuses a body past the size bound (%s) instead of buffering it", async (mode) => {
		// Undocumented endpoint on someone else's host: an unbounded read is a
		// memory hazard held open by the account's in-flight polling slot. A
		// chunked body carries no content-length, so the reader has to enforce
		// the bound itself rather than trusting the header.
		const oversized = `{"config":{"pad":"${"x".repeat(80 * 1024)}"}}`;
		stubEndpoints({
			billing: () => {
				if (mode === "declared by content-length") {
					return new Response(oversized, {
						headers: { "content-type": "application/json" },
					});
				}
				const bytes = new TextEncoder().encode(oversized);
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							for (let at = 0; at < bytes.length; at += 8 * 1024) {
								controller.enqueue(bytes.subarray(at, at + 8 * 1024));
							}
							controller.close();
						},
					}),
					{ headers: { "content-type": "application/json" } },
				);
			},
		});
		expect(await fetchGrokSubscriptionUsage("grok-token")).toEqual({
			status: "failed",
		});
	});

	it("fails without dialling anything when the token is blank", async () => {
		stubEndpoints({ billing: () => Response.json(billingBody()) });
		expect(await fetchGrokSubscriptionUsage("   ")).toEqual({
			status: "failed",
		});
		expect(dialled).toHaveLength(0);
	});

	it("still reads billing when /v1/user hangs until the usage timeout fires", async () => {
		// The profile read is decoration: a /v1/user that stalls must not spend
		// the billing read's own time budget or hand it an already-aborted signal.
		// Like real fetch, the stub rejects a request whose signal is (or becomes)
		// aborted; /v1/user otherwise never answers.
		const abortError = () =>
			new DOMException("The operation was aborted.", "AbortError");
		globalThis.fetch = mockFetch(async (input, init) => {
			const url = String(input instanceof Request ? input.url : input);
			dialled.push({ url, headers: new Headers(init?.headers) });
			const signal = init?.signal;
			if (signal?.aborted) throw abortError();
			if (url.includes("/v1/user")) {
				return new Promise<Response>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(abortError()), {
						once: true,
					});
				});
			}
			if (url.includes("/v1/billing")) {
				return Response.json(billingBody({ creditUsagePercent: 12 }));
			}
			throw new Error(`unexpected URL ${url}`);
		});

		const outcome = await fetchGrokSubscriptionUsage("grok-token", {
			accountId: "acc",
		});

		expect(outcome.status).toBe("ok");
	}, 15_000);

	it("degrades a transport error to a failure rather than throwing", async () => {
		globalThis.fetch = mockFetch(async () => {
			throw new Error("ECONNRESET");
		});
		expect(await fetchGrokSubscriptionUsage("grok-token")).toEqual({
			status: "failed",
		});
	});
});
