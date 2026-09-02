import {
	codexAccountFitsRequest,
	getModelFamily,
	isAccountAvailable,
	isProtectedFamily,
	mapModelName,
	PROTECTED_FAMILY,
	resolveCodexTargetModel,
	resolveModelContextWindow,
} from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import { getFreshCapacity, usageCache } from "@clankermux/providers";
import type { Account, ComboSlotInfo, RequestMeta } from "@clankermux/types";
import { getFamilyWeeklyExhaustedUntil } from "./family-weekly-memo";
import {
	type ContextWindowExcludedBackend,
	FAMILY_WEEKLY_MAX_USAGE_AGE_MS,
	type FamilyWeeklyExcludedAccount,
	type FamilyWeeklyPacedAccount,
	getUsageThrottleUntil,
	isAbsorbablePeer,
	type ProxyContext,
	resolveFamilyWeeklyExclusion,
	resolveFamilyWeeklyPacing,
	resolveLivenessReserveThreshold,
	resolvePoolLivenessDemotion,
} from "./handlers";
import { resolveReservationDemotion } from "./handlers/family-reservation-gate";
import {
	hasCapacityRestoredProbePending,
	wouldSuppressProbe,
} from "./handlers/rate-limit-cooldown";
import { getLastProtectedFamilyDemand } from "./protected-family-demand";
import {
	ANTHROPIC_UPSTREAM_OVERLOAD_KEY,
	getProviderOverloadKey,
	getProviderOverloadUntil,
	isProviderOverloaded,
	resolveOverloadAttributionModel,
} from "./provider-overload-cooldown";
import { resolveEffectiveWeeklySlope } from "./weekly-burn-slope";

const log = new Logger("Proxy");

/** An account the provider-overload gate excluded, with its block deadline. */
export type ProviderOverloadedAccount = {
	account: Account;
	until: number;
	/**
	 * The model whose bucket actually caused this account to be gated.
	 *
	 * Present when the CALLER resolved a specific model to make the decision —
	 * the attempt loop's late gate keys on the combo override or the request's
	 * logical model, which is not necessarily what `modelForAccount` returns for
	 * an account with per-account model mapping. Without carrying it, the hold
	 * and the terminal re-derive a DIFFERENT bucket: gate skips on sonnet, hold
	 * finds opus closed and retries immediately, terminal refreshes the wrong
	 * deadline.
	 *
	 * Absent (undefined) means "no specific model was resolved" — the
	 * pre-selection gate, which the hold may key by `modelForAccount` as before.
	 */
	gatedModel?: string | null;
};

/**
 * Everything the admission gates need from the request that produced them.
 * Captured ONCE at construction — see {@link createAdmissionGates} for what is
 * deliberately frozen and what is deliberately live.
 */
export interface AdmissionGateDeps {
	/**
	 * The LIVE request metadata object, never a snapshot or a destructured copy
	 * of its fields: `modelForAccount` reads `requestMeta.comboName` at CALL
	 * time, and the combo-fallback path nulls it precisely so a cleared combo
	 * stops applying slot overrides.
	 */
	requestMeta: RequestMeta;
	/** Combo slot info as it stood when the gates were built (see below). */
	initialComboInfo: ComboSlotInfo | null;
	/** The request's effective (post-body-context) model, if any. */
	effectiveRequestModel: string | null;
	/** Calibrated context-window token estimate for this request. */
	gateTokenEstimate: number;
	/**
	 * Whether this is a trusted synthetic probe. Computed in handleProxy (it
	 * needs `req.headers` plus `requestMeta.internal`) and passed in as a plain
	 * boolean.
	 */
	isSyntheticProbeRequest: boolean;
	/** `ctx.config` — the usage-throttle getters are read LIVE on every call. */
	config: ProxyContext["config"];
}

/** The per-request admission gates, plus the state they accumulate. */
export interface AdmissionGates {
	modelForAccount: (account: Account) => string | null;
	applyProviderOverloadGate: (accounts: Account[]) => {
		available: Account[];
		overloaded: ProviderOverloadedAccount[];
	};
	shouldForwardProviderOverloadIfNoCrossProviderFallback: (
		candidates: Account[],
		index: number,
	) => boolean;
	everyRemainingCandidateUnattemptable: (
		candidates: Account[],
		index: number,
	) => boolean;
	applyUsageThrottling: (accounts: Account[]) => {
		available: Account[];
		throttled: Account[];
	};
	applyContextWindowGate: (
		candidates: Account[],
		comboInfo?: {
			slots: Array<{ accountId: string; modelOverride: string }>;
		} | null,
	) => Account[];
	applyFamilyWeeklyGate: (
		candidates: Account[],
		comboInfo?: {
			slots: Array<{ accountId: string; modelOverride: string }>;
		} | null,
	) => Account[];
	applySoftDemotionReorder: (
		candidates: Account[],
		comboInfo?: {
			slots: Array<{ accountId: string; modelOverride: string }>;
		} | null,
	) => Account[];
	/**
	 * Moves accounts a 429 already refused for this request's family to the back.
	 * MUST be applied last, after every other gate and reorder — see the comment
	 * on the implementation for why running it earlier lets a later partition
	 * promote the refused account back to the front.
	 */
	applyFamilyMemoDemotion: (
		candidates: Account[],
		comboInfo?: {
			slots: Array<{ accountId: string; modelOverride: string }>;
		} | null,
	) => Account[];
	/**
	 * Accounts the context-window gate excluded, accumulated with per-account-id
	 * dedup across EVERY gate pass this request makes (main pass, both hold-wake
	 * re-selections, combo fallback).
	 */
	readonly contextExcludedAccounts: readonly ContextWindowExcludedBackend[];
	/** Same accumulate-and-dedup contract for the family-weekly gate. */
	readonly familyWeeklyExcludedAccounts: readonly FamilyWeeklyExcludedAccount[];
	/**
	 * Accounts the family-weekly gate held back for PACING (the family is ahead
	 * of an even burn but not yet spent), same accumulate-and-dedup contract.
	 *
	 * Deliberately a separate list from `familyWeeklyExcludedAccounts`: pacing is
	 * throttle evidence (a 529 "come back shortly"), never grounds for the
	 * family-exhausted 429 and its multi-day Retry-After.
	 */
	readonly familyWeeklyPacedAccounts: readonly FamilyWeeklyPacedAccount[];
	/**
	 * Why each demoted account was demoted, as of the LATEST
	 * `applySoftDemotionReorder` call (each call rebuilds it from scratch).
	 */
	readonly softDemotionReasons: ReadonlyMap<string, string>;
}

/**
 * Build the admission gates for ONE request.
 *
 * Per-request rather than module-level because two of the gates own mutable
 * state that must accumulate across every pass a single request makes —
 * `contextExcludedAccounts` and `familyWeeklyExcludedAccounts` are read by the
 * zero-accounts terminals after the main pass, both hold-wake re-selections and
 * the combo fallback have all had their chance to add to them.
 *
 * The combo snapshot is DELIBERATELY frozen at construction: `modelForAccount`
 * keeps using `initialComboInfo` for the whole request, while a hold-wake
 * re-selection passes its FRESH `wakeComboInfo` only to `applyContextWindowGate`
 * / `applyFamilyWeeklyGate` through their `comboInfo` parameter. That asymmetry
 * is existing behavior, preserved here rather than "fixed".
 */
export function createAdmissionGates(deps: AdmissionGateDeps): AdmissionGates {
	const {
		requestMeta,
		initialComboInfo,
		effectiveRequestModel,
		gateTokenEstimate,
		isSyntheticProbeRequest,
		config,
	} = deps;

	// Effective model for per-account overload reads: the combo slot's model
	// override when an ACTIVE combo targets this account, else the request
	// model — then resolved through the account's model mapping so the gate
	// sees the model the account will actually send upstream. mapModelName is
	// a pure, cheap lookup over the account's mapping columns (no body
	// parsing), so it is safe on the pre-selection hot path. The mapped-vs-
	// logical choice is the SHARED resolveOverloadAttributionModel rule the
	// authoritative admission inside proxyWithAccount also applies, so gate and
	// admission can never target different buckets. Routing optimization only —
	// authoritative per-attempt enforcement is the admission chokepoint. The
	// comboName check keeps a cleared combo (fallback path) from resurrecting
	// stale overrides.
	const modelForAccount = (account: Account): string | null => {
		let logical = effectiveRequestModel ?? null;
		if (requestMeta.comboName && initialComboInfo) {
			const slot = initialComboInfo.slots.find(
				(s) => s.accountId === account.id,
			);
			if (slot?.modelOverride) logical = slot.modelOverride;
		}
		if (!logical) return null;
		return resolveOverloadAttributionModel(
			mapModelName(logical, account),
			logical,
		);
	};

	const applyProviderOverloadGate = (accounts: Account[]) => {
		const now = Date.now();
		const available: Account[] = [];
		const overloaded: ProviderOverloadedAccount[] = [];

		for (const account of accounts) {
			// Family-scoped read: only buckets relevant to this account's effective
			// model (combo override or request model) gate it — a Haiku-only
			// incident no longer sidelines Sonnet/Opus traffic.
			const overloadedUntil = getProviderOverloadUntil(
				account.provider,
				now,
				modelForAccount(account),
			);
			if (overloadedUntil) {
				overloaded.push({ account, until: overloadedUntil });
				continue;
			}
			available.push(account);
		}

		if (overloaded.length > 0) {
			const providers = Array.from(
				new Set(
					overloaded.map(
						({ account, until }) =>
							`${getProviderOverloadKey(account.provider)} until ${new Date(until).toISOString()}`,
					),
				),
			);
			log.debug(
				`Provider-overload gate excluded ${overloaded.length} account(s): ${providers.join(", ")}`,
			);
		}

		return { available, overloaded };
	};

	const shouldForwardProviderOverloadIfNoCrossProviderFallback = (
		candidates: Account[],
		index: number,
	): boolean => {
		const current = candidates[index];
		if (
			!current ||
			getProviderOverloadKey(current.provider) !==
				ANTHROPIC_UPSTREAM_OVERLOAD_KEY
		) {
			return false;
		}
		const currentOverloadKey = getProviderOverloadKey(current.provider);
		const now = Date.now();
		return !candidates
			.slice(index + 1)
			.some(
				(account) =>
					getProviderOverloadKey(account.provider) !== currentOverloadKey &&
					!isProviderOverloaded(
						account.provider,
						now,
						modelForAccount(account),
					),
			);
	};

	/**
	 * True when every candidate AFTER `index` would be refused before it could
	 * ever reach upstream — by the account's own cooldown, by the single-flight
	 * recovery-probe gate, or by the provider-overload gate — so this attempt is
	 * the request's last realistic one and its real 529 body must be FORWARDED,
	 * not discarded.
	 *
	 * Scope: the same-provider case is already covered by
	 * {@link shouldForwardProviderOverloadIfNoCrossProviderFallback}. The residual
	 * gap this closes is a MIXED-provider pool — e.g. [A(anthropic), B(codex)]
	 * with B probe-suppressed — where A's genuine `overloaded_error` was thrown
	 * away and the client got a generic 503 instead.
	 *
	 * The COOLDOWN term is not redundant with selection. This predicate is
	 * evaluated when the 529 ARRIVES, against a candidate list that was gated
	 * before the attempt started: a tail whose own recovery probe 429'd in the
	 * meantime has a fresh future cooldown AND a released lease, so probe
	 * suppression alone reads it as attemptable. Attempting it would put an
	 * upstream request inside a live cooldown (deepening the throttle) and replace
	 * the head's genuine 529 with a later generic error.
	 */
	const everyRemainingCandidateUnattemptable = (
		candidates: Account[],
		index: number,
	): boolean => {
		const now = Date.now();
		return candidates
			.slice(index + 1)
			.every(
				(account) =>
					!isAccountAvailable(account, now) ||
					wouldSuppressProbe(account, now) ||
					isProviderOverloaded(account.provider, now, modelForAccount(account)),
			);
	};

	const applyUsageThrottling = (accounts: Account[]) => {
		if (isSyntheticProbeRequest) {
			return { available: accounts, throttled: [] as Account[] };
		}
		const settings = {
			fiveHourEnabled: config.getUsageThrottlingFiveHourEnabled(),
			weeklyEnabled: config.getUsageThrottlingWeeklyEnabled(),
		};
		if (!settings.fiveHourEnabled && !settings.weeklyEnabled) {
			return { available: accounts, throttled: [] as Account[] };
		}

		const now = Date.now();
		const available: Account[] = [];
		const throttled: Account[] = [];

		for (const account of accounts) {
			const throttleUntil = getUsageThrottleUntil(
				usageCache.get(account.id),
				settings,
				now,
				account.provider,
			);
			if (throttleUntil && throttleUntil > now) {
				throttled.push(account);
				continue;
			}
			available.push(account);
		}

		if (throttled.length > 0) {
			log.info(
				`Usage-throttled ${throttled.length} account(s): ${throttled.map((account) => account.name).join(", ")}`,
			);
		}

		return { available, throttled };
	};

	// 6b. Context-window gate — exclude Codex accounts whose mapped model
	// can't fit the request (B3). Non-codex accounts always pass. When a combo
	// slot is active for the account, the gate evaluates against the slot's
	// model override instead of the request's family model (review C3). Force-
	// routed requests are gated too — force-route bypasses account *selection*,
	// not the size safety check.
	const contextExcludedAccounts: ContextWindowExcludedBackend[] = [];

	/**
	 * Apply context-window gate to a list of accounts.
	 * @param candidates Candidate accounts to filter
	 * @param comboInfo  Optional combo slot info for model override lookup
	 * @returns Accounts that pass the gate
	 */
	const applyContextWindowGate = (
		candidates: Account[],
		comboInfo?: {
			slots: Array<{ accountId: string; modelOverride: string }>;
		} | null,
	): Account[] => {
		const passed: Account[] = [];
		for (const account of candidates) {
			if (account.provider !== "codex") {
				passed.push(account);
				continue;
			}

			// Determine the effective model for this account: combo slot
			// override if available, otherwise the request model.
			let modelForGate =
				effectiveRequestModel ??
				"claude-sonnet-4-5"; /* safe fallback — family match */
			if (comboInfo) {
				const slot = comboInfo.slots.find((s) => s.accountId === account.id);
				if (slot?.modelOverride) {
					modelForGate = slot.modelOverride;
				}
			}

			if (!codexAccountFitsRequest(account, modelForGate, gateTokenEstimate)) {
				const target = resolveCodexTargetModel(modelForGate, account);
				const window = resolveModelContextWindow(target);
				log.info(
					`Context-window gate: excluding Codex account "${account.name}" ` +
						`(model=${modelForGate}, target=${target}, window=${window ?? "unknown"}, ` +
						`estimate=${gateTokenEstimate})`,
				);
				// Track for error-response purposes (deduplicate by id)
				if (
					!contextExcludedAccounts.some(
						(excluded) => excluded.account.id === account.id,
					)
				) {
					contextExcludedAccounts.push({ account, model: modelForGate });
				}
				continue;
			}
			passed.push(account);
		}
		return passed;
	};

	// 6c. Family-weekly gate — exclude an Anthropic account for the REQUESTED
	// model family when that family's weekly quota is exhausted (limits[]) while
	// the account still has unified 5h/7d headroom for other families. This is
	// the proactive half of family-scoped rate limiting: a Fable-weekly-exhausted
	// account stays fully eligible for Opus/Sonnet instead of being sidelined
	// account-wide. Non-Anthropic accounts always pass. Combo-slot model
	// overrides are honored, mirroring the context-window gate.
	//
	// The same gate also PACES the family's weekly window before it is spent:
	// the account-wide throttle gate only knows the 5h/7d windows, so a family
	// burning its weekly quota far ahead of an even pace used to run unchecked
	// until it hit the wall. Pacing is family-scoped for the same reason the
	// exclusion is, so an overpaced Fable never delays Opus traffic on the same
	// account, and it is kept in a SEPARATE list: a paced account is throttle
	// evidence (a 529 "come back shortly"), never grounds for the family
	// exhausted 429 and its multi-day Retry-After.
	const familyWeeklyExcludedAccounts: FamilyWeeklyExcludedAccount[] = [];
	const familyWeeklyPacedAccounts: FamilyWeeklyPacedAccount[] = [];
	const applyFamilyWeeklyGate = (
		candidates: Account[],
		comboInfo?: {
			slots: Array<{ accountId: string; modelOverride: string }>;
		} | null,
	): Account[] => {
		const now = Date.now();
		// Pacing follows the same switches as the account-wide usage throttle: the
		// weekly toggle owns weekly windows, and a synthetic probe must never be
		// delayed by one.
		const pacingEnabled =
			!isSyntheticProbeRequest && config.getUsageThrottlingWeeklyEnabled();
		const passed: Account[] = [];
		for (const account of candidates) {
			if (account.provider !== "anthropic") {
				passed.push(account);
				continue;
			}
			let modelForGate = effectiveRequestModel ?? null;
			if (comboInfo) {
				const slot = comboInfo.slots.find((s) => s.accountId === account.id);
				if (slot?.modelOverride) {
					modelForGate = slot.modelOverride;
				}
			}
			const capacity = getFreshCapacity(
				usageCache,
				account.id,
				account.provider,
				now,
				FAMILY_WEEKLY_MAX_USAGE_AGE_MS,
			);
			const usageData = usageCache.get(account.id);
			const exclusion = resolveFamilyWeeklyExclusion(
				account,
				modelForGate,
				usageData,
				capacity,
				now,
			);
			if (exclusion) {
				if (
					!familyWeeklyExcludedAccounts.some(
						(excluded) => excluded.account.id === account.id,
					)
				) {
					familyWeeklyExcludedAccounts.push(exclusion);
				}
				log.debug(
					`Family-weekly gate: excluding "${account.name}" for family=${exclusion.family} ` +
						`(weekly quota exhausted, unified headroom present; ` +
						`reset ${new Date(exclusion.resetAt).toISOString()})`,
				);
				continue;
			}
			// Exclusion first, pacing second: a spent family is the exclusion
			// gate's call, and `resolveFamilyWeeklyPacing` ignores entries at or
			// above the threshold anyway.
			const paced = pacingEnabled
				? resolveFamilyWeeklyPacing(
						account,
						modelForGate,
						usageData,
						capacity,
						now,
					)
				: null;
			if (paced) {
				if (
					!familyWeeklyPacedAccounts.some(
						(entry) => entry.account.id === account.id,
					)
				) {
					familyWeeklyPacedAccounts.push(paced);
				}
				log.debug(
					`Family-weekly gate: pacing "${account.name}" for family=${paced.family} ` +
						`(weekly burn ahead of pace; resume ${new Date(paced.resumeAt).toISOString()})`,
				);
				continue;
			}
			passed.push(account);
		}
		return passed;
	};

	// 6c-bis. Family-weekly MEMO demotion — what a 429 already told us, applied
	// as the LAST word on candidate order.
	//
	// The reactive rung learns "this account's weekly window for family F is
	// spent" from a 429 and deliberately applies no account-wide cooldown, so
	// without this the finding is lost: the proactive gate re-derives eligibility
	// from a usage cache that still reports headroom, picks the same account, and
	// earns the same 429 — eighteen times in seven minutes on 2026-08-17.
	//
	// DEMOTES, never excludes. The memo is inferred state, and the gates that run
	// after the family gate can drop candidates of their own; an account removed
	// here would shrink the pool those gates then filter, so a stale memo could
	// empty it by proxy and produce a terminal — a false `context_window_exceeded`
	// 400, say — that no upstream response asked for. Reordering cannot do that.
	//
	// Applied LAST, by every caller, for the reason `applySoftDemotionReorder`
	// spells out above: stable partitions do not compose. Run before that reorder,
	// this one's [K, M] can come back as [M, K] whenever liveness keeps the
	// memo'd account and demotes the healthy sibling — promoting exactly the
	// account a 429 just refused. Nothing may run after this.
	//
	// Combos are skipped for the same reason the soft reorder skips them: their
	// slots are positional, and reordering desyncs the mapping.
	const applyFamilyMemoDemotion = (
		candidates: Account[],
		comboInfo?: {
			slots: Array<{ accountId: string; modelOverride: string }>;
		} | null,
	): Account[] => {
		if (comboInfo) return candidates;
		const now = Date.now();
		const kept: Account[] = [];
		const demoted: Account[] = [];
		for (const account of candidates) {
			const family =
				account.provider === "anthropic"
					? getModelFamily(effectiveRequestModel ?? "")
					: null;
			const resetAt = family
				? getFamilyWeeklyExhaustedUntil(account.id, family, now)
				: null;
			if (resetAt !== null) {
				demoted.push(account);
				log.debug(
					`Family-weekly memo: demoting "${account.name}" for family=${family} ` +
						`(429-learned; usage cache reports headroom or is silent; ` +
						`reset ${new Date(resetAt).toISOString()})`,
				);
				continue;
			}
			kept.push(account);
		}
		// Deliberately NOT recorded in `familyWeeklyExcludedAccounts`: that list is
		// what the zero-accounts terminals report as the reason a request could not
		// be served, and these accounts are still in the pool to be tried.
		return demoted.length > 0 ? [...kept, ...demoted] : candidates;
	};

	// Why each demoted account was demoted, for the pre-attempt-loop DEBUG line.
	// Rebuilt on every applySoftDemotionReorder() call so it always describes the
	// order the attempt loop is actually about to follow (the strategy's own
	// logSelection runs BEFORE these gates and therefore cannot show it).
	let softDemotionReasons = new Map<string, string>();

	// 6d. Composite soft-demotion reorder — SOFT demotions (never exclusions).
	// Two independent reasons move an account to the BACK of the candidate list:
	//
	//  - Shared-window reservation: a NON-protected request against an Anthropic
	//    account whose shared 5h/7d window is near its limit, reserving the tail
	//    of the shared window for the protected family (Fable).
	//  - Pool liveness: an account inside the weekly-quota tail its TIER reserves,
	//    while some peer can still absorb the traffic and the binding weekly reset
	//    is still beyond the (burn-aware) release horizon — keeping it alive as
	//    failover capacity instead of draining it to a multi-day weekly wall. The
	//    tier is per-request: traffic this account would serve as the protected
	//    family (Fable) may spend down to
	//    LIVENESS_RESERVE_PROTECTED_HEADROOM_PCT, everything else stops at
	//    LIVENESS_RESERVE_HEADROOM_PCT, so the band between them is
	//    Fable-plus-emergencies-only.
	//
	// They MUST be applied as ONE partition, not two sequential ones: two stable
	// partitions do not compose. Family produces [K, F]; a second liveness
	// partition over that result can produce [F, K], promoting an account the
	// family gate had just reserved. One partition over the UNION of both reasons
	// is the only ordering that respects both.
	//
	// This only reorders — it never drops an account, so it can't empty the pool;
	// if every candidate is demoted the original order is preserved. Combo
	// requests are skipped entirely (the attempt loop matches accounts[i] to
	// slots[i] POSITIONALLY, so reordering would desync that mapping); for the
	// non-combo path each account is classified by its EFFECTIVE (mapped) model
	// via modelForAccount, matching the demand-recording site and the overload gate.
	const applySoftDemotionReorder = (
		candidates: Account[],
		comboInfo?: {
			slots: Array<{ accountId: string; modelOverride: string }>;
		} | null,
	): Account[] => {
		// Combos pin each slot to a specific account POSITIONALLY (the attempt loop
		// matches accounts[i] to slots[i]); reordering would desync that mapping and
		// null out slot model overrides. Both demotions are fan-out routing
		// concerns, so skip combos entirely.
		if (comboInfo) return candidates;
		const now = Date.now();

		// Snapshot capacity ONCE up front so every peer count sees a consistent
		// view of the pool and the whole evaluation stays O(n) rather than O(n²)
		// cache reads.
		const capacityById = new Map(
			candidates.map((account) => [
				account.id,
				getFreshCapacity(
					usageCache,
					account.id,
					account.provider,
					now,
					FAMILY_WEEKLY_MAX_USAGE_AGE_MS,
				),
			]),
		);

		// Pass 1 — family reservation + the liveness TIER, per account.
		const familyDemote = new Map<string, boolean>();
		// Per-account liveness reserve threshold. The tier follows the LOGICAL
		// request family: modelForAccount deliberately falls back to the logical
		// Claude model when the mapped model resolves to no known family, so a Codex
		// account serving a fable-logical request (explicit or default `fable →
		// gpt-*` mapping) classifies as PROTECTED. That is intended — the tier
		// privileges the user's protected-family traffic pool-wide, so an Anthropic
		// outage that fails Fable over to Codex may spend deeper there too.
		const livenessThreshold = new Map<string, number>();
		for (const account of candidates) {
			// Classify by the account's EFFECTIVE (mapped) model — the family it will
			// actually serve — via modelForAccount, matching demand recording below and
			// the provider-overload gate. Non-combo path only, so modelForAccount's
			// initialComboInfo dependency is inert (null).
			const modelForGate = modelForAccount(account);
			familyDemote.set(
				account.id,
				resolveReservationDemotion(
					account,
					modelForGate,
					usageCache.get(account.id),
					capacityById.get(account.id) ?? null,
					getLastProtectedFamilyDemand(account.id),
					now,
				),
			);
			livenessThreshold.set(
				account.id,
				resolveLivenessReserveThreshold(
					isProtectedFamily(getModelFamily(modelForGate ?? "")),
				),
			);
		}

		const reasons = new Map<string, string>();
		const kept: Account[] = [];
		const demoted: Account[] = [];
		for (const account of candidates) {
			// Pass 2 — how many OTHER candidates could absorb this account's traffic.
			// A family-reserved peer is being held for Fable and a peer that owes a
			// capacity-restored probe admits only that one probe, so neither counts.
			// Peers are judged at the DECIDING account's tier threshold, which is what
			// keeps "reserved" and "absorbing" exactly complementary.
			const threshold =
				livenessThreshold.get(account.id) ??
				resolveLivenessReserveThreshold(false);
			let absorbablePeerCount = 0;
			for (const peer of candidates) {
				if (peer.id === account.id) continue;
				if (
					isAbsorbablePeer(
						capacityById.get(peer.id) ?? null,
						familyDemote.get(peer.id) === true,
						hasCapacityRestoredProbePending(peer.id),
						threshold,
					)
				) {
					absorbablePeerCount++;
				}
			}
			// Pass 3 — the liveness decision for this account, at its tier and with
			// its observed weekly burn (validated against the BINDING weekly window;
			// null whenever there is no usable evidence, which yields the static
			// tier-scaled horizon).
			const accountCapacity = capacityById.get(account.id) ?? null;
			const livenessDemote = resolvePoolLivenessDemotion(
				accountCapacity,
				absorbablePeerCount,
				now,
				{
					reserveThresholdPct: threshold,
					weeklySlopePctPerHour: resolveEffectiveWeeklySlope(
						account.id,
						accountCapacity,
						now,
					),
				},
			);
			const family = familyDemote.get(account.id) === true;
			if (family || livenessDemote) {
				const reason =
					family && livenessDemote
						? "both"
						: family
							? "family reservation"
							: "pool liveness";
				reasons.set(account.id, reason);
				demoted.push(account);
				log.debug(
					`Soft-demotion gate: demoting "${account.name}" (${reason}) — ` +
						(family
							? `non-protected request, shared window near limit, reserving for ${PROTECTED_FAMILY}`
							: "") +
						(family && livenessDemote ? "; " : "") +
						(livenessDemote
							? `weekly tail held as failover capacity (${absorbablePeerCount} absorbable peer(s))`
							: ""),
				);
			} else {
				kept.push(account);
			}
		}
		softDemotionReasons = reasons;
		// ONE stable partition over the union of both reasons — never drops an
		// account, only reorders.
		return [...kept, ...demoted];
	};

	return {
		modelForAccount,
		applyProviderOverloadGate,
		shouldForwardProviderOverloadIfNoCrossProviderFallback,
		everyRemainingCandidateUnattemptable,
		applyUsageThrottling,
		applyContextWindowGate,
		applyFamilyWeeklyGate,
		applySoftDemotionReorder,
		applyFamilyMemoDemotion,
		contextExcludedAccounts,
		familyWeeklyExcludedAccounts,
		familyWeeklyPacedAccounts,
		get softDemotionReasons() {
			return softDemotionReasons;
		},
	};
}
