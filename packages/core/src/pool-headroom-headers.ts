/**
 * Restating a response's rate-limit headroom as the POOL's best headroom.
 *
 * Both client CLIs render their usage meter from rate-limit headers on the
 * response they just received, so the figure they show belongs to whichever
 * pooled account served that request. Since the proxy routes around a spent
 * account, that figure answers the wrong question: an account at 97% says
 * nothing about whether the next request will be served, and the number visibly
 * flickers as the router moves between accounts.
 *
 * These writers replace the headroom figures with the best headroom available
 * anywhere in the serving account's servable class, so the meter reaches 100%
 * only when the pool genuinely cannot serve.
 *
 * Three rules hold the restatement honest, and each is load-bearing:
 *
 *  1. **Only restate, never invent.** A window is rewritten only when upstream
 *     already sent a reading for it, in the units it sent. Absence is itself a
 *     signal — with both account-wide readings missing, a client falls back to
 *     its own persisted figure — so a header that did not arrive is never added.
 *
 *  2. **Headroom only, never the verdict.** `-status`, the per-claim statuses,
 *     `retry-after` and the overage axis describe whether THIS request was
 *     allowed. That was the serving account's call and it was true. Restating it
 *     from pool state would be a lie about something that already happened.
 *
 *  3. **Utilization and reset move together.** Clients derive pacing from the
 *     pair — how far into the window we are versus how much is spent — so a
 *     pooled utilization against the serving account's unrelated reset produces
 *     an incoherent verdict in both directions. Either both are rewritten or
 *     neither is.
 *
 * Pure: no clock beyond the `nowMs` passed in, no cache, no account knowledge.
 * The writers return a diff rather than mutating so that every test is a plain
 * object comparison and the one mutating function is three lines that cannot be
 * got wrong.
 */

/** One pooled window figure, ready to be restated on the wire. */
export interface PooledWindowFigure {
	/** Best (MAX) headroom across the class, PERCENT 0..100. */
	headroomPct: number;
	/** The reset to advertise, epoch MS. null when no member had a future one. */
	resetMs: number | null;
	/**
	 * True only when EVERY class member contributed a usable reading for this
	 * window. False means at least one account is unknown — and an unknown
	 * account may well be able to serve, so a hard 100% must not be claimed on
	 * its behalf.
	 */
	complete: boolean;
}

/** The pooled figures for one servable class. A null window is never written. */
export interface PoolHeadroomFigures {
	/** The 5-hour / session window. Always null for the codex class. */
	session: PooledWindowFigure | null;
	/** The weekly window. */
	weekly: PooledWindowFigure | null;
}

/**
 * A header diff. Never applied here — the caller owns the `Headers` object and
 * decides whether the response is one we may touch at all.
 */
export interface HeaderRewrite {
	set: ReadonlyMap<string, string>;
	remove: readonly string[];
	/** Non-null when nothing was produced, naming the reason for the log. */
	skipped: string | null;
}

const EMPTY_SET: ReadonlyMap<string, string> = new Map();

/** codex reports window length in minutes; a week is 10080 of them. */
const WEEKLY_WINDOW_MINUTES = 10_080;

/** Full-string non-negative decimal. Mirrors `unified-claim-headers`' guard. */
const STRICT_DECIMAL_RE = /^\d+(?:\.\d+)?$/;

function parseDecimal(value: string | null): number | null {
	if (value === null || !STRICT_DECIMAL_RE.test(value)) return null;
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Stable wire formatting. Four decimals is far finer than any consumer's
 * display grid, and rounding there keeps a float artifact from reaching the
 * wire as `0.6400000000000001`. Both consumers coerce with `Number(...)`, so
 * the only real requirement is that the result never uses exponent notation —
 * which, after rounding, it cannot for any value in these ranges.
 */
function fmt(value: number): string {
	// FLOOR, not nearest. Nearest rounding can raise a value across the only
	// threshold that matters: 0.99999 becomes 1 and 99.99999 becomes 100, either
	// of which advertises an exhausted pool built from an input that was not
	// exhausted. Rounding down can only ever understate usage by less than the
	// display grid, which is the harmless direction.
	return String(Math.floor(value * 10_000) / 10_000);
}

function clamp(value: number, low: number, high: number): number {
	if (Number.isNaN(value)) return low;
	return Math.min(high, Math.max(low, value));
}

/**
 * A window is writable only with a reading we can pair with a future reset.
 * `nowMs` matters: a reset already behind us is a stale reading, not an
 * imminent lift, and pairing it with a pooled utilization would tell the client
 * the window is about to roll when it is not.
 */
function usable(
	figure: PooledWindowFigure | null,
	nowMs: number,
): figure is PooledWindowFigure & { resetMs: number } {
	return figure !== null && figure.resetMs !== null && figure.resetMs > nowMs;
}

function resetSeconds(resetMs: number): string {
	return String(Math.floor(resetMs / 1000));
}

/**
 * Restate the account-wide unified claims (`5h`, `7d`) as pool headroom.
 *
 * Scoped claims (`7d_oi`, `7d_opus`, …) are deliberately untouched: each
 * describes one model family's bucket, and an account-wide pooled figure cannot
 * speak for it. The `overage` axis is a billing state rather than a window and
 * is likewise left alone.
 *
 * `-<claim>-surpassed-threshold` is DELETED for any window rewritten rather
 * than recomputed. A client that sees it short-circuits its whole pacing
 * evaluation and republishes that claim's own utilization as the displayed
 * figure — which would put the serving account's number straight back on screen
 * after we had just replaced it. There is no correct pooled value to write
 * there, so the only coherent action is to remove the stale one.
 */
export function buildAnthropicUnifiedRewrite(
	upstream: Headers,
	figures: PoolHeadroomFigures,
	nowMs: number,
): HeaderRewrite {
	const windows: readonly [claim: string, figure: PooledWindowFigure | null][] =
		[
			["5h", figures.session],
			["7d", figures.weekly],
		];

	let sawUpstreamClaim = false;
	let sawFigure = false;
	const set = new Map<string, string>();
	const remove: string[] = [];

	for (const [claim, figure] of windows) {
		const upstreamUtilization = parseDecimal(
			upstream.get(`anthropic-ratelimit-unified-${claim}-utilization`),
		);
		if (upstreamUtilization !== null) sawUpstreamClaim = true;
		if (figure !== null) sawFigure = true;
		if (upstreamUtilization === null || !usable(figure, nowMs)) continue;

		// Two ceilings, both hard.
		//
		// The upstream value: the serving account is a member of its own class, so
		// the pooled maximum can never be worse than what it reported. Enforcing
		// that here rather than trusting the caller means no reader bug upstream
		// of this point can make a client look MORE constrained than the account
		// that just served it.
		//
		// 0.99 on an incomplete class: an unread account might still serve, and a
		// full 1.0 is the only value that renders as 100%.
		const ceiling = Math.min(upstreamUtilization, figure.complete ? 1 : 0.99);
		const utilization = clamp((100 - figure.headroomPct) / 100, 0, ceiling);

		set.set(
			`anthropic-ratelimit-unified-${claim}-utilization`,
			fmt(utilization),
		);
		set.set(
			`anthropic-ratelimit-unified-${claim}-reset`,
			resetSeconds(figure.resetMs),
		);
		remove.push(`anthropic-ratelimit-unified-${claim}-surpassed-threshold`);
	}

	if (set.size === 0) {
		return {
			set: EMPTY_SET,
			remove: [],
			skipped: sawUpstreamClaim
				? sawFigure
					? "no-writable-window"
					: "no-pooled-figures"
				: "no-upstream-claims",
		};
	}
	return { set, remove, skipped: null };
}

/**
 * Restate codex's account-wide WEEKLY root window as pool headroom.
 *
 * The root pair is `primary` / `secondary`, but which slot carries which window
 * is decided per account by the backend — on a Pro account the weekly window
 * arrives as `primary` and `secondary` is empty. So the slot is identified by
 * its declared length, never by its name; keying on the name would rewrite a
 * 5-hour window's figure on any account whose slots are the other way round.
 *
 * Only the weekly window is restated. codex accounts report no account-wide
 * 5-hour window at all, so there is no 5-hour pooled figure to write, and the
 * family-scoped blocks (`x-codex-<family>-*`) are separate quotas with their
 * own names that an account-wide figure cannot describe.
 */
export function buildCodexWeeklyRewrite(
	upstream: Headers,
	figures: PoolHeadroomFigures,
	nowMs: number,
): HeaderRewrite {
	// Prefer `primary` when both slots somehow declare a weekly length, so the
	// choice is deterministic rather than dependent on header iteration order.
	// A slot must declare the weekly length AND carry a utilization. Gating on
	// the length alone would let a response that declared the window without
	// reporting a figure acquire one, turning "recognized window, no reading"
	// into a concrete percentage it never sent.
	const slot = (["primary", "secondary"] as const).find(
		(candidate) =>
			parseDecimal(upstream.get(`x-codex-${candidate}-window-minutes`)) ===
				WEEKLY_WINDOW_MINUTES &&
			parseDecimal(upstream.get(`x-codex-${candidate}-used-percent`)) !== null,
	);
	if (slot === undefined) {
		return { set: EMPTY_SET, remove: [], skipped: "no-root-weekly-window" };
	}

	const weekly = figures.weekly;
	if (!usable(weekly, nowMs)) {
		return { set: EMPTY_SET, remove: [], skipped: "no-pooled-figures" };
	}

	// Same two hard ceilings as the unified writer: never worse than the serving
	// account's own reported figure, and never a full 100 on an incomplete class.
	const upstreamUsed =
		parseDecimal(upstream.get(`x-codex-${slot}-used-percent`)) ?? 100;
	const ceiling = Math.min(upstreamUsed, weekly.complete ? 100 : 99);
	const set = new Map<string, string>([
		[
			`x-codex-${slot}-used-percent`,
			fmt(clamp(100 - weekly.headroomPct, 0, ceiling)),
		],
		[`x-codex-${slot}-reset-at`, resetSeconds(weekly.resetMs)],
	]);

	// Written only when upstream sent it. The current CLI reads `-reset-at` and
	// ignores this one; our own header parser uses it as a fallback, so leaving a
	// stale relative offset beside a rewritten absolute one would give the two
	// parsers different answers.
	if (upstream.has(`x-codex-${slot}-reset-after-seconds`)) {
		set.set(
			`x-codex-${slot}-reset-after-seconds`,
			String(Math.max(0, Math.ceil((weekly.resetMs - nowMs) / 1000))),
		);
	}

	return { set, remove: [], skipped: null };
}

/** Apply a diff in place. Separate so the writers above stay pure. */
export function applyHeaderRewrite(
	target: Headers,
	rewrite: HeaderRewrite,
): void {
	for (const [name, value] of rewrite.set) target.set(name, value);
	for (const name of rewrite.remove) target.delete(name);
}
