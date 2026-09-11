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
	FIVE_HOUR_ELIGIBLE_PROVIDERS,
	type PooledWindowFigure,
	type PoolHeadroomFigures,
	parseStrictDecimal,
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
 * A WeakMap keyed on the live `RequestMeta` object, mirroring the resolved-route
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

/**
 * One member's contribution.
 *
 * "unknown" and "unbounded" both keep the member out of the maximum, but they
 * are not interchangeable. "unknown" means we lack evidence and a fresher
 * source may supply it. "unbounded" means the account's quota reading cannot
 * bound its ability to serve AT ALL — purchased credits let it keep serving at
 * 100% — so no reading, however fresh, may resolve it. Collapsing the two lets
 * a wire reading of 100% turn a credit-bearing account into proof of an
 * exhausted pool.
 */
type MemberReading =
	| { pct: number; resetMs: number | null }
	| "unknown"
	| "unbounded";

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
		return "unbounded";
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
	// Read the utilization line DIRECTLY rather than through
	// `extractUnifiedClaimReadings`, which enumerates `-status` lines and so
	// yields nothing for a claim that sent a utilization without a status. The
	// writer gates on the utilization alone, and the two predicates disagreeing
	// is not cosmetic: the wire reading would be missed, a worse cached value
	// would win, and we would hand the client a HIGHER utilization than the
	// account it was served by actually reported.
	const claim = kind === "session" ? "5h" : "7d";
	const utilization = parseStrictDecimal(
		headers.get(`anthropic-ratelimit-unified-${claim}-utilization`),
	);
	if (utilization !== null) {
		const resetSec = parseStrictDecimal(
			headers.get(`anthropic-ratelimit-unified-${claim}-reset`),
		);
		// Unified utilization is a 0..1 fraction; every figure here is a percent.
		return {
			pct: utilization * 100,
			resetMs: resetSec === null ? null : resetSec * 1000,
		};
	}

	if (kind === "session") return null;
	for (const slot of ["primary", "secondary"] as const) {
		const minutes = parseStrictDecimal(
			headers.get(`x-codex-${slot}-window-minutes`),
		);
		if (minutes !== WEEKLY_WINDOW_MINUTES) continue;
		// A window whose length is declared but whose utilization is absent or
		// unparseable is a RECOGNIZED window with no reading. Coercing that to
		// zero would turn "we cannot tell" into "completely unused".
		const used = parseStrictDecimal(
			headers.get(`x-codex-${slot}-used-percent`),
		);
		if (used === null) return null;
		const resetSec = parseStrictDecimal(
			headers.get(`x-codex-${slot}-reset-at`),
		);
		return {
			pct: used,
			resetMs: resetSec !== null && resetSec > 0 ? resetSec * 1000 : null,
		};
	}
	return null;
}

/**
 * The serving account's reading, preferring the wire over the cache.
 *
 * The wire reading came from the response being forwarded right now, so it is
 * strictly fresher and authoritative for that one account. It REPLACES the
 * cached value rather than competing with it: taking whichever showed more
 * headroom would let a cache entry up to `MAX_USAGE_AGE_MS` stale override what
 * the account just reported, and the error runs in the dangerous direction —
 * the meter would read better than reality on a pool whose best member is the
 * account that just served.
 */
function preferWire(
	cached: MemberReading,
	wire: MemberReading | null,
): MemberReading {
	// "unbounded" is a property of the ACCOUNT, not of the evidence, so no
	// reading supersedes it. A credit-bearing account reporting 100% on the wire
	// is still able to serve, and letting that number through would make it the
	// proof that the pool is exhausted.
	if (cached === "unbounded") return cached;
	return wire ?? cached;
}

function foldWindow(
	readings: readonly MemberReading[],
	nowMs: number,
): PooledWindowFigure | null {
	const known = readings.filter(
		(reading): reading is Exclude<MemberReading, "unknown" | "unbounded"> =>
			reading !== "unknown" && reading !== "unbounded",
	);
	if (known.length === 0) return null;

	const lowestUsed = Math.min(...known.map((reading) => reading.pct));
	const usableReset = (reading: { resetMs: number | null }): boolean =>
		reading.resetMs !== null && reading.resetMs > nowMs;

	// Reset comes from the members TIED at the winning headroom, not the soonest
	// across the class. The pair (utilization, reset) is consumed together to
	// derive pacing, so pairing the best member's figure with an unrelated
	// sibling's imminent reset would tell the client it is nearly through a
	// window it has barely started. When the class is fully spent every member
	// ties at zero, which is exactly when "soonest reset" is the right answer.
	const winners = known.filter((reading) => reading.pct <= lowestUsed + 1e-9);
	const winnerResets = winners
		.filter(usableReset)
		.map((r) => r.resetMs as number);

	// Fallback when the winning member has no usable reset of its own: pair its
	// headroom with the soonest usable reset elsewhere in the class rather than
	// abandoning the rewrite. Abandoning it would leave the client showing the
	// serving account's own exhaustion while the pool demonstrably had room —
	// a flatly wrong headline. The percentage a client displays comes from the
	// utilization alone; the reset only feeds pacing text and thresholds, so
	// degrading the reset costs far less than degrading the number.
	const anyResets = known.filter(usableReset).map((r) => r.resetMs as number);
	const resets = winnerResets.length > 0 ? winnerResets : anyResets;

	return {
		headroomPct: Math.max(0, Math.min(100, 100 - lowestUsed)),
		resetMs: resets.length === 0 ? null : Math.min(...resets),
		complete: known.length === readings.length,
	};
}

/**
 * The pooled figures for the serving account's servable class.
 *
 * Class members are the post-gate candidates that share the serving account's
 * class, plus the serving account itself. It is folded in unconditionally
 * because a hold may serve an authorized account outside the earlier post-gate
 * snapshot. Dispatch still enforces the frozen route and current permissions;
 * the figure must include the account which actually served the request.
 *
 * The candidates already satisfy routing rules and model permissions. Keep the
 * existing conservative quota-class grouping within that authorized set:
 * cross-provider model routing does not make unlike quota windows equivalent.
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
					? preferWire(cached, readWire(upstreamHeaders, kind))
					: cached;
			}),
			nowMs,
		);

	return { session: fold("session"), weekly: fold("weekly") };
}
