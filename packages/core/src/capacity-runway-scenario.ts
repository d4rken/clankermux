import type {
	RunwayAssumedCredits,
	RunwayCause,
	RunwayScenarioBasis,
	RunwayScenarioDemand,
	RunwayScenarioOutcome,
	RunwayScenarioShare,
	RunwayScenarioTier,
	RunwayTierProvenance,
} from "@clankermux/types";
import {
	ANCHOR_FULL_CONFIDENCE_MIN_SPAN_MS,
	estimateWindowExhaustion,
	isLearningEstimate,
	probeDeficitOver,
	probeMarginOver,
	RUNWAY_HORIZON_MS,
	type RunwayAccountInput,
	type RunwayResetCreditBank,
	type RunwayWindowInput,
	weeklyTimeToFull,
} from "./capacity-runway";
import { TIME_CONSTANTS } from "./constants";
import { type AccountTier, tierCapacityUnits } from "./tier-capacity";

/**
 * The scenario's outcome vocabulary lives in `@clankermux/types` for the reason
 * `capacity-runway.ts` states for the current model's: the `/api/runway` wire
 * types have to reference it without making the leaf types package depend on
 * core. Re-exported here so this module is the one import site for everything
 * the scenario produces.
 */
export type {
	RunwayScenarioBasis,
	RunwayScenarioDemand,
	RunwayScenarioOutcome,
	RunwayScenarioShare,
	RunwayScenarioTier,
	RunwayTierProvenance,
};

/**
 * The demand-conserving pool runway, BESIDE {@link computeCapacityRunway} and
 * never in place of it.
 *
 * The current model holds every account's measured burn fixed for the whole
 * horizon. That is wrong in one specific direction at every roster change: when
 * an account dies its traffic does not vanish, it fails over to the survivors,
 * so their burn rises and the pool runs out EARLIER than the fixed-slope scan
 * says. The same defect, mirrored, withholds a newcomer that will in fact
 * absorb a share of the existing load.
 *
 * This model conserves demand instead of slopes:
 *
 *  1. Every account's measured burn is converted to CAPACITY UNITS per hour
 *     (percent per hour times the tier's units — percent is not additive across
 *     tiers, see `./tier-capacity`) and summed per servable class and window
 *     kind. That sum is the class demand and it never changes: it is not
 *     created when an account joins, and not destroyed when one dies.
 *  2. At every event instant the demand is re-split across the accounts that
 *     are alive AT THAT INSTANT, by an injectable {@link ShareRule} (default:
 *     equal shares, the handover's option 1), and each account's windows burn
 *     at the share its capacity implies.
 *  3. The scan walks event to event — exhaustions, resets, credit expiries —
 *     until every pooled account is dead at once, the horizon ends, or the
 *     event budget runs out.
 *
 * Readings are taken AT `now` with no observation-lag advance: from `now` on it
 * is the shared class slope that governs the window, not the account's own
 * measured one, so advancing the reading to `now` by its own slope first would
 * apply a pace this model does not believe in for the interval it is correcting
 * for.
 *
 * Demand is conserved WITHIN a class and never moved across classes: a Codex
 * account cannot serve an Anthropic request, so a dead Anthropic account's
 * traffic is not a Codex account's problem. A class whose accounts are all dead
 * simply has unserved demand.
 *
 * The caller must pass ACCOUNT-WIDE windows only (`five_hour`, `seven_day`);
 * scoped family windows (`toScopedFamilyRunwayInput` output) are not a scenario
 * source, because a family window measures a slice of the burn the class demand
 * already contains. Documented, not enforced.
 */

const HOUR_MS = TIME_CONSTANTS.HOUR;

/**
 * How far apart two event instants may sit and still be applied as ONE step.
 *
 * A projected exhaustion and the window's own reset are computed from different
 * arithmetic (`pct / slope` versus a stored instant), so a tie that is exact in
 * the model lands a float apart in the numbers. Applying them as separate steps
 * would kill the window for a whole extra cycle — and burn a reset credit — on
 * a difference of microseconds. Inline named constant — NO env var / feature
 * gate.
 */
const EVENT_TIE_TOLERANCE_MS = 1;

/**
 * Safety cap on scan events. A pathological input (a window whose whole cycle
 * is milliseconds long) would otherwise walk the horizon one reset at a time;
 * the scan stops and SAYS so rather than returning a number it did not finish
 * computing. Inline named constant — NO env var / feature gate.
 */
export const MAX_SCENARIO_EVENTS = 100_000;

/**
 * Whether an account absorbs load, or only contributed the burn it measured.
 *
 * `"demand-only"` is a paused or removed account: its measured burn is real and
 * stays in the class demand (that is where the survivors' extra load comes
 * from), but it never absorbs a share, is never alive, and never appears in a
 * cause.
 */
export type RunwayScenarioPresence = "alive" | "demand-only";

export interface RunwayScenarioAccountInput extends RunwayAccountInput {
	/** Servable class (see `servableClassFor(provider).classId`); demand is conserved WITHIN a class. */
	demandClass: string;
	/** `null` = tier unknown → excluded and disclosed. Ignored for `unmetered`. */
	tier: AccountTier | null;
	/** Default `"alive"`. See {@link RunwayScenarioPresence}. */
	presence?: RunwayScenarioPresence;
}

/** One alive account as the share rule sees it, at the instant of an assignment. */
export interface ShareCandidate {
	accountId: string;
	demandClass: string;
	/** null for unmetered accounts. */
	capacityUnits: number | null;
	windows: ReadonlyArray<{ windowKind: string; utilizationPct: number }>;
}

/**
 * Non-negative weight per candidate, same length and order.
 *
 * Called once per class per assignment with the accounts alive at that instant,
 * so a rule may depend on the current utilizations. A violated contract (wrong
 * length, a negative/NaN weight, or all-zero weights while the class still has
 * demand to place) throws: that is a programming error in the injected rule,
 * never a property of the data.
 */
export type ShareRule = (
	candidates: readonly ShareCandidate[],
) => readonly number[];

/** Option 1 of the handover: every alive account of the class gets `w = 1`. */
export const equalShareRule: ShareRule = (candidates) =>
	candidates.map(() => 1);

export interface RunwayScenarioOptions {
	/** Default {@link equalShareRule}. */
	shareRule?: ShareRule;
	/**
	 * Default {@link tierCapacityUnits}. Must return `null` (unknown tier, which
	 * the scan discloses) or a finite number > 0; anything else throws.
	 */
	capacityUnits?: (tier: AccountTier) => number | null;
	/** Default true. Same meaning as {@link computeCapacityRunway}'s. */
	probePaceMargin?: boolean;
	/** Default {@link MAX_SCENARIO_EVENTS}. A test seam for the budget branches. */
	maxEvents?: number;
}

/** A window as the scan carries it, mutated in place across the walk. */
interface ScanWindow {
	kind: string;
	pct: number;
	windowStartMs: number | null;
	resetsAtMs: number | null;
	durationMs: number | null;
	/** Non-null exactly while the window is spent. */
	deadUntilMs: number | null;
	/**
	 * An `unstarted` window: the provider's `resets_at` is a sliding placeholder
	 * and NOT a deadline, so the window carries no reset until the first positive
	 * slope pins it (see {@link isUnstartedWindow}).
	 */
	inactive: boolean;
	/** %/hour, assigned at every assignment. */
	slope: number;
}

/** What the setup derived for one window, before any scan state exists. */
interface PreparedWindow {
	kind: string;
	pct: number;
	windowStartMs: number | null;
	resetsAtMs: number | null;
	durationMs: number | null;
	deadUntilMs: number | null;
	inactive: boolean;
	/** Withholds its account when its kind carries no measured class demand. */
	learning: boolean;
	/**
	 * Capacity units per hour this window contributes to its class demand, or
	 * `null` when it contributes nothing. A contribution of `0` is EVIDENCE (a
	 * measured flat slope) and marks the kind measured; `null` does not.
	 */
	contribution: number | null;
}

type PreparedStatus =
	/** In the pool: alive presence, readable, capacity known, not withheld. */
	| "pooled"
	/** Metered, capacity known, paused/removed: demand source only. */
	| "demand-only"
	/** Metered with no capacity assignable. */
	| "unknown-tier"
	/** Metered with no usable window. */
	| "unreadable"
	/** Alive, but a learning window's kind carries no measured class demand. */
	| "withheld"
	/** Unmetered and demand-only: no burn to contribute, no load to absorb. */
	| "dropped";

interface PreparedAccount {
	accountId: string;
	demandClass: string;
	alivePresence: boolean;
	unmetered: boolean;
	tier: AccountTier | null;
	/** null for unmetered accounts and for an unresolved tier. */
	capacityUnits: number | null;
	windows: PreparedWindow[];
	bank: RunwayResetCreditBank | null;
	status: PreparedStatus;
}

/** One pooled account's mutable state for a single scan. */
interface ScanAccount {
	accountId: string;
	demandClass: string;
	capacityUnits: number | null;
	unmetered: boolean;
	windows: ScanWindow[];
	/** Earliest-expiry first, unknown expiry last — `applyResetCredits`' order. */
	credits: Array<{ expiresAtMs: number | null }>;
	onWeeklyLimitEnabled: boolean;
	onExpiryEnabled: boolean;
	consumed: number;
}

type ScanEventKind = "reset" | "expiry" | "exhaust";

interface ScanEvent {
	kind: ScanEventKind;
	atMs: number;
	account: ScanAccount;
	window: ScanWindow;
	credit?: { expiresAtMs: number | null };
}

type ScanResult =
	| { kind: "hit"; t: number; causes: RunwayCause[] }
	| { kind: "clear" }
	| { kind: "budget" };

/** What only the pace-1 scan may report. */
interface BaselineCapture {
	/** `w_j/Σw` at each account's FIRST alive assignment. */
	shares: Map<string, number>;
	assumedCredits: RunwayAssumedCredits[];
}

const finiteOrNull = (value: number | null | undefined): number | null =>
	value != null && Number.isFinite(value) ? value : null;

/**
 * Sorted like `applyResetCreditsToWeeklyIntervals` sorts them, so an expiring
 * credit is never wasted on an exhaustion a later credit could have covered.
 */
function sortedCredits(
	bank: RunwayResetCreditBank,
): Array<{ expiresAtMs: number | null }> {
	return [...bank.credits].sort((a, b) => {
		if (a.expiresAtMs == null && b.expiresAtMs == null) return 0;
		if (a.expiresAtMs == null) return 1;
		if (b.expiresAtMs == null) return -1;
		return a.expiresAtMs - b.expiresAtMs;
	});
}

/** Consume the earliest credit still applicable at `t`, or report none was. */
function takeCreditAt(account: ScanAccount, t: number): boolean {
	const index = account.credits.findIndex(
		(credit) => credit.expiresAtMs == null || credit.expiresAtMs > t,
	);
	if (index === -1) return false;
	account.credits.splice(index, 1);
	return true;
}

/**
 * How long the pool can keep going before every account in it is out of quota
 * at once, WITH the load of the dead redistributed onto the living.
 *
 * See the module doc for the model. The outcome is the current model's
 * vocabulary plus {@link RunwayScenarioBasis}: what the scan assumed to get
 * there, so no surface can present a redistributed runway as a measurement.
 *
 * Nothing here feeds pool sizing or any other surface that treats a tier as a
 * label; the capacity weights are declared assumptions and stay inside this
 * model.
 */
export function computeCapacityRunwayScenario(
	accounts: RunwayScenarioAccountInput[],
	now: number,
	horizonMs: number = RUNWAY_HORIZON_MS,
	options?: RunwayScenarioOptions,
): RunwayScenarioOutcome {
	const emptyBasis: RunwayScenarioBasis = {
		basis: "demand-conserving",
		demandUnitsPerHour: [],
		tiers: [],
		includedLearningAccounts: [],
		unknownTierAccountIds: [],
		demandOnlyAccountIds: [],
	};
	if (accounts.length === 0) return { kind: "no-accounts", ...emptyBasis };

	const horizonEndMs = now + horizonMs;
	const shareRule = options?.shareRule ?? equalShareRule;
	const capacityUnitsOf = options?.capacityUnits ?? tierCapacityUnits;
	const maxEvents = options?.maxEvents ?? MAX_SCENARIO_EVENTS;

	// ── Setup ────────────────────────────────────────────────────────────────
	// Per account: capacity, window classification, and the burn each window
	// contributes to its class demand. Contributions are collected from every
	// account the scan did not EXCLUDE (unknown tier, unreadable) — including one
	// later withheld by the strict unmeasured rule, whose measured burn is real
	// demand even though its projection is not usable.
	const prepared: PreparedAccount[] = [];
	/** class → kind → units/hour. A key's PRESENCE is "this kind is measured". */
	const demand = new Map<string, Map<string, number>>();

	for (const account of accounts) {
		const alivePresence = (account.presence ?? "alive") === "alive";
		if (account.unmetered) {
			// No account-wide quota window exists, so this account is alive for the
			// whole horizon and burns nothing we can measure. It still takes a share
			// of its class: it is a routing target, and pretending otherwise would
			// hand its share to the metered accounts.
			prepared.push({
				accountId: account.accountId,
				demandClass: account.demandClass,
				alivePresence,
				unmetered: true,
				tier: null,
				capacityUnits: null,
				windows: [],
				bank: null,
				status: alivePresence ? "pooled" : "dropped",
			});
			continue;
		}

		const units = account.tier === null ? null : capacityUnitsOf(account.tier);
		if (units !== null && (!Number.isFinite(units) || units <= 0)) {
			throw new Error(
				`capacityUnits must return null or a finite number > 0; got ${units} for account ${account.accountId}`,
			);
		}
		if (units === null) {
			// Never weighted 1: a made-up capacity would silently move demand.
			prepared.push({
				accountId: account.accountId,
				demandClass: account.demandClass,
				alivePresence,
				unmetered: false,
				tier: account.tier,
				capacityUnits: null,
				windows: [],
				bank: account.codexResetCredits ?? null,
				status: "unknown-tier",
			});
			continue;
		}

		const windows: PreparedWindow[] = [];
		for (const window of account.windows) {
			const preparedWindow = prepareWindow(window, units, now, horizonEndMs);
			if (preparedWindow === null) continue;
			windows.push(preparedWindow);
			if (preparedWindow.contribution !== null) {
				const perClass = demand.get(account.demandClass) ?? new Map();
				demand.set(account.demandClass, perClass);
				perClass.set(
					preparedWindow.kind,
					(perClass.get(preparedWindow.kind) ?? 0) +
						preparedWindow.contribution,
				);
			}
		}

		prepared.push({
			accountId: account.accountId,
			demandClass: account.demandClass,
			alivePresence,
			unmetered: false,
			tier: account.tier,
			capacityUnits: units,
			windows,
			bank: account.codexResetCredits ?? null,
			status:
				windows.length === 0
					? "unreadable"
					: alivePresence
						? "pooled"
						: "demand-only",
		});
	}

	// ── Strict unmeasured rule ───────────────────────────────────────────────
	// The analogue of the current model's strict learning rule, narrowed to what
	// this scenario cannot do: a learning window has no slope of its own, so it
	// borrows its class's — and when the class never measured that kind there is
	// nothing to borrow. Learning windows ONLY. An `already-exhausted` window is
	// a known fact rather than a projection, so it never withholds its account;
	// with no measured demand for its kind it simply holds slope 0 after its
	// reset, which is what the current model does with a null-slope exhausted
	// window.
	for (const account of prepared) {
		if (account.status !== "pooled") continue;
		const borrowsUnmeasured = account.windows.some(
			(window) =>
				window.learning && !demand.get(account.demandClass)?.has(window.kind),
		);
		if (borrowsUnmeasured) account.status = "withheld";
	}

	const pooled = prepared.filter((account) => account.status === "pooled");
	const unprojectableAccountIds = prepared
		.filter(
			(account) =>
				account.alivePresence &&
				(account.status === "unknown-tier" ||
					account.status === "unreadable" ||
					account.status === "withheld"),
		)
		.map((account) => account.accountId);
	const learningAccountIds = prepared
		.filter((account) => account.status === "withheld")
		.map((account) => account.accountId);
	const unknownTierAccountIds = prepared
		.filter((account) => account.status === "unknown-tier")
		.map((account) => account.accountId);
	const demandOnlyAccountIds = prepared
		.filter(
			(account) =>
				account.status === "demand-only" &&
				account.windows.some((window) => window.contribution !== null),
		)
		.map((account) => account.accountId);
	const tiers: RunwayScenarioTier[] = prepared.flatMap((account) => {
		const tier = account.tier;
		const capacityUnits = account.capacityUnits;
		if (tier === null || capacityUnits === null) return [];
		return [
			{
				accountId: account.accountId,
				provider: tier.provider,
				planTier: tier.planTier,
				rateLimitTier: tier.rateLimitTier,
				capacityUnits,
				provenance: tier.provenance,
			},
		];
	});
	const demandUnitsPerHour: RunwayScenarioDemand[] = [...demand.entries()]
		.flatMap(([demandClass, perKind]) =>
			[...perKind.entries()].map(([windowKind, unitsPerHour]) => ({
				demandClass,
				windowKind,
				unitsPerHour,
			})),
		)
		.sort(
			(a, b) =>
				a.demandClass.localeCompare(b.demandClass) ||
				a.windowKind.localeCompare(b.windowKind),
		);

	const basisOf = (
		includedLearningAccounts: RunwayScenarioShare[],
		eventBudgetExhausted?: "baseline" | "probe",
	): RunwayScenarioBasis => ({
		basis: "demand-conserving",
		demandUnitsPerHour,
		tiers,
		includedLearningAccounts,
		unknownTierAccountIds,
		demandOnlyAccountIds,
		...(eventBudgetExhausted ? { eventBudgetExhausted } : {}),
	});

	if (pooled.length === 0) {
		// Nothing absorbs the demand, so there is no pool to scan — the same
		// "insufficient evidence, not infinity" the current model reports.
		return {
			kind: "unknown",
			...(learningAccountIds.length > 0 ? { learningAccountIds } : {}),
			...basisOf([]),
		};
	}

	// Classes in first-appearance order, so an injected rule sees a stable
	// sequence of assignments across a scan.
	const classes: string[] = [];
	for (const account of pooled) {
		if (!classes.includes(account.demandClass)) {
			classes.push(account.demandClass);
		}
	}

	// ── The scan ─────────────────────────────────────────────────────────────
	const runScan = (
		pace: number,
		capture: BaselineCapture | null,
	): ScanResult => {
		const state: ScanAccount[] = pooled.map((account) => ({
			accountId: account.accountId,
			demandClass: account.demandClass,
			capacityUnits: account.capacityUnits,
			unmetered: account.unmetered,
			windows: account.windows.map((window) => ({
				kind: window.kind,
				pct: window.pct,
				windowStartMs: window.windowStartMs,
				resetsAtMs: window.resetsAtMs,
				durationMs: window.durationMs,
				deadUntilMs: window.deadUntilMs,
				inactive: window.inactive,
				slope: 0,
			})),
			credits: account.bank === null ? [] : sortedCredits(account.bank),
			onWeeklyLimitEnabled: account.bank?.onWeeklyLimitEnabled ?? false,
			onExpiryEnabled: account.bank?.onExpiryEnabled ?? false,
			consumed: 0,
		}));

		const finish = (result: ScanResult): ScanResult => {
			if (capture !== null) {
				for (const account of state) {
					if (account.consumed > 0) {
						capture.assumedCredits.push({
							accountId: account.accountId,
							count: account.consumed,
						});
					}
				}
			}
			return result;
		};

		// Setup-time weekly-credit redemption, the parity with
		// `applyResetCreditsToWeeklyIntervals`: the real applier redeems against
		// the CURRENT dead span, so a window already exhausted at `now` is revived
		// before the alive check and before the first assignment — the revived
		// account takes a share from `now`.
		for (const account of state) {
			if (!account.onWeeklyLimitEnabled) continue;
			for (const window of account.windows) {
				// Dead at 100% before a single event has run: an `already-exhausted`
				// reading, the only thing the setup can find spent.
				if (window.kind !== "seven_day" || window.deadUntilMs === null)
					continue;
				if (window.pct < 100) continue;
				if (!takeCreditAt(account, now)) continue;
				window.pct = 0;
				window.deadUntilMs = null;
				account.consumed++;
			}
		}

		const isAlive = (account: ScanAccount): boolean =>
			account.unmetered ||
			account.windows.every((window) => window.deadUntilMs === null);

		let t = now;
		let events = 0;
		for (;;) {
			const alive = state.filter(isAlive);
			if (alive.length === 0) {
				const causes: RunwayCause[] = [];
				for (const account of state) {
					for (const window of account.windows) {
						if (window.deadUntilMs !== null) {
							causes.push({
								accountId: account.accountId,
								windowKind: window.kind,
							});
						}
					}
				}
				return finish({ kind: "hit", t, causes });
			}

			// Assignment: the class demand, split over the accounts alive right now.
			for (const account of state) {
				if (isAlive(account)) continue;
				for (const window of account.windows) window.slope = 0;
			}
			for (const demandClass of classes) {
				const candidates = alive.filter(
					(account) => account.demandClass === demandClass,
				);
				if (candidates.length === 0) continue;
				const perKind = demand.get(demandClass);
				const weights = shareRule(
					candidates.map((account) => ({
						accountId: account.accountId,
						demandClass: account.demandClass,
						capacityUnits: account.capacityUnits,
						windows: account.windows.map((window) => ({
							windowKind: window.kind,
							utilizationPct: window.pct,
						})),
					})),
				);
				if (weights.length !== candidates.length) {
					throw new Error(
						`shareRule returned ${weights.length} weights for ${candidates.length} candidates of class ${demandClass}`,
					);
				}
				let total = 0;
				for (const weight of weights) {
					if (!Number.isFinite(weight) || weight < 0) {
						throw new Error(
							`shareRule returned a weight that is not a finite number >= 0 (${weight}) for class ${demandClass}`,
						);
					}
					total += weight;
				}
				if (total === 0) {
					const hasDemand = [...(perKind?.values() ?? [])].some(
						(units) => units > 0,
					);
					if (hasDemand) {
						throw new Error(
							`shareRule returned all-zero weights for class ${demandClass}, which still has demand to place`,
						);
					}
				}
				candidates.forEach((account, index) => {
					const share = total > 0 ? weights[index] / total : 0;
					if (capture !== null && !capture.shares.has(account.accountId)) {
						capture.shares.set(account.accountId, share);
					}
					for (const window of account.windows) {
						const units = perKind?.get(window.kind);
						window.slope =
							units === undefined || account.capacityUnits === null
								? 0
								: (units * pace * share) / account.capacityUnits;
						// An unstarted window's placeholder reset is not a deadline; the
						// first burn is what pins the real cycle.
						if (window.inactive && window.slope > 0) {
							window.inactive = false;
							window.windowStartMs = t;
							window.resetsAtMs =
								window.durationMs === null ? null : t + window.durationMs;
						}
					}
				});
			}

			// Candidate events, strictly ahead of the clock and inside the horizon.
			const candidates: ScanEvent[] = [];
			const push = (event: ScanEvent): void => {
				if (event.atMs > t && event.atMs < horizonEndMs) candidates.push(event);
			};
			for (const account of state) {
				const accountAlive = isAlive(account);
				for (const window of account.windows) {
					if (accountAlive && window.slope > 0 && window.pct < 100) {
						push({
							kind: "exhaust",
							atMs: t + ((100 - window.pct) / window.slope) * HOUR_MS,
							account,
							window,
						});
					}
					if (!window.inactive && window.resetsAtMs !== null) {
						push({
							kind: "reset",
							atMs: window.resetsAtMs,
							account,
							window,
						});
					}
					if (
						account.onExpiryEnabled &&
						window.kind === "seven_day" &&
						window.deadUntilMs !== null
					) {
						const deadUntilMs = window.deadUntilMs;
						// Credits are expiry-sorted, so the first match is the earliest.
						const credit = account.credits.find(
							(entry) =>
								entry.expiresAtMs != null &&
								entry.expiresAtMs > t &&
								entry.expiresAtMs < deadUntilMs,
						);
						if (credit?.expiresAtMs != null) {
							push({
								kind: "expiry",
								atMs: credit.expiresAtMs,
								account,
								window,
								credit,
							});
						}
					}
				}
			}
			if (candidates.length === 0) return finish({ kind: "clear" });

			const next = Math.min(...candidates.map((event) => event.atMs));
			const batch = candidates.filter(
				(event) => event.atMs <= next + EVENT_TIE_TOLERANCE_MS,
			);
			// The clock lands on the LATEST instant of the batch, never an earlier
			// one: with `t = next`, every batched tie would leave the clock behind
			// the reset schedule by the width of the tie, and that offset
			// accumulates across cycles until a sub-tolerance tie becomes a real
			// dead sliver.
			const batchEnd = Math.max(...batch.map((event) => event.atMs));

			for (const account of state) {
				for (const window of account.windows) {
					if (window.slope <= 0) continue;
					window.pct = Math.min(
						100,
						window.pct + (window.slope * (batchEnd - t)) / HOUR_MS,
					);
				}
			}

			const touched = new Set<ScanWindow>();
			for (const event of batch) {
				if (event.kind !== "reset") continue;
				const window = event.window;
				window.pct = 0;
				window.deadUntilMs = null;
				if (window.durationMs === null) {
					// One-time recovery: nothing says when the next cycle would start,
					// so a later exhaustion holds the window dead to the horizon.
					window.resetsAtMs = null;
				} else {
					// `event.atMs` IS this window's reset instant (that is what put the
					// event on the list), so the next cycle starts there rather than at
					// the batch clock.
					window.windowStartMs = event.atMs;
					window.resetsAtMs = event.atMs + window.durationMs;
				}
				touched.add(window);
			}
			for (const event of batch) {
				if (event.kind !== "expiry" || event.credit === undefined) continue;
				const index = event.account.credits.indexOf(event.credit);
				if (index === -1) continue;
				event.account.credits.splice(index, 1);
				event.window.pct = 0;
				event.window.deadUntilMs = null;
				event.account.consumed++;
				touched.add(event.window);
			}
			for (const event of batch) {
				if (event.kind !== "exhaust") continue;
				// A tie between a projected exhaustion and the window's own reset or
				// revival is NOT a dead span — the current model's half-open
				// [exhaust, reset) yields nothing there either. Applying it would kill
				// the window for a whole extra cycle and burn a credit.
				if (touched.has(event.window)) continue;
				const window = event.window;
				window.pct = 100;
				window.deadUntilMs = window.resetsAtMs ?? horizonEndMs;
				if (
					window.kind === "seven_day" &&
					event.account.onWeeklyLimitEnabled &&
					takeCreditAt(event.account, next)
				) {
					window.pct = 0;
					window.deadUntilMs = null;
					event.account.consumed++;
				}
			}

			t = batchEnd;
			events++;
			if (events > maxEvents) return finish({ kind: "budget" });
		}
	};

	const capture: BaselineCapture = { shares: new Map(), assumedCredits: [] };
	const baseline = runScan(1, capture);
	const includedLearningAccounts: RunwayScenarioShare[] = pooled
		.filter((account) => account.windows.some((window) => window.learning))
		.map((account) => ({
			accountId: account.accountId,
			// Never alive inside the horizon → no share was ever assigned to it.
			shareOfClass: capture.shares.get(account.accountId) ?? 0,
		}));
	const assumedCredits = capture.assumedCredits;

	if (baseline.kind === "budget") {
		return {
			kind: "unknown",
			...(learningAccountIds.length > 0 ? { learningAccountIds } : {}),
			...basisOf(includedLearningAccounts, "baseline"),
		};
	}

	if (baseline.kind === "hit" && baseline.t === now) {
		return {
			kind: "out-now",
			causes: baseline.causes,
			unprojectableAccountIds,
			...(learningAccountIds.length > 0 ? { learningAccountIds } : {}),
			...(assumedCredits.length > 0
				? { assumedResetCredits: assumedCredits }
				: {}),
			...basisOf(includedLearningAccounts),
		};
	}

	// An unmetered account is never out of quota at any pace, so no probed
	// multiplier can flip the verdict and every step would rescan for nothing —
	// the current model's rule, unchanged.
	const probeable =
		options?.probePaceMargin !== false &&
		!pooled.some((account) => account.unmetered);
	let probeBudgetExhausted = false;

	if (baseline.kind === "hit") {
		const paceDeficit = probeable
			? probeDeficitOver((pace) => {
					const result = runScan(pace, null);
					if (result.kind === "budget") {
						probeBudgetExhausted = true;
						return "abort";
					}
					return result.kind === "hit";
				})
			: null;
		return {
			kind: "runway",
			exhaustsAtMs: baseline.t,
			durationMs: baseline.t - now,
			causes: baseline.causes,
			unprojectableAccountIds,
			...(learningAccountIds.length > 0 ? { learningAccountIds } : {}),
			...(assumedCredits.length > 0
				? { assumedResetCredits: assumedCredits }
				: {}),
			...(paceDeficit !== null ? { paceDeficit } : {}),
			...basisOf(
				includedLearningAccounts,
				probeBudgetExhausted ? "probe" : undefined,
			),
		};
	}

	const paceMargin = probeable
		? probeMarginOver((pace) => {
				const result = runScan(pace, null);
				if (result.kind === "budget") {
					probeBudgetExhausted = true;
					return "abort";
				}
				return result.kind === "hit" ? result.t : null;
			})
		: null;
	return {
		kind: "beyond-horizon",
		horizonMs,
		unprojectableAccountIds,
		...(learningAccountIds.length > 0 ? { learningAccountIds } : {}),
		...(assumedCredits.length > 0
			? { assumedResetCredits: assumedCredits }
			: {}),
		...(paceMargin !== null ? { paceMargin } : {}),
		...basisOf(
			includedLearningAccounts,
			probeBudgetExhausted ? "probe" : undefined,
		),
	};
}

/**
 * One window's scan state and its demand contribution, or `null` when the
 * window carries no usable evidence at all (`buildPool` skips the same ones).
 *
 * `estimateWindowExhaustion` is the single source of the classification, so the
 * scenario and the current model cannot disagree about what a reading means.
 */
function prepareWindow(
	window: RunwayWindowInput,
	capacityUnits: number,
	now: number,
	horizonEndMs: number,
): PreparedWindow | null {
	const estimate = estimateWindowExhaustion(
		{
			utilizationPct: window.utilizationPct,
			resetsAtMs: window.resetsAtMs,
			windowStartMs: window.windowStartMs,
			prediction: window.prediction,
			lifetimeConfidence: window.lifetimeConfidence,
			observedAtMs: window.observedAtMs,
			anchor: window.anchor,
		},
		now,
	);
	if (estimate.source === "none") return null;

	const startMs = finiteOrNull(window.windowStartMs);
	const resetsAtMs = finiteOrNull(window.resetsAtMs);

	if (estimate.source === "already-exhausted") {
		// Decided BEFORE the estimator's structural guards, so the timestamps are
		// unvalidated and the schedule is derived here.
		const liveReset = resetsAtMs !== null && resetsAtMs > now;
		const nextResetMs = liveReset ? resetsAtMs : null;
		const durationMs =
			nextResetMs !== null && startMs !== null && nextResetMs - startMs > 0
				? nextResetMs - startMs
				: null;
		// An exhausted window with a live reset still MEASURED the burn that filled
		// it, and that traffic is on the survivors now — dropping it would make the
		// scenario optimistic exactly where the current model is not. Same helper
		// the credit model re-exhausts from, so the two cannot disagree about the
		// observed pace. A stale or unknown reset says the reading itself is stale,
		// and a sub-hour fill is the one-hour evidence floor `isLearningEstimate`
		// applies everywhere else.
		let contribution: number | null = null;
		if (liveReset) {
			const fillMs = weeklyTimeToFull(window, estimate, now);
			if (fillMs !== null && fillMs >= ANCHOR_FULL_CONFIDENCE_MIN_SPAN_MS) {
				contribution = (100 / fillMs) * HOUR_MS * capacityUnits;
			}
		}
		return {
			kind: window.windowKind,
			pct: 100,
			windowStartMs: startMs,
			resetsAtMs: nextResetMs,
			durationMs,
			deadUntilMs: nextResetMs ?? horizonEndMs,
			inactive: false,
			learning: false,
			contribution,
		};
	}

	// Past `already-exhausted` the estimator's structural guards have run, so
	// both instants are known, finite, ordered, and the reset is in the future.
	const durationMs =
		resetsAtMs !== null && startMs !== null && resetsAtMs - startMs > 0
			? resetsAtMs - startMs
			: null;

	if (estimate.source === "unstarted") {
		return {
			kind: window.windowKind,
			pct: 0,
			windowStartMs: startMs,
			// The supplied reset is a sliding placeholder, not a deadline: the
			// window carries none until the first assignment pins it.
			resetsAtMs: null,
			durationMs,
			deadUntilMs: null,
			inactive: true,
			learning: true,
			contribution: null,
		};
	}

	const learning = isLearningEstimate(estimate, window.utilizationPct);
	return {
		kind: window.windowKind,
		pct: learning ? Math.max(0, window.utilizationPct) : window.utilizationPct,
		windowStartMs: startMs,
		resetsAtMs,
		durationMs,
		deadUntilMs: null,
		inactive: false,
		learning,
		// A learning window measured no burn to conserve; it burns at whatever
		// share of the class demand it is assigned. A projecting source always
		// carries a slope (`?? 0` is unreachable), and a measured slope of 0 is
		// evidence, so it counts as a contribution.
		contribution: learning
			? null
			: (estimate.slopePctPerHour ?? 0) * capacityUnits,
	};
}
