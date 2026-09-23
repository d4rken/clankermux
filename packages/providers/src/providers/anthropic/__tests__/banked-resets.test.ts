// Nothing here reaches the network: every test stubs global fetch.
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mockFetch } from "@clankermux/test-support";
import type { AnthropicBankedResetStatus } from "@clankermux/types";
import {
	ANTHROPIC_BANKED_RESET_INELIGIBLE_REFRESH_MS,
	ANTHROPIC_BANKED_RESET_REFRESH_MS,
	ANTHROPIC_BANKED_RESET_RETRY_MS,
	ANTHROPIC_BANKED_RESET_STATUS_ENDPOINT,
	anthropicBankedResetCache,
	claimAnthropicBankedReset,
	fetchAnthropicBankedResetStatus,
	parseAnthropicBankedResetClaimResponse,
	parseCedarEmberBlock,
} from "../banked-resets";

const ORG = "5d1c2a9e-3b7f-4c21-8e6a-0f4b9d7c2e18";
const ENDS_AT = "2026-10-01T00:00:00Z";

function grant(overrides: Record<string, unknown> = {}) {
	return {
		id: "g_week_1",
		label: "Weekly reset",
		resets_total: 2,
		resets_left: 1,
		starts_at: "2026-09-01T00:00:00Z",
		ends_at: ENDS_AT,
		clears: ["seven_day", "five_hour"],
		paused: false,
		usable_now: true,
		use_requires_limit: false,
		percent_used: { seven_day: 100, five_hour: 40 },
		blocking: ["seven_day"],
		...overrides,
	};
}

describe("parseCedarEmberBlock", () => {
	it("parses a complete block", () => {
		expect(
			parseCedarEmberBlock({
				eligible: true,
				at_limit: true,
				exhausted: ["seven_day"],
				grants: [grant()],
				next_grant_id: "g_week_1",
				weekly_resets_at: "2026-09-25T10:00:00Z",
				cooldown_until: "2026-09-22T13:00:00Z",
			}),
		).toEqual({
			eligible: true,
			ineligibleReason: null,
			atLimit: true,
			exhausted: ["seven_day"],
			grants: [
				{
					id: "g_week_1",
					label: "Weekly reset",
					resetsTotal: 2,
					resetsLeft: 1,
					startsAt: Date.parse("2026-09-01T00:00:00Z"),
					endsAt: Date.parse(ENDS_AT),
					clears: ["seven_day", "five_hour"],
					paused: false,
					usableNow: true,
					useRequiresLimit: false,
					percentUsed: { seven_day: 100, five_hour: 40 },
					blocking: ["seven_day"],
				},
			],
			nextGrantId: "g_week_1",
			weeklyResetsAt: Date.parse("2026-09-25T10:00:00Z"),
			cooldownUntil: Date.parse("2026-09-22T13:00:00Z"),
		} satisfies AnthropicBankedResetStatus);
	});

	it("returns null for a missing or non-object block", () => {
		for (const value of [undefined, null, "x", 3, []]) {
			expect(parseCedarEmberBlock(value)).toBeNull();
		}
	});

	it("reads ineligible reasons, falling back to unknown", () => {
		expect(
			parseCedarEmberBlock({ eligible: false, ineligible_reason: "tier" })
				?.ineligibleReason,
		).toBe("tier");
		expect(
			parseCedarEmberBlock({ eligible: false, ineligible_reason: "new_gate" })
				?.ineligibleReason,
		).toBe("unknown");
		const bare = parseCedarEmberBlock({ eligible: false });
		expect(bare?.eligible).toBe(false);
		expect(bare?.ineligibleReason).toBeNull();
		expect(bare?.grants).toEqual([]);
	});

	it("treats a non-boolean eligible as not eligible", () => {
		expect(parseCedarEmberBlock({ eligible: "yes" })?.eligible).toBe(false);
	});

	it("filters unknown windows from clears, exhausted and blocking", () => {
		const status = parseCedarEmberBlock({
			eligible: true,
			exhausted: ["seven_day_opus", "seven_day_future", 7],
			grants: [
				grant({
					clears: ["seven_day_sonnet", "ten_day"],
					blocking: ["bogus", "five_hour"],
				}),
			],
		});
		expect(status?.exhausted).toEqual(["seven_day_opus"]);
		expect(status?.grants[0]?.clears).toEqual(["seven_day_sonnet"]);
		expect(status?.grants[0]?.blocking).toEqual(["five_hour"]);
	});

	it("keeps percent_used only for known windows with an integer 0..100", () => {
		const status = parseCedarEmberBlock({
			eligible: true,
			grants: [
				grant({
					percent_used: {
						five_hour: 0,
						seven_day: 100,
						seven_day_opus: 101,
						seven_day_sonnet: -1,
						seven_day_cowork: 50.5,
						seven_day_omelette: "50",
						ten_day: 10,
					},
				}),
			],
		});
		expect(status?.grants[0]?.percentUsed).toEqual({
			five_hour: 0,
			seven_day: 100,
		});
	});

	it("defaults use_requires_limit to true and flags to false", () => {
		const status = parseCedarEmberBlock({
			eligible: true,
			grants: [
				{
					id: "g1",
					resets_total: 1,
					resets_left: 1,
					clears: ["seven_day"],
				},
			],
		});
		expect(status?.grants[0]).toEqual({
			id: "g1",
			label: null,
			resetsTotal: 1,
			resetsLeft: 1,
			startsAt: null,
			endsAt: null,
			clears: ["seven_day"],
			paused: false,
			usableNow: false,
			useRequiresLimit: true,
			percentUsed: {},
			blocking: [],
		});
	});

	it("drops malformed grants and keeps the rest", () => {
		const status = parseCedarEmberBlock({
			eligible: true,
			grants: [
				grant({ id: "Bad-Upper" }),
				grant({ id: "x".repeat(41) }),
				grant({ id: 5 }),
				grant({ resets_left: -1 }),
				grant({ resets_left: 1.5 }),
				grant({ resets_total: "2" }),
				grant({ clears: "seven_day" }),
				"not-a-grant",
				grant({ id: "g-ok_2" }),
			],
		});
		expect(status?.grants.map((g) => g.id)).toEqual(["g-ok_2"]);
	});

	it("keeps next_grant_id only when it names a parsed grant", () => {
		const block = {
			eligible: true,
			grants: [grant({ id: "g_a" }), grant({ id: "BAD" })],
		};
		expect(
			parseCedarEmberBlock({ ...block, next_grant_id: "g_a" })?.nextGrantId,
		).toBe("g_a");
		expect(
			parseCedarEmberBlock({ ...block, next_grant_id: "BAD" })?.nextGrantId,
		).toBeNull();
		expect(
			parseCedarEmberBlock({ ...block, next_grant_id: "g_missing" })
				?.nextGrantId,
		).toBeNull();
	});

	it("accepts epoch seconds and epoch milliseconds for instants", () => {
		const status = parseCedarEmberBlock({
			eligible: true,
			weekly_resets_at: 1_790_000_000,
			cooldown_until: 1_790_000_000_000,
		});
		expect(status?.weeklyResetsAt).toBe(1_790_000_000_000);
		expect(status?.cooldownUntil).toBe(1_790_000_000_000);
		expect(
			parseCedarEmberBlock({ eligible: true, cooldown_until: "nope" })
				?.cooldownUntil,
		).toBeNull();
	});
});

let fetchSpy: ReturnType<typeof spyOn> | null = null;
afterEach(() => {
	fetchSpy?.mockRestore();
	fetchSpy = null;
});

function stubFetch(
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
) {
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(mockFetch(impl));
	return fetchSpy;
}

describe("fetchAnthropicBankedResetStatus", () => {
	it("reads the cedar_ember block with the usage-endpoint headers", async () => {
		const spy = stubFetch(async () =>
			Response.json({
				five_hour: { utilization: 10 },
				cedar_ember: { eligible: false, ineligible_reason: "seat" },
			}),
		);
		const result = await fetchAnthropicBankedResetStatus("tok");
		expect(result.httpStatus).toBe(200);
		expect(result.retryAfterMs).toBeNull();
		expect(result.status?.ineligibleReason).toBe("seat");

		const [url, init] = spy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(ANTHROPIC_BANKED_RESET_STATUS_ENDPOINT);
		expect(url).toBe(
			"https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1",
		);
		expect(init.method).toBe("GET");
		const headers = new Headers(init.headers);
		expect(headers.get("Authorization")).toBe("Bearer tok");
		expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
		expect(headers.get("User-Agent")).toMatch(/^claude-code\//);
		expect(headers.get("Accept")).toBe("application/json");
		expect(headers.get("Content-Type")).toBe("application/json");
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("reports a successful read without the block as a null status", async () => {
		stubFetch(async () => Response.json({ five_hour: { utilization: 1 } }));
		expect(await fetchAnthropicBankedResetStatus("tok")).toEqual({
			status: null,
			httpStatus: 200,
			retryAfterMs: null,
		});
	});

	it("reports Retry-After on a 429", async () => {
		stubFetch(
			async () =>
				new Response("{}", { status: 429, headers: { "retry-after": "90" } }),
		);
		expect(await fetchAnthropicBankedResetStatus("tok")).toEqual({
			status: null,
			httpStatus: 429,
			retryAfterMs: 90_000,
		});
	});

	it("reports a null Retry-After when it is malformed", async () => {
		stubFetch(
			async () =>
				new Response("{}", {
					status: 429,
					headers: { "retry-after": "later" },
				}),
		);
		const result = await fetchAnthropicBankedResetStatus("tok");
		expect(result.httpStatus).toBe(429);
		expect(result.retryAfterMs).toBeNull();
	});

	it("never throws: network errors and bad bodies read as failures", async () => {
		stubFetch(async () => {
			throw new Error("ECONNRESET");
		});
		expect(await fetchAnthropicBankedResetStatus("tok")).toEqual({
			status: null,
			httpStatus: null,
			retryAfterMs: null,
		});

		stubFetch(async () => new Response("not json", { status: 200 }));
		expect((await fetchAnthropicBankedResetStatus("tok")).status).toBeNull();

		stubFetch(async () => new Response("nope", { status: 401 }));
		expect((await fetchAnthropicBankedResetStatus("tok")).httpStatus).toBe(401);
	});
});

describe("claimAnthropicBankedReset", () => {
	const REQUEST = { grantId: "g_week_1", requestId: "req_ABC-123" };

	it("POSTs the claim to the organization's reset endpoint", async () => {
		const spy = stubFetch(async () =>
			Response.json({
				result: "reset",
				resets_left: 0,
				cleared: ["seven_day", "future_window"],
				weekly_resets_at: "2026-09-29T10:00:00Z",
			}),
		);
		const result = await claimAnthropicBankedReset("tok", ORG, REQUEST);
		expect(result).toEqual({
			result: "reset",
			reason: null,
			resetsLeft: 0,
			cleared: ["seven_day"],
			weeklyResetsAt: Date.parse("2026-09-29T10:00:00Z"),
			cooldownUntil: null,
			httpStatus: 200,
			retryAfterMs: null,
			errorMessage: null,
		});

		const [url, init] = spy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(
			`https://api.anthropic.com/api/organizations/${ORG}/reset_rate_limits`,
		);
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body as string)).toEqual({
			program: "cedar_ember",
			grant_id: "g_week_1",
			request_id: "req_ABC-123",
		});
		const headers = new Headers(init.headers);
		expect(headers.get("Authorization")).toBe("Bearer tok");
		expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
		expect(headers.get("Content-Type")).toBe("application/json");
	});

	it("makes no request for an invalid grant id, request id or org uuid", async () => {
		const spy = stubFetch(async () => Response.json({ result: "reset" }));
		const cases: Array<[string, { grantId: string; requestId: string }]> = [
			[ORG, { grantId: "Upper", requestId: "r1" }],
			[ORG, { grantId: "x".repeat(41), requestId: "r1" }],
			[ORG, { grantId: "g1", requestId: "" }],
			[ORG, { grantId: "g1", requestId: "has space" }],
			[ORG, { grantId: "g1", requestId: "r".repeat(65) }],
			["../admin", { grantId: "g1", requestId: "r1" }],
			["org/uuid", { grantId: "g1", requestId: "r1" }],
			["", { grantId: "g1", requestId: "r1" }],
		];
		for (const [org, request] of cases) {
			const result = await claimAnthropicBankedReset("tok", org, request);
			expect(result.result).toBe("error");
			expect(result.httpStatus).toBeNull();
			expect(result.errorMessage).not.toBeNull();
		}
		expect(spy).not.toHaveBeenCalled();
	});

	it("maps a 429 to rate_limited with its Retry-After", async () => {
		stubFetch(
			async () =>
				new Response("{}", {
					status: 429,
					headers: { "retry-after": "Tue, 22 Sep 2099 12:00:00 GMT" },
				}),
		);
		const result = await claimAnthropicBankedReset("tok", ORG, REQUEST);
		expect(result.result).toBe("rate_limited");
		expect(result.httpStatus).toBe(429);
		expect(result.retryAfterMs).toBeGreaterThan(0);
	});

	it("maps 401 and 403 to auth_error and other statuses to error", async () => {
		for (const [status, expected] of [
			[401, "auth_error"],
			[403, "auth_error"],
			[404, "error"],
			[500, "error"],
		] as const) {
			stubFetch(async () => Response.json({ result: "reset" }, { status }));
			const result = await claimAnthropicBankedReset("tok", ORG, REQUEST);
			expect(result.result).toBe(expected);
			expect(result.httpStatus).toBe(status);
		}
	});

	it("maps a network failure or unparseable 2xx to error without throwing", async () => {
		stubFetch(async () => {
			throw new Error("socket hang up");
		});
		const failed = await claimAnthropicBankedReset("tok", ORG, REQUEST);
		expect(failed.result).toBe("error");
		expect(failed.httpStatus).toBeNull();
		expect(failed.errorMessage).toContain("socket hang up");

		stubFetch(async () => new Response("<html>", { status: 200 }));
		const garbled = await claimAnthropicBankedReset("tok", ORG, REQUEST);
		expect(garbled.result).toBe("error");
		expect(garbled.httpStatus).toBe(200);
	});
});

describe("parseAnthropicBankedResetClaimResponse", () => {
	it("falls back to unavailable for an unknown or missing result", () => {
		expect(
			parseAnthropicBankedResetClaimResponse({ result: "mystery" }),
		).toEqual({
			result: "unavailable",
			reason: null,
			resetsLeft: null,
			cleared: [],
			weeklyResetsAt: null,
			cooldownUntil: null,
		});
		expect(parseAnthropicBankedResetClaimResponse({}).result).toBe(
			"unavailable",
		);
	});

	it("reads known reasons and maps unknown ones to unknown", () => {
		expect(
			parseAnthropicBankedResetClaimResponse({
				result: "cooldown",
				reason: "cooldown",
				cooldown_until: "2026-09-22T13:00:00Z",
			}),
		).toMatchObject({
			result: "cooldown",
			reason: "cooldown",
			cooldownUntil: Date.parse("2026-09-22T13:00:00Z"),
		});
		expect(
			parseAnthropicBankedResetClaimResponse({
				result: "ineligible",
				reason: "not_next_grant",
			}).reason,
		).toBe("not_next_grant");
		expect(
			parseAnthropicBankedResetClaimResponse({
				result: "ineligible",
				reason: "brand_new",
			}).reason,
		).toBe("unknown");
	});

	it("drops a negative or fractional resets_left", () => {
		for (const resets_left of [-1, 0.5, "1"]) {
			expect(
				parseAnthropicBankedResetClaimResponse({ result: "reset", resets_left })
					.resetsLeft,
			).toBeNull();
		}
	});
});

describe("anthropicBankedResetCache", () => {
	const NOW = Date.parse("2026-09-22T12:00:00Z");
	const ID = "acct-cache";

	function status(
		overrides: Partial<AnthropicBankedResetStatus> = {},
	): AnthropicBankedResetStatus {
		return {
			eligible: true,
			ineligibleReason: null,
			atLimit: false,
			exhausted: [],
			grants: [],
			nextGrantId: null,
			weeklyResetsAt: null,
			cooldownUntil: null,
			...overrides,
		};
	}

	afterEach(() => {
		anthropicBankedResetCache.clear();
	});

	it("needs a read when nothing was ever attempted", () => {
		expect(anthropicBankedResetCache.needsRefresh(ID, NOW)).toBe(true);
		expect(anthropicBankedResetCache.get(ID)).toBeNull();
	});

	it("holds a stored status for 15 minutes", () => {
		anthropicBankedResetCache.set(ID, status(), NOW);
		expect(anthropicBankedResetCache.get(ID)).toEqual({
			status: status(),
			fetchedAt: NOW,
		});
		expect(
			anthropicBankedResetCache.needsRefresh(
				ID,
				NOW + ANTHROPIC_BANKED_RESET_REFRESH_MS - 1,
			),
		).toBe(false);
		expect(
			anthropicBankedResetCache.needsRefresh(
				ID,
				NOW + ANTHROPIC_BANKED_RESET_REFRESH_MS,
			),
		).toBe(true);
		expect(ANTHROPIC_BANKED_RESET_REFRESH_MS).toBe(15 * 60_000);
	});

	it("retries a failed read after 5 minutes, with or without a stored status", () => {
		anthropicBankedResetCache.markAttempt(ID, NOW);
		expect(
			anthropicBankedResetCache.needsRefresh(
				ID,
				NOW + ANTHROPIC_BANKED_RESET_RETRY_MS - 1,
			),
		).toBe(false);
		expect(
			anthropicBankedResetCache.needsRefresh(
				ID,
				NOW + ANTHROPIC_BANKED_RESET_RETRY_MS,
			),
		).toBe(true);
		expect(ANTHROPIC_BANKED_RESET_RETRY_MS).toBe(5 * 60_000);

		// A stored status past its TTL whose re-read just failed waits out the
		// retry interval instead of re-reading on every call.
		anthropicBankedResetCache.set(ID, status(), NOW);
		const failedAt = NOW + ANTHROPIC_BANKED_RESET_REFRESH_MS;
		anthropicBankedResetCache.markAttempt(ID, failedAt);
		expect(anthropicBankedResetCache.needsRefresh(ID, failedAt + 1)).toBe(
			false,
		);
		expect(
			anthropicBankedResetCache.needsRefresh(
				ID,
				failedAt + ANTHROPIC_BANKED_RESET_RETRY_MS,
			),
		).toBe(true);
	});

	it("re-reads once a grant's ends_at passes", () => {
		const endsAt = NOW + 60_000;
		anthropicBankedResetCache.set(
			ID,
			status({
				grants: [
					{
						id: "g1",
						label: null,
						resetsTotal: 1,
						resetsLeft: 1,
						startsAt: null,
						endsAt,
						clears: ["seven_day"],
						paused: false,
						usableNow: true,
						useRequiresLimit: true,
						percentUsed: {},
						blocking: [],
					},
				],
				nextGrantId: "g1",
			}),
			NOW,
		);
		expect(anthropicBankedResetCache.needsRefresh(ID, endsAt - 1)).toBe(false);
		expect(anthropicBankedResetCache.needsRefresh(ID, endsAt)).toBe(true);
	});

	it("re-reads once cooldown_until passes", () => {
		const cooldownUntil = NOW + 120_000;
		anthropicBankedResetCache.set(ID, status({ cooldownUntil }), NOW);
		expect(anthropicBankedResetCache.needsRefresh(ID, cooldownUntil - 1)).toBe(
			false,
		);
		expect(anthropicBankedResetCache.needsRefresh(ID, cooldownUntil)).toBe(
			true,
		);
	});

	it("ignores instants that had already passed when the status was read", () => {
		anthropicBankedResetCache.set(
			ID,
			status({ cooldownUntil: NOW - 1_000 }),
			NOW,
		);
		expect(anthropicBankedResetCache.needsRefresh(ID, NOW + 1_000)).toBe(false);
	});

	it("holds an ineligible status with a stable reason for 6 hours", () => {
		for (const reason of [
			"tier",
			"seat",
			"surface",
			"tenure",
			"config_off",
			"no_grant",
		] as const) {
			anthropicBankedResetCache.set(
				ID,
				status({ eligible: false, ineligibleReason: reason }),
				NOW,
			);
			expect(
				anthropicBankedResetCache.needsRefresh(
					ID,
					NOW + ANTHROPIC_BANKED_RESET_REFRESH_MS,
				),
			).toBe(false);
			expect(
				anthropicBankedResetCache.needsRefresh(
					ID,
					NOW + ANTHROPIC_BANKED_RESET_INELIGIBLE_REFRESH_MS,
				),
			).toBe(true);
		}
		expect(ANTHROPIC_BANKED_RESET_INELIGIBLE_REFRESH_MS).toBe(6 * 60 * 60_000);
	});

	it("keeps the 15-minute TTL for other ineligible reasons", () => {
		for (const reason of ["cli_version", "unavailable", "unknown"] as const) {
			anthropicBankedResetCache.set(
				ID,
				status({ eligible: false, ineligibleReason: reason }),
				NOW,
			);
			expect(
				anthropicBankedResetCache.needsRefresh(
					ID,
					NOW + ANTHROPIC_BANKED_RESET_REFRESH_MS,
				),
			).toBe(true);
		}
	});

	it("forgets an account on delete", () => {
		anthropicBankedResetCache.set(ID, status(), NOW);
		anthropicBankedResetCache.delete(ID);
		expect(anthropicBankedResetCache.get(ID)).toBeNull();
		expect(anthropicBankedResetCache.needsRefresh(ID, NOW)).toBe(true);
	});
});
