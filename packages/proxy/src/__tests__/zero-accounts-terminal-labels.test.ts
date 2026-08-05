/**
 * Boundary tests pinning the RECORDER LABELS written by `handleProxy`'s
 * zero-accounts terminal block — the `error` string every synthetic terminal
 * hands to `requestRecorder.recordSynthetic`, which is what Request History and
 * the dashboard failure attribution read.
 *
 * Every case drives the labels through `handleProxy` itself (never through a
 * terminal helper directly), so they survive a refactor that moves the block out
 * of the function. Two shapes are pinned:
 *
 *   - the LABEL of each recording terminal — including the two pin terminals,
 *     which differ in kind: the EARLY one records `requestMeta.pinFailure.code`
 *     VERBATIM (so a selection-failure code reaches history unchanged), the
 *     LATER one records the fixed `pinned_target_unavailable`;
 *   - the NO-RECORD contract of the terminals that deliberately write nothing
 *     (usage-throttled, context-window size 400).
 *
 * The `pinned_account_unavailable` case additionally runs the pin-transient hold
 * to a give-up, which exercises the save/restore triangle around
 * `requestMeta.pinFailure`: the hold's re-selection clears the strict-fail
 * marker, and without the restore the request would fall through to the LATER
 * pinned terminal and record `pinned_target_unavailable` instead.
 */

import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	mock,
} from "bun:test";
import { usageCache } from "@clankermux/providers";
import type { Account, RequestMeta } from "@clankermux/types";
import { cacheBodyStore } from "../cache-body-store";
import type { ProxyContext } from "../handlers";
import { setForcedAccount } from "../handlers";
import {
	clearAnthropicBurstThrottle,
	markAnthropicBurstThrottle,
	resetHoldSlots,
} from "../handlers/burst-cooldown";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import { resetOverloadHoldSlots } from "../overload-hold";
import { clearProviderOverloadCooldown } from "../provider-overload-cooldown";
import { sessionProjectCache } from "../session-project-cache";
import { sessionPromotionTracker } from "../session-promotion";

/** Unique per test so no singleton state (usage cache, buckets) leaks between cases. */
let idCounter = 0;
function uniqueId(prefix: string): string {
	idCounter++;
	return `${prefix}-${idCounter}`;
}

/** Every usageCache id seeded by a test, cleared in both hooks. */
const seededUsageIds = new Set<string>();

/**
 * Deterministic burst-hold timing, injected through handleProxy's
 * `burstHoldTimingOverride` seam (forwarded verbatim to
 * holdAndRetryCacheAccount). The forward-dated clock makes the held account's
 * cooldown read as already elapsed, so each re-probe fires with no wall-clock
 * sleep; jitter is zeroed and the total budget capped.
 */
const HOLD_TIMING_OVERRIDE = {
	now: () => Date.now() + 10 * 60 * 1000,
	jitterMs: 0,
	maxHoldMs: 2_000,
};

async function callHandleProxy(
	req: Request,
	url: URL,
	ctx: ProxyContext,
	apiKeyId: string | null = null,
) {
	const { handleProxy } = await import("../proxy");
	return handleProxy(
		req,
		url,
		ctx,
		apiKeyId,
		apiKeyId ? "test-key" : null,
		false,
		HOLD_TIMING_OVERRIDE,
	);
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt-token",
		access_token: "at-token",
		expires_at: Date.now() + 3_600_000,
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
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	} as Account;
}

/** Pin config returned by `getApiKeyPin`. */
type PinCfg = {
	pinnedAccountId: string | null;
	pinnedProviders: string[] | null;
};

interface ContextOptions {
	/** `ctx.provider.name` — also the provider the pool-exhausted body filters on. */
	providerName?: string;
	/** Per-key routing pin returned by `getApiKeyPin` (needs an apiKeyId too). */
	pin?: PinCfg | null;
	/** Enables both usage-throttle windows. */
	usageThrottling?: boolean;
	/**
	 * When set, the strategy records `affinity_hold` + this `heldAccountId` — the
	 * cooled cache-affinity shape the storm-degrade burst hold targets.
	 */
	heldAccountId?: string;
}

/** Availability filter shared by both strategy stubs (mirrors the real one). */
function availableOnly(accs: Account[]): Account[] {
	const now = Date.now();
	return accs.filter(
		(acc) =>
			!acc.paused && (!acc.rate_limited_until || acc.rate_limited_until <= now),
	);
}

function makeContext(
	accounts: Account[],
	opts: ContextOptions = {},
): { ctx: ProxyContext; recordedErrors: string[] } {
	const {
		providerName = "anthropic",
		pin = null,
		usageThrottling = false,
		heldAccountId,
	} = opts;
	const byId = new Map(accounts.map((a) => [a.id, a]));
	const recordedErrors: string[] = [];
	const strategy = heldAccountId
		? {
				select: (accs: Account[], meta: RequestMeta) => {
					const available = availableOnly(accs);
					meta.routing = {
						strategy: "session",
						decision: "affinity_hold",
						affinityScope: "project",
						affinityKey: "k",
						selectedAccountId: available[0]?.id ?? null,
						previousAccountId: null,
						candidatesCount: available.length,
						failoverReason: null,
						heldAccountId,
					};
					return available;
				},
			}
		: { select: (accs: Account[]) => availableOnly(accs) };

	const ctx: ProxyContext = {
		strategy: strategy as never,
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getAccount: mock(async (id: string) => byId.get(id) ?? null),
			getActiveComboForFamily: mock(async () => null),
			getApiKeyPin: mock(async () =>
				pin ? { malformed: false, ...pin } : null,
			),
			markAccountRateLimited: mock(async () => 1),
			markAccountRateLimitedDeadlineOnly: mock(async () => {}),
			saveRequest: mock(async () => {}),
			updateAccountUsage: mock(async () => {}),
			updateAccountRateLimitMeta: mock(async () => {}),
			resetConsecutiveRateLimits: mock(async () => {}),
			updateRequestUsage: mock(async () => {}),
			getAdapter: mock(() => ({
				run: mock(async () => {}),
				get: mock(async () => null),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => usageThrottling,
			getUsageThrottlingWeeklyEnabled: () => usageThrottling,
			getCacheWarmingEnabled: () => false,
			getCacheWarmingMinTokens: () => 100_000,
			getStorePayloads: () => false,
		} as never,
		provider: {
			name: providerName,
			canHandle: () => true,
			buildUrl: () => "https://api.anthropic.com/v1/messages",
			prepareHeaders: () => new Headers(),
			transformRequestBody: null,
			processResponse: async (r: Response) => r,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: undefined,
				remaining: undefined,
			}),
			isStreamingResponse: () => false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: {
			enqueue: mock(async (job: () => void | Promise<void>) => {
				await job();
			}),
		} as never,
		requestRecorder: {
			begin: mock(() => {}),
			captureResponseChunk: mock(() => {}),
			finishTransport: mock(() => {}),
			attachUsageSummary: mock(() => {}),
			markUsageUnavailable: mock(() => {}),
			recordSynthetic: mock((_meta: unknown, _kind: string, error: string) => {
				recordedErrors.push(error);
			}),
			sweep: mock(() => {}),
			dispose: mock(() => {}),
		} as never,
		server: { timeout: mock(() => {}) } as never,
	};
	return { ctx, recordedErrors };
}

function makeRequest(
	model: string,
	headers: Record<string, string> = {},
): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
	});
}

/**
 * A request whose estimate (JSON length / 3.0 + max_tokens) lands above
 * `targetEstimate`, for the context-window gate.
 */
function makeLargeRequest(model: string, targetEstimate: number): Request {
	const overhead = JSON.stringify({
		model,
		messages: [{ role: "user", content: "" }],
		max_tokens: 16,
	}).length;
	const neededChars = Math.ceil((targetEstimate - 16) * 3.0) - overhead + 10;
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			messages: [
				{ role: "user", content: "x".repeat(Math.max(0, neededChars)) },
			],
			max_tokens: 16,
		}),
	});
}

function rl429(headers: Record<string, string> = {}) {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "rate_limit_error", message: "Too many requests" },
		}),
		{
			status: 429,
			headers: { "content-type": "application/json", ...headers },
		},
	);
}

/**
 * Shunt every non-upstream fetch (the models.dev pricing-catalog refresh fired
 * by the usage finalizer) to a 500 so call counts stay order-independent — same
 * rationale as `upstreamOnlyFetch` in burst-bookkeeping-boundary.
 */
function upstreamOnlyFetch(
	onUpstream: () => Response,
): typeof globalThis.fetch {
	return mock(async (input: Request | string | URL) => {
		const url = input instanceof Request ? input.url : String(input);
		if (!url.includes("api.anthropic.com")) {
			return new Response("unavailable", { status: 500 });
		}
		return onUpstream();
	}) as never;
}

/** Fresh, positive 5h/7d headroom (the burst hold's `fresh_headroom` entry). */
function seedFreshHeadroom(accountId: string): void {
	seededUsageIds.add(accountId);
	usageCache.set(accountId, {
		five_hour: {
			utilization: 40,
			resets_at: new Date(Date.now() + 3_600_000).toISOString(),
		},
		seven_day: {
			utilization: 20,
			resets_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
		},
	} as never);
}

/**
 * Usage well ahead of the window's expected pace (90% used one hour into a 5h
 * window), so the usage-throttle gate parks the account.
 */
function seedThrottled(accountId: string): void {
	seededUsageIds.add(accountId);
	usageCache.set(accountId, {
		five_hour: {
			utilization: 90,
			resets_at: new Date(Date.now() + 4 * 3_600_000).toISOString(),
		},
		seven_day: {
			utilization: 5,
			resets_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
		},
	} as never);
}

/**
 * Unified 5h/7d headroom plus an optional EXHAUSTED Fable weekly-scoped limit —
 * the family-weekly gate's input.
 */
function seedFamilyUsage(accountId: string, fableExhausted: boolean): void {
	seededUsageIds.add(accountId);
	usageCache.set(accountId, {
		five_hour: {
			utilization: 2,
			resets_at: new Date(Date.now() + 4 * 3_600_000).toISOString(),
		},
		seven_day: {
			utilization: fableExhausted ? 60 : 24,
			resets_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
		},
		limits: fableExhausted
			? [
					{
						kind: "weekly_scoped",
						group: "weekly",
						percent: 100,
						resets_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
						scope: { model: { id: "claude-fable-5", display_name: "Fable" } },
						is_active: true,
					},
				]
			: [],
	} as never);
}

function resetSingletons(): void {
	setForcedAccount(null);
	cacheBodyStore.setEnabled(false);
	sessionPromotionTracker.setMode("off");
	sessionPromotionTracker.clear();
	sessionProjectCache.clear();
	clearProviderOverloadCooldown();
	clearAnthropicBurstThrottle();
	resetHoldSlots();
	resetOverloadHoldSlots();
	resetRateLimitProbeGatesForTests();
	for (const id of seededUsageIds) usageCache.delete(id);
	seededUsageIds.clear();
}

describe("zero-accounts terminal recorder labels", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeAll(async () => {
		await import("../proxy");
	});

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		resetSingletons();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		resetSingletons();
	});

	it("burst give-up in the zero-accounts block records burst_retry_exhausted", async () => {
		// Storm shape: the cache-affinity account AND its only sibling are cooled, so
		// the strategy returns ZERO candidates while still recording heldAccountId +
		// affinity_hold. With the shared burst marker active the storm-degrade hold
		// runs, its re-probes keep 429ing, and the give-up terminal fires.
		const heldId = uniqueId("held");
		const siblingId = uniqueId("sibling");
		const held = makeAccount({
			id: heldId,
			name: "Cache",
			rate_limited_until: Date.now() + 60_000,
			access_token: "at-held",
		});
		const sibling = makeAccount({
			id: siblingId,
			name: "Sibling",
			rate_limited_until: Date.now() + 60_000,
			access_token: "at-sibling",
		});
		seedFreshHeadroom(heldId);
		markAnthropicBurstThrottle();
		globalThis.fetch = upstreamOnlyFetch(() =>
			rl429({ "x-should-retry": "true" }),
		);

		const { ctx, recordedErrors } = makeContext([held, sibling], {
			heldAccountId: heldId,
		});
		const res = await callHandleProxy(
			makeRequest("claude-sonnet-4-5"),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// The constructed give-up 429 (not the generic pool_exhausted 503) …
		expect(res.status).toBe(429);
		expect(res.headers.get("x-clankermux-burst-retry")).toBe("exhausted");
		// … recorded under exactly this label.
		expect(recordedErrors).toEqual(["burst_retry_exhausted"]);
	});

	it("early pin terminal records the pinned_no_available_account code VERBATIM", async () => {
		// Class pin whose only allowed account is on a long wall (400s ≫ the 120s pin
		// budget): no hold candidate, so the early terminal fires directly with the
		// selection's own strict-fail code.
		const accId = uniqueId("anthropic");
		const account = makeAccount({
			id: accId,
			name: "Opus",
			rate_limited_until: Date.now() + 400_000,
		});
		const { ctx, recordedErrors } = makeContext([account], {
			pin: { pinnedAccountId: null, pinnedProviders: ["anthropic"] },
		});

		const res = await callHandleProxy(
			makeRequest("claude-opus-4-7"),
			new URL("https://proxy.local/v1/messages"),
			ctx,
			uniqueId("key"),
		);

		expect(res.status).toBe(503);
		const body = (await res.json()) as { error: { type: string } };
		expect(body.error.type).toBe("pinned_no_available_account");
		expect(recordedErrors).toEqual(["pinned_no_available_account"]);
	});

	it("early pin terminal records pinned_account_unavailable VERBATIM after the pin hold gives up", async () => {
		// Specific-account pin on a SHORT transient cooldown ⇒ the pin-transient hold
		// runs. Its re-selection clears pinFailure and succeeds, but the usage-throttle
		// gate then removes the recovered account, so the hold gives up with nothing
		// served. Only the save/restore triangle puts the ORIGINAL code back; without
		// it this request would reach the LATER terminal and record
		// "pinned_target_unavailable" instead.
		const accId = uniqueId("anthropic");
		const account = makeAccount({
			id: accId,
			name: "Opus",
			rate_limited_until: Date.now() + 150,
		});
		seedThrottled(accId);
		const { ctx, recordedErrors } = makeContext([account], {
			pin: { pinnedAccountId: accId, pinnedProviders: null },
			usageThrottling: true,
		});

		const res = await callHandleProxy(
			makeRequest("claude-opus-4-7"),
			new URL("https://proxy.local/v1/messages"),
			ctx,
			uniqueId("key"),
		);

		expect(res.status).toBe(503);
		const body = (await res.json()) as { error: { type: string } };
		expect(body.error.type).toBe("pinned_account_unavailable");
		expect(recordedErrors).toEqual(["pinned_account_unavailable"]);
	});

	it("later pinned terminal records the fixed pinned_target_unavailable label", async () => {
		// Codex-CLI floor (deny-official-anthropic) with the only account cooled:
		// selection returns [] BEFORE the floor filter runs, so no pinFailure is set
		// and no earlier terminal applies — the fixed-label pinned terminal fires.
		const accId = uniqueId("anthropic");
		const account = makeAccount({
			id: accId,
			name: "Opus",
			rate_limited_until: Date.now() + 60_000,
		});
		const { ctx, recordedErrors } = makeContext([account]);

		const res = await callHandleProxy(
			makeRequest("claude-opus-4-7", {
				"x-clankermux-deny-official-anthropic": "1",
			}),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(res.status).toBe(503);
		const body = (await res.json()) as { error: { type: string } };
		expect(body.error.type).toBe("pinned_target_unavailable");
		expect(recordedErrors).toEqual(["pinned_target_unavailable"]);
	});

	it("family-weekly cooled-sibling terminal records family_weekly_exhausted", async () => {
		// Reachable account is Fable-exhausted; a Fable-capable sibling is cooled for
		// 200s — beyond the 120s hold budget, so the sibling-scoped 429 fires.
		const exhaustedId = uniqueId("exhausted");
		const siblingId = uniqueId("sibling");
		seedFamilyUsage(exhaustedId, true);
		seedFamilyUsage(siblingId, false);
		const exhausted = makeAccount({ id: exhaustedId, name: "Main-me" });
		const sibling = makeAccount({
			id: siblingId,
			name: "Backup1",
			rate_limited_until: Date.now() + 200_000,
		});
		const { ctx, recordedErrors } = makeContext([exhausted, sibling]);

		const res = await callHandleProxy(
			makeRequest("claude-fable-5"),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(res.status).toBe(429);
		expect(res.headers.get("x-clankermux-pool-status")).toBe(
			"family-weekly-sibling-cooldown",
		);
		expect(recordedErrors).toEqual(["family_weekly_exhausted"]);
	});

	it("family-weekly genuine-exhaustion terminal records family_weekly_exhausted", async () => {
		// Both accounts Fable-exhausted ⇒ no family-capable sibling to hold for.
		const exhaustedId = uniqueId("exhausted");
		const siblingId = uniqueId("sibling");
		seedFamilyUsage(exhaustedId, true);
		seedFamilyUsage(siblingId, true);
		const exhausted = makeAccount({ id: exhaustedId, name: "Main-me" });
		const sibling = makeAccount({
			id: siblingId,
			name: "Backup1",
			rate_limited_until: Date.now() + 30_000,
		});
		const { ctx, recordedErrors } = makeContext([exhausted, sibling]);

		const res = await callHandleProxy(
			makeRequest("claude-fable-5"),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(res.status).toBe(429);
		expect(res.headers.get("x-clankermux-pool-status")).toBe(
			"family-weekly-exhausted",
		);
		expect(recordedErrors).toEqual(["family_weekly_exhausted"]);
	});

	it("pool-exhausted terminal records pool_exhausted", async () => {
		const { ctx, recordedErrors } = makeContext([], {
			providerName: "codex",
		});

		const res = await callHandleProxy(
			makeRequest("claude-sonnet-4-5"),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(res.status).toBe(503);
		expect(res.headers.get("x-clankermux-pool-status")).toBe("exhausted");
		expect(recordedErrors).toEqual(["pool_exhausted"]);
	});

	it("usage-throttled terminal records NOTHING", async () => {
		const accId = uniqueId("anthropic");
		const account = makeAccount({ id: accId, name: "Throttled" });
		seedThrottled(accId);
		const { ctx, recordedErrors } = makeContext([account], {
			usageThrottling: true,
		});

		const res = await callHandleProxy(
			makeRequest("claude-opus-4-7"),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(res.status).toBe(529);
		expect(recordedErrors).toEqual([]);
	});

	it("context-window size-400 terminal records NOTHING", async () => {
		// gpt-5.5's window is smaller than the estimate even UNMARGINED, so the
		// last-resort relaxation has no candidate and the size verdict stands.
		const accId = uniqueId("codex");
		const codex = makeAccount({
			id: accId,
			name: "Codex-me",
			provider: "codex",
			api_key: null,
			model_mappings: JSON.stringify({ opus: "gpt-5.5" }),
		});
		const { ctx, recordedErrors } = makeContext([codex], {
			providerName: "codex",
		});

		const res = await callHandleProxy(
			makeLargeRequest("claude-opus-4-7", 350_000),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { type: string } };
		expect(body.error.type).toBe("context_window_exceeded");
		expect(recordedErrors).toEqual([]);
	});
});
