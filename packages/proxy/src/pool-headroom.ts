/**
 * The pooled headroom figure a response's rate-limit headers are restated with.
 *
 * `@clankermux/core`'s `pool-headroom-headers` owns the wire format; this module
 * owns the number. It answers one question for the serving account's servable
 * class: across the accounts that could serve this request, what is the MOST
 * headroom any of them still has?
 *
 * Best-not-worst is the whole point. The proxy fails over, so the pool survives
 * while ANY member has room; reporting the worst member, or an average, would
 * raise an alarm for a spent account the router is already avoiding. The figure
 * reaches zero only when every member is spent, which is exactly when the next
 * request cannot be served.
 *
 * Everything here is synchronous and in-memory — cache peeks over at most a few
 * dozen accounts — because it runs on the way out of every proxied response.
 *
 * Two deliberate choices worth not undoing:
 *
 *  - **`peekWithAge`, never `getFreshCapacity`.** That helper reads through the
 *    EVICTING `get`/`getAge` accessors. A display-only observer must not evict
 *    cache entries that account selection depends on; `peek-primary.ts` reaches
 *    for the same non-evicting pair for the same reason.
 *
 *  - **Per-window presence, never `CapacitySignal`.** `sessionHeadroom` and
 *    `weeklyHeadroom` both report 100 when their window is ABSENT, which is
 *    indistinguishable from a window that is wide open. Taking a max over those
 *    would let an account with no window at all declare the pool empty-handedly
 *    unconstrained. `extractFiveHour`/`extractSevenDay` keep absence and zero
 *    distinct, which is the distinction this computation turns on.
 */
import {
	extractFiveHour,
	extractSevenDay,
	extractUnifiedClaimReadings,
	FIVE_HOUR_ELIGIBLE_PROVIDERS,
	type PooledWindowFigure,
	type PoolHeadroomFigures,
	SEVEN_DAY_ELIGIBLE_PROVIDERS,
	servableClassFor,
} from "@clankermux/core";
import { usageCache } from "@clankermux/providers";
import type { Account, FullUsageData, RequestMeta } from "@clankermux/types";

/**
 * How stale a cache entry may be and still count. Deliberately the same bound
 * the family-weekly gate trusts on the request path (2x the poll interval)
 * rather than the cache's own 10-minute TTL: a figure shown to a user should
 * not be built from evidence too old for routing to act on.
 */
const MAX_USAGE_AGE_MS = 180_000;

/** codex reports window length in minutes; a week is 10080 of them. */
const WEEKLY_WINDOW_MINUTES = 10_080;

/**
 * The post-gate candidate accounts, stashed per request.
 *
 * A WeakMap keyed on the live `RequestMeta` object, mirroring the combo-slot
 * and native-responses side channels: it cannot be spoofed by a client header,
 * cannot outlive the request, and adds no field to a type that a dozen call
 * sites construct.
 *
 * Absence is meaningful and is the safe default. The forced-account and
 * unauthenticated paths never run selection, so they never stash anything, and
 * a response whose request has no entry is forwarded with its headers exactly
 * as they arrived.
 */
const candidatesByRequest = new WeakMap<RequestMeta, readonly Account[]>();

export function setPoolHeadroomCandidates(
	meta: RequestMeta,
	accounts: readonly Account[],
): void {
	candidatesByRequest.set(meta, accounts);
}

export function getPoolHeadroomCandidates(
	meta: RequestMeta,
): readonly Account[] | null {
	return candidatesByRequest.get(meta) ?? null;
}

type WindowKind = "session" | "weekly";

/** One member's contribution: a reading, or "we cannot speak for this one". */
type MemberReading = { pct: number; resetMs: number | null } | "unknown";

/**
 * Read one window for one account out of the usage cache.
 *
 * Returns "unknown" rather than a value in every case where we lack positive
 * evidence — no cache entry, an entry too old to act on, a payload shape whose
 * window we cannot locate, a provider that reports no such window, or a codex
 * account holding purchased credits (which let it serve past 100% while
 * reporting 100%, so its reading cannot bound anything).
 */
function readWindow(account: Account, kind: WindowKind): MemberReading {
	const eligible =
		kind === "session"
			? FIVE_HOUR_ELIGIBLE_PROVIDERS
			: SEVEN_DAY_ELIGIBLE_PROVIDERS;
	if (!eligible.has(account.provider)) return "unknown";

	const entry = usageCache.peekWithAge(account.id);
	if (entry === null || entry.ageMs > MAX_USAGE_AGE_MS) return "unknown";

	const credits = (entry.data as { codexCredits?: unknown }).codexCredits as
		| { hasCredits?: boolean; unlimited?: boolean }
		| null
		| undefined;
	if (kind === "weekly" && (credits?.hasCredits || credits?.unlimited)) {
		return "unknown";
	}

	// `AnyUsageData` is the cache's union and is wider than the extractors'
	// input by one provider shape (MiniMax) they do not model. Both extractors
	// dispatch on shape and return null for anything they cannot read, so an
	// unmodelled payload lands on the "unknown" branch below rather than being
	// misread — which is exactly what the widening cast has to guarantee.
	const data = entry.data as FullUsageData;
	const extracted =
		kind === "session" ? extractFiveHour(data) : extractSevenDay(data);
	if (extracted === null || extracted.pct === null) return "unknown";

	return { pct: extracted.pct, resetMs: extracted.resetMs };
}

/**
 * The serving account's own reading, straight off the response that is being
 * forwarded. Strictly fresher than anything the cache can hold for it, and it
 * makes the degenerate case provable: a one-account pool with a cold cache
 * restates exactly the numbers upstream sent.
 */
function readWire(headers: Headers, kind: WindowKind): MemberReading | null {
	const claim = kind === "session" ? "5h" : "7d";
	const unified = extractUnifiedClaimReadings(headers).find(
		(reading) => reading.claim === claim,
	);
	// Unified utilization is a 0..1 fraction; every figure here is a percent.
	if (unified?.utilization != null) {
		return { pct: unified.utilization * 100, resetMs: unified.resetMs };
	}

	if (kind === "session") return null;
	for (const slot of ["primary", "secondary"] as const) {
		const minutes = Number(headers.get(`x-codex-${slot}-window-minutes`));
		if (minutes !== WEEKLY_WINDOW_MINUTES) continue;
		const used = Number(headers.get(`x-codex-${slot}-used-percent`));
		if (!Number.isFinite(used)) return null;
		const resetSec = Number(headers.get(`x-codex-${slot}-reset-at`));
		return {
			pct: used,
			resetMs:
				Number.isFinite(resetSec) && resetSec > 0 ? resetSec * 1000 : null,
		};
	}
	return null;
}

/** Keep whichever of two readings shows more headroom. */
function better(a: MemberReading, b: MemberReading | null): MemberReading {
	if (b === null) return a;
	if (a === "unknown") return b;
	if (b === "unknown") return a;
	return b.pct < a.pct ? b : a;
}

function foldWindow(
	readings: readonly MemberReading[],
	nowMs: number,
): PooledWindowFigure | null {
	const known = readings.filter(
		(reading): reading is Exclude<MemberReading, "unknown"> =>
			reading !== "unknown",
	);
	if (known.length === 0) return null;

	const lowestUsed = Math.min(...known.map((reading) => reading.pct));
	// Reset comes from the members TIED at the winning headroom, not the soonest
	// across the class. The pair (utilization, reset) is consumed together to
	// derive pacing, so pairing the best member's figure with an unrelated
	// sibling's imminent reset would tell the client it is nearly through a
	// window it has barely started. When the class is fully spent every member
	// ties at zero, which is exactly when "soonest reset" is the right answer.
	const winners = known.filter((reading) => reading.pct <= lowestUsed + 1e-9);
	const futureResets = winners
		.map((reading) => reading.resetMs)
		.filter(
			(resetMs): resetMs is number => resetMs !== null && resetMs > nowMs,
		);

	return {
		headroomPct: Math.max(0, Math.min(100, 100 - lowestUsed)),
		resetMs: futureResets.length === 0 ? null : Math.min(...futureResets),
		complete: known.length === readings.length,
	};
}

/**
 * The pooled figures for the serving account's servable class.
 *
 * Class members are the post-gate candidates that share the serving account's
 * class, plus the serving account itself. It is folded in unconditionally
 * because it can legitimately be off the candidate list — the burst hold
 * reprobes an affinity-pinned account regardless of gate position — and a
 * figure that excluded the account which just served would contradict itself.
 *
 * Filtering to one class is what makes the number honest in a mixed or combo
 * pool: accounts in another class cannot cover for this request, so folding
 * their headroom in would claim a failover that cannot happen.
 */
export function computePoolHeadroom(
	servingAccount: Account,
	candidates: readonly Account[],
	upstreamHeaders: Headers,
	nowMs: number,
): PoolHeadroomFigures {
	const servable = servableClassFor(servingAccount.provider);
	const members = new Map<string, Account>([
		[servingAccount.id, servingAccount],
	]);
	for (const account of candidates) {
		if (servable.providers.has(account.provider)) {
			members.set(account.id, account);
		}
	}

	const fold = (kind: WindowKind): PooledWindowFigure | null =>
		foldWindow(
			[...members.values()].map((account) => {
				const cached = readWindow(account, kind);
				return account.id === servingAccount.id
					? better(cached, readWire(upstreamHeaders, kind))
					: cached;
			}),
			nowMs,
		);

	return { session: fold("session"), weekly: fold("weekly") };
}
