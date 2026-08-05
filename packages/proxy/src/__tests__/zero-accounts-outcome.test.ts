/**
 * CONTRACT tests for `resolveZeroAccountsOutcome` — the extracted zero-accounts
 * terminal — called directly with stub gates/holds/recorder.
 *
 * Deliberately thin: the RESPONSE behaviour of every terminal (status, body,
 * headers, recorder label) is owned by the boundary suites that drive
 * `handleProxy` end to end (zero-accounts-terminal-labels, pool-exhausted,
 * family-weekly-hold, context-window-gate, api-key-pin-hold, …). What is pinned
 * here is what only a direct call can observe:
 *
 *   (a) the `requestMeta.pinFailure` save/restore triangle around the pin hold;
 *   (b) the idle-timeout re-arm lifecycle at all THREE hold call sites — an
 *       immediate bump plus exactly one rearm interval, cleared on every exit;
 *   (c) the staged-body invariant: a give-up / fall-through leaves
 *       `cacheBodyStore` staging at its baseline;
 *   (d) client-abort exits never write a synthetic history row.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { NETWORK } from "@clankermux/core";
import type { Account, RequestMeta } from "@clankermux/types";
import type { AdmissionGates } from "../admission-gates";
import { cacheBodyStore } from "../cache-body-store";
import { setForcedAccount } from "../handlers";
import {
	clearAnthropicBurstThrottle,
	resetHoldSlots,
} from "../handlers/burst-cooldown";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import { resetOverloadHoldSlots } from "../overload-hold";
import { clearProviderOverloadCooldown } from "../provider-overload-cooldown";
import type { RecoveryHolds } from "../recovery-holds";
import { sessionProjectCache } from "../session-project-cache";
import { sessionPromotionTracker } from "../session-promotion";
import {
	resolveZeroAccountsOutcome,
	type ZeroAccountsOutcomeDeps,
} from "../zero-accounts-terminal";

const MODEL = "claude-opus-4-7";

/** Unique per test so no singleton state leaks between cases. */
let idCounter = 0;
function uniqueId(prefix: string): string {
	idCounter++;
	return `${prefix}-${idCounter}`;
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

interface Harness {
	deps: ZeroAccountsOutcomeDeps;
	requestMeta: RequestMeta;
	/** Labels handed to `recordSyntheticErrorResponse`, in order. */
	recorded: string[];
	/** How many times `bumpIdleTimeout` fired. */
	bumps: () => number;
	abort: () => void;
}

interface HarnessOptions {
	accounts?: Account[];
	pin?: { accountId: string | null; providers: string[] | null } | null;
	pinFailure?: { code: string; message: string } | null;
	gateTokenEstimate?: number;
	contextExcludedAccounts?: Array<{ account: Account; model: string }>;
	familyWeeklyExcludedAccounts?: Array<{
		account: Account;
		family: string;
		resetAt: number;
	}>;
	holds?: Partial<RecoveryHolds>;
	requestId?: string;
}

function makeHarness(opts: HarnessOptions = {}): Harness {
	const {
		accounts = [],
		pin = null,
		pinFailure = null,
		gateTokenEstimate = 100,
		contextExcludedAccounts = [],
		familyWeeklyExcludedAccounts = [],
		holds = {},
		requestId = uniqueId("req"),
	} = opts;

	const controller = new AbortController();
	const req = new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: MODEL,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
		signal: controller.signal,
	});

	const requestMeta = {
		id: requestId,
		timestamp: Date.now(),
		internal: false,
		pin,
		pinFailure,
	} as unknown as RequestMeta;

	const recorded: string[] = [];
	let bumps = 0;

	const gates = {
		contextExcludedAccounts,
		familyWeeklyExcludedAccounts,
		softDemotionReasons: new Map<string, string>(),
	} as unknown as AdmissionGates;

	const holdStub = {
		holdForNonCodexRecovery: async () => null,
		holdForOverloadRecovery: async () => null,
		runBurstHold: async () => ({ kind: "gave-up" }),
		refreshOverloadUntils: (gated: never[]) => [...gated],
		noteOverloadSuppression: () => {},
		noteBurstAttempt: () => {},
		overloadSuppressedAttempts: [],
		burstAttemptedAccountId: null,
		burstHoldDeclined: false,
		burstHeldAccountForGiveUp: null,
		burstHeldId: null,
		...holds,
	} as unknown as RecoveryHolds;

	const deps: ZeroAccountsOutcomeDeps = {
		req,
		url: new URL("https://proxy.local/v1/messages"),
		ctx: {
			dbOps: {
				getAllAccounts: async () => accounts,
				getAccount: async (id: string) =>
					accounts.find((a) => a.id === id) ?? null,
			},
			provider: { name: "anthropic" },
			config: { getStorePayloads: () => false },
		} as never,
		apiKeyId: null,
		apiKeyName: null,
		requestMeta,
		requestBodyContext: {} as never,
		finalBodyBuffer: null,
		finalCreateBodyStream: () => undefined,
		effectiveRequestModel: MODEL,
		gateTokenEstimate,
		initialComboInfo: null,
		selectedAccounts: [],
		throttledAccounts: [],
		providerAvailableAccounts: [],
		providerOverloadedAccounts: [],
		bumpIdleTimeout: () => {
			bumps++;
		},
		gates,
		holds: holdStub,
		recordSyntheticErrorResponse: async (_response, error) => {
			recorded.push(error);
		},
		createProviderOverloadedResponse: async () =>
			new Response("{}", { status: 529 }),
		logFinalOrderOnce: () => {},
		attemptThroughProbeGate: async (_account, attempt) => ({
			response: await attempt(),
			suppressed: false,
		}),
	};

	return {
		deps,
		requestMeta,
		recorded,
		bumps: () => bumps,
		abort: () => controller.abort(),
	};
}

/**
 * Run `fn` with `setInterval`/`clearInterval` spied, returning the handles of
 * every idle-timeout re-arm interval created and cleared while it ran.
 */
async function withRearmIntervalSpy<T>(
	fn: () => Promise<T>,
): Promise<{ result: T; created: unknown[]; cleared: unknown[] }> {
	const originalSet = globalThis.setInterval;
	const originalClear = globalThis.clearInterval;
	const created: unknown[] = [];
	const cleared: unknown[] = [];
	globalThis.setInterval = ((
		handler: TimerHandler,
		timeout?: number,
		...args: unknown[]
	) => {
		const handle = (originalSet as never as CallableFunction)(
			handler,
			timeout,
			...args,
		);
		if (timeout === NETWORK.IDLE_REARM_INTERVAL_MS) created.push(handle);
		return handle;
	}) as never;
	globalThis.clearInterval = ((handle: unknown) => {
		cleared.push(handle);
		return (originalClear as never as CallableFunction)(handle);
	}) as never;
	try {
		const result = await fn();
		return { result, created, cleared };
	} finally {
		globalThis.setInterval = originalSet;
		globalThis.clearInterval = originalClear;
	}
}

/** A body with a prompt-cache breakpoint, so cacheBodyStore will stage it. */
function cacheableBody(): ArrayBuffer {
	const json = JSON.stringify({
		model: MODEL,
		system: [
			{ type: "text", text: "sys", cache_control: { type: "ephemeral" } },
		],
		messages: [{ role: "user", content: "hello" }],
	});
	return new TextEncoder().encode(json).buffer as ArrayBuffer;
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
}

describe("resolveZeroAccountsOutcome contracts", () => {
	beforeEach(resetSingletons);
	afterEach(resetSingletons);

	it("restores the pinFailure a hold's re-selection cleared, and records ITS code", async () => {
		// The real hold nulls `requestMeta.pinFailure` under `clearPinFailure` so
		// re-selection isn't short-circuited by the strict-fail marker. When it then
		// gives up with nothing served, the ORIGINAL failure must be back — otherwise
		// the request falls through to the generic pinned terminal and history is
		// attributed to the wrong code.
		const accId = uniqueId("acc");
		const pinned = makeAccount({
			id: accId,
			rate_limited_until: Date.now() + 5_000,
		});
		const original = {
			code: "pinned_account_unavailable",
			message: "pinned account is unavailable",
		};
		const harness = makeHarness({
			accounts: [pinned],
			pin: { accountId: accId, providers: null },
			pinFailure: original,
			holds: {
				holdForNonCodexRecovery: async () => {
					harness.requestMeta.pinFailure = null;
					return null;
				},
			},
		});

		const res = await resolveZeroAccountsOutcome(harness.deps);

		expect(res.status).toBe(503);
		expect(harness.requestMeta.pinFailure).toEqual(original);
		expect(harness.recorded).toEqual(["pinned_account_unavailable"]);
	});

	it("arms exactly one re-arm interval per hold and clears it on exit (pin hold)", async () => {
		const accId = uniqueId("acc");
		const pinned = makeAccount({
			id: accId,
			rate_limited_until: Date.now() + 5_000,
		});
		const harness = makeHarness({
			accounts: [pinned],
			pin: { accountId: accId, providers: null },
			pinFailure: {
				code: "pinned_account_unavailable",
				message: "unavailable",
			},
		});

		const { created, cleared } = await withRearmIntervalSpy(() =>
			resolveZeroAccountsOutcome(harness.deps),
		);

		// Immediate bump before the first sleep, one interval, cleared on exit.
		expect(harness.bumps()).toBeGreaterThanOrEqual(1);
		expect(created.length).toBe(1);
		expect(cleared).toContain(created[0]);
	});

	it("arms exactly one re-arm interval per hold and clears it on exit (CW hold)", async () => {
		const excluded = makeAccount({ id: uniqueId("acc") });
		const harness = makeHarness({
			// Beyond every backend's FULL window, so the last-resort relaxation has no
			// candidate and the size verdict returns from inside the try block.
			gateTokenEstimate: 5_000_000,
			contextExcludedAccounts: [{ account: excluded, model: MODEL }],
		});

		const { result, created, cleared } = await withRearmIntervalSpy(() =>
			resolveZeroAccountsOutcome(harness.deps),
		);

		expect(result.status).toBe(400);
		expect(harness.bumps()).toBeGreaterThanOrEqual(1);
		expect(created.length).toBe(1);
		expect(cleared).toContain(created[0]);
	});

	it("arms exactly one re-arm interval per hold and clears it on exit (family-weekly hold)", async () => {
		const exhausted = makeAccount({ id: uniqueId("acc"), name: "Exhausted" });
		// A family-capable sibling on a short transient cooldown — the only shape
		// that opens the family hold.
		const sibling = makeAccount({
			id: uniqueId("acc"),
			name: "Sibling",
			rate_limited_until: Date.now() + 5_000,
		});
		const harness = makeHarness({
			accounts: [sibling],
			familyWeeklyExcludedAccounts: [
				{
					account: exhausted,
					family: "opus",
					resetAt: Date.now() + 5 * 86_400_000,
				},
			],
		});

		const { result, created, cleared } = await withRearmIntervalSpy(() =>
			resolveZeroAccountsOutcome(harness.deps),
		);

		expect(result.status).toBe(429);
		expect(harness.bumps()).toBeGreaterThanOrEqual(1);
		expect(created.length).toBe(1);
		expect(cleared).toContain(created[0]);
		expect(harness.recorded).toEqual(["family_weekly_exhausted"]);
	});

	it("returns the staged body to baseline on the burst give-up terminal", async () => {
		const requestId = uniqueId("req");
		const held = makeAccount({
			id: uniqueId("acc"),
			rate_limited_until: Date.now() + 30_000,
		});
		const baseline = cacheBodyStore.getStagingSize();
		cacheBodyStore.setEnabled(true);
		cacheBodyStore.stageRequest(
			requestId,
			held.id,
			cacheableBody(),
			new Headers(),
			"/v1/messages",
			null,
			"anthropic",
		);
		expect(cacheBodyStore.getStagingSize()).toBe(baseline + 1);

		const harness = makeHarness({
			requestId,
			holds: { burstHoldDeclined: true, burstHeldAccountForGiveUp: held },
		});
		const res = await resolveZeroAccountsOutcome(harness.deps);

		expect(res.status).toBe(429);
		expect(cacheBodyStore.getStagingSize()).toBe(baseline);
	});

	it("returns the staged body to baseline on the context-window fall-through", async () => {
		const requestId = uniqueId("req");
		const excluded = makeAccount({ id: uniqueId("acc") });
		const baseline = cacheBodyStore.getStagingSize();
		cacheBodyStore.setEnabled(true);
		cacheBodyStore.stageRequest(
			requestId,
			excluded.id,
			cacheableBody(),
			new Headers(),
			"/v1/messages",
			null,
			"anthropic",
		);
		expect(cacheBodyStore.getStagingSize()).toBe(baseline + 1);

		const harness = makeHarness({
			requestId,
			gateTokenEstimate: 5_000_000,
			contextExcludedAccounts: [{ account: excluded, model: MODEL }],
		});
		const res = await resolveZeroAccountsOutcome(harness.deps);

		expect(res.status).toBe(400);
		expect(cacheBodyStore.getStagingSize()).toBe(baseline);
	});

	it("records NOTHING when the client disconnected before the terminals", async () => {
		const harness = makeHarness();
		harness.abort();

		const res = await resolveZeroAccountsOutcome(harness.deps);

		expect(res.status).toBe(499);
		expect(harness.recorded).toEqual([]);
	});

	it("records NOTHING when the client disconnects during the context-window hold", async () => {
		const excluded = makeAccount({ id: uniqueId("acc") });
		const harness = makeHarness({
			gateTokenEstimate: 5_000_000,
			contextExcludedAccounts: [{ account: excluded, model: MODEL }],
		});
		harness.abort();

		const res = await resolveZeroAccountsOutcome(harness.deps);

		expect(res.status).toBe(499);
		expect(harness.recorded).toEqual([]);
	});
});
