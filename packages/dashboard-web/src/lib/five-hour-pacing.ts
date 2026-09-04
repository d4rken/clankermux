import type { Outlook, PoolUsageResult } from "./pool-usage";

/**
 * One servable class's 5-hour situation, split by what a reader can DO about
 * each account.
 *
 * The distinction the counts exist to draw: an account held by the 5-hour rate
 * limit comes back on its own, usually within the hour, so it is capacity that
 * is merely deferred. An account that is paused, cooling down, token-expired or
 * out of its WEEKLY quota does not come back when the 5-hour window lifts, so
 * folding it into the same number would promise a recovery that never arrives.
 */
export interface ClassPacing {
	classId: string;
	label: string;
	/** Reporting accounts: they can serve a request right now. */
	room: number;
	/** Reporting accounts projected to hit their 5-hour limit before it resets. */
	runningHot: number;
	/**
	 * Accounts held by the 5-hour limit ALONE — the ones a lift restores.
	 *
	 * An account also out of its weekly quota is excluded: the 5-hour lift gives
	 * it nothing, and counting it here would inflate the "waiting" figure with
	 * capacity that is not coming back this window.
	 */
	waiting: number;
	/** Every other unavailable account: paused, cooling down, token expired, usage-429, weekly spent. */
	unavailable: number;
	/** Accounts with no 5-hour reading at all. Never counted as 0%. */
	unknown: number;
	/** Earliest future reset among this class's waiting accounts. */
	nextLiftMs: number | null;
	nextLiftAccountName: string | null;
	/**
	 * Nothing in this class can serve a request, and the reason is the 5-hour
	 * limit. The one case where a reader has no option but to wait, so it is
	 * called out separately from a class that merely lost an account.
	 */
	noPath: boolean;
}

export interface FiveHourPacing {
	waiting: number;
	runningHot: number;
	room: number;
	nextLiftMs: number | null;
	nextLiftAccountName: string | null;
	/** In `fiveHour.classes` order. */
	classes: ClassPacing[];
	outlook: Outlook;
}

/**
 * How the pool is being paced by the 5-hour rate limit, per servable class.
 *
 * Takes BOTH windows because the 5-hour picture cannot be read from the 5-hour
 * result alone. An account out of its weekly quota is reported as
 * `five_hour_exhausted` on no surface, but an account out of both is reported
 * that way on the 5-hour one — and a reader told "1 waiting, lifts in 40m"
 * about an account whose weekly quota is spent has been promised capacity that
 * will not arrive. The weekly result supplies the check.
 */
export function computeFiveHourPacing(
	fiveHour: PoolUsageResult,
	sevenDay: PoolUsageResult,
	now: number,
): FiveHourPacing {
	const weeklySpent = new Set(
		sevenDay.exhausted
			.filter((e) => e.reason === "seven_day_exhausted")
			.map((e) => e.accountId),
	);
	const atRisk = new Set(fiveHour.atRisk.map((a) => a.accountId));

	const classes: ClassPacing[] = fiveHour.classes.map((pool) => {
		let room = 0;
		let runningHot = 0;
		let waiting = 0;
		let unavailable = 0;
		let unknown = 0;
		let nextLiftMs: number | null = null;
		let nextLiftAccountName: string | null = null;

		for (const bar of pool.accounts) {
			if (bar.state === "reporting") {
				room++;
				if (atRisk.has(bar.accountId)) runningHot++;
				continue;
			}
			if (bar.state === "unknown") {
				unknown++;
				continue;
			}
			const heldByFiveHourAlone =
				bar.reason === "five_hour_exhausted" && !weeklySpent.has(bar.accountId);
			if (!heldByFiveHourAlone) {
				unavailable++;
				continue;
			}
			waiting++;
			// A reset already behind us is a stale reading, not an imminent lift.
			if (
				bar.resetMs != null &&
				bar.resetMs > now &&
				(nextLiftMs === null || bar.resetMs < nextLiftMs)
			) {
				nextLiftMs = bar.resetMs;
				nextLiftAccountName = bar.name;
			}
		}

		return {
			classId: pool.classId,
			label: pool.label,
			room,
			runningHot,
			waiting,
			unavailable,
			unknown,
			nextLiftMs,
			nextLiftAccountName,
			noPath: room === 0 && waiting > 0,
		};
	});

	let nextLiftMs: number | null = null;
	let nextLiftAccountName: string | null = null;
	for (const pool of classes) {
		if (pool.nextLiftMs == null) continue;
		if (nextLiftMs === null || pool.nextLiftMs < nextLiftMs) {
			nextLiftMs = pool.nextLiftMs;
			nextLiftAccountName = pool.nextLiftAccountName;
		}
	}

	return {
		waiting: classes.reduce((sum, c) => sum + c.waiting, 0),
		runningHot: classes.reduce((sum, c) => sum + c.runningHot, 0),
		room: classes.reduce((sum, c) => sum + c.room, 0),
		nextLiftMs,
		nextLiftAccountName,
		classes,
		outlook: pacingOutlook(classes),
	};
}

/**
 * True when this class yields NO 5-hour reading: nobody reporting, nobody held
 * by the limit, and at least one account nothing could be read from.
 *
 * `unavailable` is deliberately NOT part of this test. An excluded account —
 * paused, cooling down, token-expired — is classified before usage is even
 * extracted and is stored with `pct: null` (see `classifyExclusion` in
 * pool-usage.ts), so knowing WHY it cannot serve tells us nothing whatsoever
 * about the class's 5-hour situation. Requiring `unavailable === 0` let a class
 * of one unread account plus one paused account pass as read, and a sibling
 * class with room then carried the whole panel to green.
 *
 * Codex accounts are the standing case rather than an edge one: they report no
 * 5-hour window at all, so any pool holding one has a permanently unread class
 * sitting beside fully-read ones.
 */
export function classIsUnread(pacing: ClassPacing): boolean {
	return pacing.room === 0 && pacing.waiting === 0 && pacing.unknown > 0;
}

/**
 * The verdict on the pool's pacing.
 *
 * Ordered by what it costs the reader to be wrong. A class with nothing left to
 * serve it is the only state where waiting is the only option, so it outranks
 * everything. "Pacing" is the ordinary busy state: some capacity is deferred or
 * heading that way, and a sibling can still serve. The neutral "No reading"
 * comes before the reassuring "Clear" deliberately — no class with room and
 * nothing waiting means there is nothing to be clear ABOUT, and green would
 * dress an absent measurement as a healthy one.
 *
 * "Partial" applies that same rule PER CLASS, which is the granularity it was
 * missing. One class with room was enough to paint the chip green while a
 * sibling had no 5-hour reading whatsoever, so the reassurance covered accounts
 * that nothing had measured — and with a Codex account in the pool that is the
 * permanent state, not a transient one. It ranks below the pacing states and
 * above "Clear", and stays NEUTRAL: an unread class is not evidence of trouble,
 * only the absence of evidence of health. Which class it is comes from the
 * rows beneath, which render "no 5h reading" off the same predicate.
 */
function pacingOutlook(classes: ClassPacing[]): Outlook {
	if (classes.some((c) => c.noPath)) {
		return { label: "Paced", tone: "destructive" };
	}
	if (classes.some((c) => c.waiting > 0 || c.runningHot > 0)) {
		return { label: "Pacing", tone: "warning" };
	}
	if (!classes.some((c) => c.room > 0)) {
		return { label: "No reading", tone: "neutral" };
	}
	if (classes.some(classIsUnread)) {
		return { label: "Partial", tone: "neutral" };
	}
	return { label: "Clear", tone: "success" };
}
