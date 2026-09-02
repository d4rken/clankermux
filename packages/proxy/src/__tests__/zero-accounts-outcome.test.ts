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
import type { Account, ComboSlotInfo, RequestMeta } from "@clankermux/types";
import type { AdmissionGates } from "../admission-gates";
import { cacheBodyStore } from "../cache-body-store";
import { setComboSlotInfo, setForcedAccount } from "../handlers";
import {
	clearAnthropicBurstThrottle,
	resetHoldSlots,
} from "../handlers/burst-cooldown";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import { resetOverloadHoldSlots } from "../overload-hold";
import {
	applyProviderOverloadCooldown,
	clearProviderOverloadCooldown,
} from "../provider-overload-cooldown";
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
	familyWeeklyPacedAccounts?: Array<{
		account: Account;
		family: string;
		resumeAt: number;
	}>;
	holds?: Partial<RecoveryHolds>;
	requestId?: string;
	/** Combo snapshot frozen at gate construction. */
	initialComboInfo?: ComboSlotInfo | null;
	/** Combo name on the request meta, plus the CURRENT (post-wake) slot info. */
	comboName?: string | null;
	currentComboInfo?: ComboSlotInfo | null;
}

function makeHarness(opts: HarnessOptions = {}): Harness {
	const {
		accounts = [],
		pin = null,
		pinFailure = null,
		gateTokenEstimate = 100,
		contextExcludedAccounts = [],
		familyWeeklyExcludedAccounts = [],
		familyWeeklyPacedAccounts = [],
		holds = {},
		requestId = uniqueId("req"),
		initialComboInfo = null,
		comboName = null,
		currentComboInfo = null,
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
		...(comboName ? { comboName } : {}),
	} as unknown as RequestMeta;
	if (currentComboInfo) setComboSlotInfo(requestMeta, currentComboInfo);

	const recorded: string[] = [];
	let bumps = 0;

	const gates = {
		contextExcludedAccounts,
		familyWeeklyExcludedAccounts,
		familyWeeklyPacedAccounts,
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
		initialComboInfo,
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

	// Every overload deadline in this terminal must read the bucket the account's
	// own attempt would trip. Reading the request's logical model instead means a
	// mapped account (opus -> sonnet here) is measured against the wrong family:
	// a hold is skipped when it was needed, or entered when there was nothing to
	// wait for.
	describe("overload deadlines follow the account's mapped model", () => {
		const SONNET = "claude-sonnet-4-5";
		const HAIKU = "claude-haiku-4-5";

		function pinHarness(mapTo: string, openBucketModel: string) {
			const accId = uniqueId("acc");
			const pinned = makeAccount({
				id: accId,
				name: accId,
				model_mappings: JSON.stringify({ [MODEL]: mapTo }),
			});
			const holdLabels: string[] = [];
			const harness = makeHarness({
				accounts: [pinned],
				pin: { accountId: accId, providers: null },
				pinFailure: {
					code: "pinned_account_unavailable",
					message: "unavailable",
				},
				holds: {
					holdForNonCodexRecovery: async (_budgetMs, label) => {
						holdLabels.push(label);
						return null;
					},
				},
			});
			applyProviderOverloadCooldown(
				"anthropic",
				Date.now() + 5_000,
				openBucketModel,
			);
			return { harness, holdLabels };
		}

		it("pin hold fires when the MAPPED family's breaker is open", async () => {
			const { harness, holdLabels } = pinHarness(SONNET, SONNET);

			await resolveZeroAccountsOutcome(harness.deps);

			expect(holdLabels).toHaveLength(1);
		});

		it("pin hold does NOT fire when only the logical family's breaker is open", async () => {
			const { harness, holdLabels } = pinHarness(SONNET, MODEL);

			await resolveZeroAccountsOutcome(harness.deps);

			expect(holdLabels).toEqual([]);
		});

		/**
		 * Cooled-sibling detection runs AFTER holdForNonCodexRecovery, whose wake
		 * re-runs selection and rewrites the combo slot info. Reading the frozen
		 * `initialComboInfo` would measure the sibling against the model the
		 * request STARTED with rather than the one it would now send.
		 */
		function siblingHarness(openBucketModel: string) {
			const siblingId = uniqueId("sibling");
			const sibling = makeAccount({ id: siblingId, name: siblingId });
			const exhausted = makeAccount({
				id: uniqueId("exhausted"),
				name: "exhausted",
			});
			const holdLabels: string[] = [];
			const harness = makeHarness({
				accounts: [sibling],
				familyWeeklyExcludedAccounts: [
					{
						account: exhausted,
						family: "opus",
						resetAt: Date.now() + 86_400_000,
					},
				],
				comboName: "combo-a",
				// Frozen at gate construction: the slot pointed at Haiku.
				initialComboInfo: {
					comboName: "combo-a",
					slots: [{ accountId: siblingId, modelOverride: HAIKU }],
				},
				// What a hold wake's re-selection wrote: the slot now sends Sonnet.
				currentComboInfo: {
					comboName: "combo-a",
					slots: [{ accountId: siblingId, modelOverride: SONNET }],
				},
				holds: {
					holdForNonCodexRecovery: async (_budgetMs, label) => {
						holdLabels.push(label);
						return null;
					},
				},
			});
			applyProviderOverloadCooldown(
				"anthropic",
				Date.now() + 5_000,
				openBucketModel,
			);
			return { harness, sibling, holdLabels };
		}

		it("detects a cooled sibling via the CURRENT combo override", async () => {
			const { harness, sibling, holdLabels } = siblingHarness(SONNET);

			const res = await resolveZeroAccountsOutcome(harness.deps);

			expect(holdLabels).toEqual(["Family-weekly hold"]);
			const body = (await res.json()) as { error: { message: string } };
			expect(body.error.message).toContain(sibling.name);
		});

		it("ignores the frozen combo snapshot's family", async () => {
			const { harness, holdLabels } = siblingHarness(HAIKU);

			await resolveZeroAccountsOutcome(harness.deps);

			expect(holdLabels).toEqual([]);
		});
	});

	// Family-weekly pacing is throttle evidence: the account is over its per-family
	// weekly PACE, not exhausted and not unavailable. Every terminal that gives
	// throttling precedence has to see it, or the request gets an answer that
	// tells the client the wrong thing to do.
	describe("family-weekly pacing is throttle evidence", () => {
		function paced(account: Account) {
			return [{ account, family: "fable", resumeAt: Date.now() + 60_000 }];
		}

		it("answers with the 529 usage-throttled terminal, not the family 429", async () => {
			const account = makeAccount({ id: uniqueId("paced"), name: "Paced" });
			const harness = makeHarness({
				accounts: [account],
				familyWeeklyPacedAccounts: paced(account),
			});

			const res = await resolveZeroAccountsOutcome(harness.deps);

			expect(res.status).toBe(529);
			const body = (await res.json()) as { error: { message: string } };
			expect(body.error.message).toContain("Paced");
		});

		it("outranks the family-exhausted 429 when both lists are populated", async () => {
			// The exhausted account's Retry-After is its multi-day weekly window;
			// answering with that when a paced sibling recovers in a minute tells
			// the client to stay away for days.
			const pacedAccount = makeAccount({
				id: uniqueId("paced"),
				name: "Paced",
			});
			const exhausted = makeAccount({
				id: uniqueId("exhausted"),
				name: "Exhausted",
			});
			const harness = makeHarness({
				accounts: [pacedAccount, exhausted],
				familyWeeklyPacedAccounts: paced(pacedAccount),
				familyWeeklyExcludedAccounts: [
					{
						account: exhausted,
						family: "fable",
						resetAt: Date.now() + 5 * 86_400_000,
					},
				],
			});

			const res = await resolveZeroAccountsOutcome(harness.deps);

			expect(res.status).toBe(529);
		});

		it("takes precedence over the context-window hold", async () => {
			// A CW hold waits for a large-context account to come back; a paced
			// account is not coming back any sooner for being waited on, and the
			// honest answer is the retryable throttle.
			const pacedAccount = makeAccount({
				id: uniqueId("paced"),
				name: "Paced",
			});
			const codex = makeAccount({
				id: uniqueId("codex"),
				name: "Codex",
				provider: "codex",
			});
			let cwHoldEntered = false;
			const harness = makeHarness({
				accounts: [pacedAccount, codex],
				familyWeeklyPacedAccounts: paced(pacedAccount),
				contextExcludedAccounts: [{ account: codex, model: MODEL }],
				gateTokenEstimate: 2_000_000,
				holds: {
					holdForNonCodexRecovery: async () => {
						cwHoldEntered = true;
						return null;
					},
				},
			});

			const res = await resolveZeroAccountsOutcome(harness.deps);

			expect(cwHoldEntered).toBe(false);
			expect(res.status).toBe(529);
		});
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
