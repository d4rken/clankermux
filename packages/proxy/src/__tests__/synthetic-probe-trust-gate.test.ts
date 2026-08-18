/**
 * Trust gate on the synthetic-probe exemptions in proxyWithAccount.
 *
 * `x-clankermux-keepalive` and `x-clankermux-auto-refresh` are ordinary request
 * headers — anything that can reach the proxy can set them. Each exemption they
 * unlock is a real privilege (skip the 429 cooldown, skip the out_of_credits
 * floor, skip the stale-token 401 retry, skip cache staging, …), so every one of
 * them is now gated on `requestMeta.internal`: handleProxy's own `isInternal`
 * parameter, which is sourced only from `dispatchProxyRequest` and never from a
 * header.
 *
 * Each site is tested in BOTH arms — trusted probe grants the privilege, the
 * same forged marker on external traffic does not — plus a cross-kind arm,
 * because several exemptions are keepalive-ONLY (the keepalive scheduler fans
 * out in parallel and trips Anthropic's per-IP burst limit; an auto-refresh
 * probe does not) and must not widen to the other marker.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { ServiceUnavailableError, TIME_CONSTANTS } from "@clankermux/core";
import { getProvider, usageCache } from "@clankermux/providers";
import type { Account } from "@clankermux/types";
import { cacheBodyStore } from "../cache-body-store";
import type { ProxyContext } from "../handlers";
import {
	clearAnthropicBurstThrottle,
	isAnthropicBurstThrottleActive,
} from "../handlers/burst-cooldown";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "anthropic",
		// An API-key account keeps the OAuth-only transparent burst-retry rung
		// (classify429Transient step 1) out of the way, so a 429 lands on the
		// no-fallback cooldown path under test.
		api_key: "sk-ant-test",
		refresh_token: "",
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		consecutive_rate_limits: 0,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		codex_auto_apply_reset_credits_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	};
}

/** An OAuth account whose token looks valid, so only the reactive-401 path refreshes it. */
function makeOAuthAccount(overrides: Partial<Account> = {}): Account {
	return makeAccount({
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-old",
		access_token: "stale-token",
		expires_at: Date.now() + 8 * 60 * 60 * 1000,
		...overrides,
	});
}

function makeContext(accounts: Account[]): ProxyContext {
	return {
		strategy: {
			select: mock((allAccounts: Account[]) => allAccounts),
		},
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getAccount: mock(async (id: string) => accounts.find((a) => a.id === id)),
			getActiveComboForFamily: mock(async () => null),
			updateAccountUsage: mock(async () => undefined),
			updateAccountRateLimitMeta: mock(async () => undefined),
			updateAccountTokens: mock(async () => true),
			updateRequestUsage: mock(async () => undefined),
			resetAccountSession: mock(async () => undefined),
			markAccountRateLimited: mock(async () => 1),
			markAccountRateLimitedDeadlineOnly: mock(async () => {}),
			pauseAccount: mock(async () => undefined),
			saveRequest: mock(async () => undefined),
			getAdapter: mock(() => ({
				run: mock(async () => undefined),
				get: mock(async () => null),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test-client" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getCacheWarmingEnabled: () => false,
			getCacheWarmingMinTokens: () => 100_000,
			getStorePayloads: () => false,
		} as never,
		provider: getProvider("anthropic") as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => undefined) } as never,
		requestRecorder: {
			begin: mock(() => undefined),
			hasRecord: mock(() => false),
			captureResponseChunk: mock(() => undefined),
			finishTransport: mock(() => undefined),
			attachUsageSummary: mock(() => undefined),
			markUsageUnavailable: mock(() => undefined),
			recordSynthetic: mock(() => undefined),
			sweep: mock(() => undefined),
			dispose: mock(() => undefined),
		} as never,
	};
}

/** One directly-written audit row (`dbOps.saveRequest`). */
type AuditRow = {
	accountId: string;
	status: number;
	reason: string | null;
};

/**
 * A context whose async writer actually RUNS the enqueued job, so the direct
 * audit rows the 429 short-circuits write are observable. The default mock
 * swallows them.
 */
function makeAuditContext(accounts: Account[]): {
	ctx: ProxyContext;
	audits: AuditRow[];
} {
	const audits: AuditRow[] = [];
	const ctx = makeContext(accounts);
	(ctx.dbOps as unknown as Record<string, unknown>).saveRequest = mock(
		async (data: Record<string, unknown>) => {
			audits.push({
				accountId: data.accountUsed as string,
				status: data.statusCode as number,
				reason: (data.errorMessage ?? null) as string | null,
			});
		},
	);
	(ctx as { asyncWriter: unknown }).asyncWriter = {
		enqueue: mock(async (job: () => void | Promise<void>) => {
			await job();
		}),
	};
	return { ctx, audits };
}

function makeRequest(headers: Record<string, string> = {}): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
	});
}

/** Drive handleProxy; an exhausted single-account pool throws — treat that as "failed over". */
async function runProxy(
	ctx: ProxyContext,
	req: Request,
	isInternal: boolean,
): Promise<Response | null> {
	const { handleProxy } = await import("../proxy");
	try {
		return await handleProxy(
			req,
			new URL("https://proxy.local/v1/messages"),
			ctx,
			null,
			null,
			isInternal,
		);
	} catch (err) {
		if (err instanceof ServiceUnavailableError) return null;
		throw err;
	}
}

const KEEPALIVE = { "x-clankermux-keepalive": "true" };
const AUTO_REFRESH = { "x-clankermux-auto-refresh": "true" };

/** Mocked upstream: pricing catalogue + OAuth refresh + /v1/messages. */
function installFetch(
	messageResponder: () => Response,
	onOAuthRefresh?: () => void,
): void {
	globalThis.fetch = mock(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request =
				input instanceof Request ? input : new Request(String(input), init);
			if (request.url.includes("models.dev")) {
				return new Response("{}", {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (request.url.includes("oauth/token")) {
				onOAuthRefresh?.();
				return new Response(
					JSON.stringify({
						access_token: "fresh-token",
						expires_in: 3600,
						refresh_token: "refresh-new",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return messageResponder();
		},
	) as never;
}

const RATE_LIMIT_BODY =
	'{"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}}';
const AUTH_ERROR_BODY =
	'{"type":"error","error":{"type":"authentication_error","message":"invalid bearer token"}}';

describe("synthetic-probe trust gate", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	// -----------------------------------------------------------------------
	// Site: cache staging skip (proxy-operations, kind "any")
	// -----------------------------------------------------------------------

	describe("cache staging skip", () => {
		async function stagedFor(
			headers: Record<string, string>,
			isInternal: boolean,
		): Promise<boolean> {
			const stage = spyOn(cacheBodyStore, "stageRequest").mockImplementation(
				() => undefined,
			);
			try {
				installFetch(
					() =>
						new Response('{"type":"message","content":[]}', {
							status: 200,
							headers: { "content-type": "application/json" },
						}),
				);
				const account = makeAccount({ id: `stage-${Math.random()}` });
				await runProxy(
					makeContext([account]),
					makeRequest(headers),
					isInternal,
				);
				return stage.mock.calls.length > 0;
			} finally {
				stage.mockRestore();
			}
		}

		it("a TRUSTED keepalive replay skips cache staging", async () => {
			expect(await stagedFor(KEEPALIVE, true)).toBe(false);
		});

		it("SPOOF GUARD: an external request with a forged keepalive header still stages", async () => {
			expect(await stagedFor(KEEPALIVE, false)).toBe(true);
		});

		it("a TRUSTED auto-refresh probe also skips (this site accepts either marker)", async () => {
			expect(await stagedFor(AUTO_REFRESH, true)).toBe(false);
		});

		it("normal traffic stages", async () => {
			expect(await stagedFor({}, false)).toBe(true);
		});
	});

	// -----------------------------------------------------------------------
	// Site: out_of_credits long cooldown skip (proxy-operations, kind "any")
	// -----------------------------------------------------------------------

	describe("out_of_credits floor skip", () => {
		async function cooldownFor(
			headers: Record<string, string>,
			isInternal: boolean,
		): Promise<{ until: number | null; now: number }> {
			installFetch(
				() =>
					new Response(RATE_LIMIT_BODY, {
						status: 429,
						headers: {
							"content-type": "application/json",
							"anthropic-ratelimit-unified-overage-disabled-reason":
								"out_of_credits",
						},
					}),
			);
			const account = makeAccount({ id: `credits-${Math.random()}` });
			const now = Date.now();
			await runProxy(makeContext([account]), makeRequest(headers), isInternal);
			return { until: account.rate_limited_until, now };
		}

		it("a TRUSTED auto-refresh probe does NOT get the multi-hour out-of-credits floor", async () => {
			const { until, now } = await cooldownFor(AUTO_REFRESH, true);
			// It may still take an ordinary 429 cooldown further down the ladder —
			// what must not happen is the long out_of_credits floor.
			expect(
				until === null ||
					until < now + TIME_CONSTANTS.OUT_OF_CREDITS_COOLDOWN_MS,
			).toBe(true);
		});

		it("SPOOF GUARD: an external request with a forged marker DOES take the out-of-credits floor", async () => {
			const { until, now } = await cooldownFor(AUTO_REFRESH, false);
			expect(until).not.toBeNull();
			expect(until as number).toBeGreaterThanOrEqual(
				now + TIME_CONSTANTS.OUT_OF_CREDITS_COOLDOWN_MS,
			);
		});
	});

	// -----------------------------------------------------------------------
	// Site: 429 cooldown skip on the no-model-fallback path
	// (proxy-operations, kind "keepalive" — NOT "any")
	// -----------------------------------------------------------------------

	describe("429 cooldown skip (keepalive-only)", () => {
		async function cooldownAppliedFor(
			headers: Record<string, string>,
			isInternal: boolean,
		): Promise<boolean> {
			installFetch(
				() =>
					new Response(RATE_LIMIT_BODY, {
						status: 429,
						headers: { "content-type": "application/json" },
					}),
			);
			const account = makeAccount({ id: `cooldown-${Math.random()}` });
			await runProxy(makeContext([account]), makeRequest(headers), isInternal);
			return account.rate_limited_until !== null;
		}

		it("a TRUSTED keepalive replay skips the 429 cooldown", async () => {
			expect(await cooldownAppliedFor(KEEPALIVE, true)).toBe(false);
		});

		it("SPOOF GUARD: an external request with a forged keepalive header IS cooled down", async () => {
			expect(await cooldownAppliedFor(KEEPALIVE, false)).toBe(true);
		});

		it("CROSS-KIND GUARD: a TRUSTED auto-refresh probe does NOT inherit the keepalive-only skip", async () => {
			expect(await cooldownAppliedFor(AUTO_REFRESH, true)).toBe(true);
		});

		it("normal traffic is cooled down", async () => {
			expect(await cooldownAppliedFor({}, false)).toBe(true);
		});
	});

	// -----------------------------------------------------------------------
	// Site: stale-token 401 refresh+retry skip (proxy-operations, kind "any")
	// -----------------------------------------------------------------------

	describe("stale-token 401 retry skip", () => {
		async function refreshedFor(
			headers: Record<string, string>,
			isInternal: boolean,
			accountId: string,
		): Promise<boolean> {
			let refreshes = 0;
			installFetch(
				() =>
					new Response(AUTH_ERROR_BODY, {
						status: 401,
						headers: { "content-type": "application/json" },
					}),
				() => {
					refreshes += 1;
				},
			);
			const account = makeOAuthAccount({ id: accountId });
			await runProxy(makeContext([account]), makeRequest(headers), isInternal);
			return refreshes > 0;
		}

		it("a TRUSTED auto-refresh probe skips the reactive refresh+retry", async () => {
			// The reactive-refresh cooldown is keyed by account id in a module-level
			// map, so each arm uses a distinct id.
			expect(await refreshedFor(AUTO_REFRESH, true, "stale-trusted")).toBe(
				false,
			);
		});

		it("SPOOF GUARD: an external request with a forged marker DOES take the refresh+retry", async () => {
			expect(await refreshedFor(AUTO_REFRESH, false, "stale-spoofed")).toBe(
				true,
			);
		});
	});

	// -----------------------------------------------------------------------
	// Site: reactive family-weekly safety net (proxy-operations, kind "any")
	// -----------------------------------------------------------------------

	describe("family-weekly safety net skip", () => {
		/**
		 * Reaching the REACTIVE net requires the usage poll to lag: at selection
		 * time the family still has headroom (or the proactive gate would have
		 * excluded the account before any attempt), and by the time the 429 comes
		 * back the cache shows the family spent. The fetch stub seeds that update.
		 */
		async function familyNetFor(
			headers: Record<string, string>,
			isInternal: boolean,
			accountId: string,
		): Promise<{ audits: AuditRow[]; rateLimitedUntil: number | null }> {
			const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
			const usage = (scopedPercent: number) => ({
				// Unified headroom present, so the family gate is about the FAMILY.
				five_hour: { utilization: 0, resets_at: future },
				seven_day: { utilization: 83, resets_at: future },
				limits: [
					{
						kind: "weekly_scoped",
						group: "weekly",
						percent: scopedPercent,
						resets_at: future,
						scope: { model: { id: "sonnet", display_name: "Sonnet" } },
						is_active: true,
					},
				],
			});
			usageCache.set(accountId, usage(10) as never);
			installFetch(() => {
				// The lagging poll lands: the requested family is now spent.
				usageCache.set(accountId, usage(100) as never);
				return new Response(RATE_LIMIT_BODY, {
					status: 429,
					headers: { "content-type": "application/json" },
				});
			});
			const account = makeAccount({
				id: accountId,
				api_key: null,
				refresh_token: "rt",
				access_token: "at",
				expires_at: Date.now() + 8 * 60 * 60 * 1000,
			});
			const { ctx, audits } = makeAuditContext([account]);
			await runProxy(ctx, makeRequest(headers), isInternal);
			return { audits, rateLimitedUntil: account.rate_limited_until };
		}

		it("a TRUSTED probe skips the family-weekly net (no family audit row)", async () => {
			const { audits, rateLimitedUntil } = await familyNetFor(
				AUTO_REFRESH,
				true,
				"family-trusted",
			);
			expect(
				audits.some((a) => a.reason === "family_weekly_exhausted_429"),
			).toBe(false);
			// It fell through to the ordinary 429 handling instead.
			expect(rateLimitedUntil).not.toBeNull();
		});

		it("SPOOF GUARD: an external request with a forged marker still gets the family net", async () => {
			const { audits, rateLimitedUntil } = await familyNetFor(
				AUTO_REFRESH,
				false,
				"family-spoofed",
			);
			expect(
				audits.some((a) => a.reason === "family_weekly_exhausted_429"),
			).toBe(true);
			// Invariant 3: the family net never applies an account-wide cooldown.
			expect(rateLimitedUntil).toBeNull();
		});
	});

	// -----------------------------------------------------------------------
	// Site: transparent burst-retry classification (proxy-operations, kind "any")
	// -----------------------------------------------------------------------

	describe("burst-retry classification skip", () => {
		/**
		 * `retryable_429` is not directly observable from handleProxy, but the
		 * classification sets the shared Anthropic burst marker SYNCHRONOUSLY at
		 * the moment it fires — and nothing else in this scenario does.
		 */
		async function burstMarkedFor(
			headers: Record<string, string>,
			isInternal: boolean,
			accountId: string,
		): Promise<boolean> {
			clearAnthropicBurstThrottle();
			const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
			// OAuth-Anthropic account + FRESH positive headroom ⇒ classify429Transient
			// step 3 (`fresh_headroom`), the real burst signal.
			usageCache.set(accountId, {
				five_hour: { utilization: 40, resets_at: future },
				seven_day: { utilization: 20, resets_at: future },
			} as never);
			installFetch(
				() =>
					new Response(RATE_LIMIT_BODY, {
						status: 429,
						headers: {
							"content-type": "application/json",
							"x-should-retry": "true",
						},
					}),
			);
			const account = makeOAuthAccount({ id: accountId });
			await runProxy(makeContext([account]), makeRequest(headers), isInternal);
			return isAnthropicBurstThrottleActive();
		}

		it("a TRUSTED probe is NOT classified as a retryable burst 429", async () => {
			expect(await burstMarkedFor(AUTO_REFRESH, true, "burst-trusted")).toBe(
				false,
			);
		});

		it("SPOOF GUARD: an external request with a forged marker IS classified", async () => {
			expect(await burstMarkedFor(AUTO_REFRESH, false, "burst-spoofed")).toBe(
				true,
			);
		});

		it("normal traffic is classified", async () => {
			expect(await burstMarkedFor({}, false, "burst-normal")).toBe(true);
		});
	});

	// -----------------------------------------------------------------------
	// Site: 429 cooldown skip AFTER the model-fallback list is exhausted
	// (proxy-operations, kind "keepalive" — NOT "any")
	// -----------------------------------------------------------------------

	describe("429 cooldown skip, post-model-list (keepalive-only)", () => {
		async function cooldownAppliedFor(
			headers: Record<string, string>,
			isInternal: boolean,
		): Promise<{ cooled: boolean; audits: AuditRow[] }> {
			installFetch(
				() =>
					new Response(RATE_LIMIT_BODY, {
						status: 429,
						headers: { "content-type": "application/json" },
					}),
			);
			const account = makeAccount({
				id: `fallbacks-${Math.random()}`,
				// TWO models for the requested family: the attempt cycles the list and
				// exhausts it, landing on the all_models_exhausted_429 path.
				model_mappings: JSON.stringify({
					sonnet: ["claude-sonnet-4-5", "claude-haiku-4-5"],
				}),
			});
			const { ctx, audits } = makeAuditContext([account]);
			await runProxy(ctx, makeRequest(headers), isInternal);
			return { cooled: account.rate_limited_until !== null, audits };
		}

		it("a TRUSTED keepalive replay skips the post-model-list cooldown", async () => {
			const { cooled, audits } = await cooldownAppliedFor(KEEPALIVE, true);
			expect(cooled).toBe(false);
			expect(audits.some((a) => a.reason === "all_models_exhausted_429")).toBe(
				false,
			);
		});

		it("SPOOF GUARD: an external request with a forged keepalive header IS cooled down", async () => {
			const { cooled, audits } = await cooldownAppliedFor(KEEPALIVE, false);
			expect(cooled).toBe(true);
			expect(audits.some((a) => a.reason === "all_models_exhausted_429")).toBe(
				true,
			);
		});

		it("CROSS-KIND GUARD: a TRUSTED auto-refresh probe does NOT inherit the keepalive-only skip", async () => {
			const { cooled } = await cooldownAppliedFor(AUTO_REFRESH, true);
			expect(cooled).toBe(true);
		});

		it("normal traffic is cooled down", async () => {
			const { cooled } = await cooldownAppliedFor({}, false);
			expect(cooled).toBe(true);
		});
	});
});
