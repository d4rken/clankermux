/**
 * The usage view routing reads for an Anthropic account: the polled
 * `/api/oauth/usage` reading with its 5h and 7d windows brought up to date from
 * the `anthropic-ratelimit-unified-{5h,7d}-*` headers of later responses.
 *
 * Every function here is pure. `UsageCache` owns the header store and its
 * lifecycle; this module owns how a header reading is validated and how it is
 * reconciled with the poll.
 */
import {
	type ExtractedClaimReading,
	type FiveHourClaimShape,
	type NormalizedUsageWindow,
	normalizeAnthropicUsage,
	reportsNoSessionWindow,
	USAGE_READING_CLAIM_STATUSES,
} from "@clankermux/core";
import type { AnthropicUsageData } from "@clankermux/types";
import type { AnyUsageData, UsageData } from "./usage-fetcher";

/**
 * Two resets this close name the same window. The header reset is whole epoch
 * seconds and the poll's carries a sub-second fraction, e.g.
 * `16:00:00.219906Z` against `16:00:00`.
 */
export const HEADER_WINDOW_IDENTITY_TOLERANCE_MS = 2_000;

/** One account-wide claim from a response's unified headers, as a reading. */
export interface HeaderWindowReading {
	/** Percent 0..100 (the header carries a 0..1 fraction). */
	utilization: number;
	resetMs: number;
	status: string;
	/** When the response carrying it arrived. */
	observedAtMs: number;
}

/** Whether one response carried the 5h claim (`classifyFiveHourClaimShape`). */
export interface FiveHourShapeObservation {
	kind: "present" | "absent";
	/** When the response carrying it arrived. */
	observedAtMs: number;
}

export interface HeaderWindows {
	fiveHour: HeaderWindowReading | null;
	sevenDay: HeaderWindowReading | null;
	/** The newest observed 5h claim shape. */
	fiveHourShape: FiveHourShapeObservation | null;
	/**
	 * The newest absence ever observed, which only rises. No 5h reading
	 * observed at or before it is kept, whatever arrives later.
	 */
	fiveHourAbsentAtMs: number | null;
}

/** Where one axis of a {@link UsageView} came from, and how old it is. */
export interface UsageAxisView {
	/** `merged`: the poll and a header named the same window. */
	source: "poll" | "header" | "merged";
	/** When the reported reading was observed; null when the poll cannot say. */
	observedAtMs: number | null;
	/** The instant freshness bounds measure this axis from. */
	freshAtMs: number;
}

export interface UsageView {
	/** The poll payload, with the 5h/7d windows the headers updated. */
	data: AnyUsageData;
	fiveHour: UsageAxisView;
	sevenDay: UsageAxisView;
	pollWrittenAtMs: number;
	pollObservedAtMs: number | null;
	/** The instant freshness bounds measure the poll's own axes from. */
	pollFreshAtMs: number;
}

/** The poll reading a view is built on. */
export interface PollReading {
	data: AnyUsageData;
	writtenAtMs: number;
	observedAtMs: number | null;
	/**
	 * The instant freshness bounds measure the poll from; its write time unless
	 * the cache vouches that it is still current (`UsageCache` idle trust).
	 */
	freshAtMs?: number;
}

/** The latest instant a `Date` can hold; a later reset cannot be formatted. */
const MAX_DATE_MS = 8.64e15;

/** Percent with the binary-fraction noise of `0.29 * 100` rounded away. */
function toPercent(fraction: number): number {
	return Math.round(fraction * 100 * 1e6) / 1e6;
}

/**
 * A claim as a reading, or null when it cannot be one: a status outside
 * {@link USAGE_READING_CLAIM_STATUSES}, a utilization that is missing or
 * outside 0..1, or a reset that is missing, beyond what a `Date` can
 * represent, or not after the observation. That last one is what a response
 * right after a window roll carries: the old window, reset already behind it.
 */
export function headerWindowFromClaim(
	claim: ExtractedClaimReading,
	observedAtMs: number,
): HeaderWindowReading | null {
	if (!USAGE_READING_CLAIM_STATUSES.has(claim.status)) return null;
	const { utilization, resetMs } = claim;
	if (
		utilization === null ||
		!Number.isFinite(utilization) ||
		utilization < 0 ||
		utilization > 1
	) {
		return null;
	}
	if (
		resetMs === null ||
		!Number.isFinite(resetMs) ||
		resetMs <= observedAtMs ||
		resetMs > MAX_DATE_MS
	) {
		return null;
	}
	return {
		utilization: toPercent(utilization),
		resetMs,
		status: claim.status,
		observedAtMs,
	};
}

/** The account-wide `5h`/`7d` claims of one response, validated. */
export function headerWindowsFromClaims(
	claims: readonly ExtractedClaimReading[],
	observedAtMs: number,
	fiveHourShape: FiveHourClaimShape = "unknown",
): HeaderWindows {
	const pick = (token: string) => {
		const found = claims.find((c) => c.claim === token);
		return found ? headerWindowFromClaim(found, observedAtMs) : null;
	};
	return {
		fiveHour: pick("5h"),
		sevenDay: pick("7d"),
		fiveHourShape:
			fiveHourShape === "unknown"
				? null
				: { kind: fiveHourShape, observedAtMs },
		fiveHourAbsentAtMs: fiveHourShape === "absent" ? observedAtMs : null,
	};
}

function newerOf(
	stored: HeaderWindowReading | null,
	incoming: HeaderWindowReading | null,
): HeaderWindowReading | null {
	if (incoming === null) return stored;
	if (stored !== null && stored.observedAtMs > incoming.observedAtMs)
		return stored;
	return incoming;
}

function newerShape(
	stored: FiveHourShapeObservation | null,
	incoming: FiveHourShapeObservation | null,
): FiveHourShapeObservation | null {
	if (incoming === null) return stored;
	if (stored === null || incoming.observedAtMs > stored.observedAtMs)
		return incoming;
	if (incoming.observedAtMs < stored.observedAtMs) return stored;
	return incoming.kind === "present" ? incoming : stored;
}

function laterOf(a: number | null, b: number | null): number | null {
	if (a === null) return b;
	return b === null ? a : Math.max(a, b);
}

/**
 * Per axis, the later-observed reading; responses can land out of order.
 *
 * `observedAtMs` is arrival time, and arrival order is the authority: a
 * response sent before the 5h window went away but landing after the absence
 * was recorded is refused, and the epoch fence and the next poll correct
 * anything else in flight. Shape ties go to presence, the conservative side.
 */
export function mergeHeaderWindows(
	stored: HeaderWindows | undefined,
	incoming: HeaderWindows,
): HeaderWindows {
	const absentAtMs = laterOf(
		stored?.fiveHourAbsentAtMs ?? null,
		incoming.fiveHourAbsentAtMs,
	);
	const afterAbsence = (reading: HeaderWindowReading | null) =>
		reading !== null &&
		absentAtMs !== null &&
		reading.observedAtMs <= absentAtMs
			? null
			: reading;
	return {
		fiveHour: newerOf(
			afterAbsence(stored?.fiveHour ?? null),
			afterAbsence(incoming.fiveHour),
		),
		sevenDay: newerOf(stored?.sevenDay ?? null, incoming.sevenDay),
		fiveHourShape: newerShape(
			stored?.fiveHourShape ?? null,
			incoming.fiveHourShape,
		),
		fiveHourAbsentAtMs: absentAtMs,
	};
}

type AxisChoice =
	| { kind: "poll" }
	| { kind: "header"; utilization: number; resetsAt: string }
	| { kind: "merged"; utilization: number };

function chooseAxis(
	polled: NormalizedUsageWindow | null,
	header: HeaderWindowReading | null,
	now: number,
): AxisChoice {
	if (header === null || header.resetMs <= now) return { kind: "poll" };
	const asHeader: AxisChoice = {
		kind: "header",
		utilization: header.utilization,
		resetsAt: new Date(header.resetMs).toISOString(),
	};
	if (polled === null || polled.resetMs === null) return asHeader;
	const delta = header.resetMs - polled.resetMs;
	if (Math.abs(delta) <= HEADER_WINDOW_IDENTITY_TOLERANCE_MS) {
		// Utilization only rises within a window, so the higher of the two is
		// the better lower bound: a 0.99-saturated header never lowers a poll's
		// 100, and rounding never un-spends a window.
		return {
			kind: "merged",
			utilization: Math.max(polled.utilization, header.utilization),
		};
	}
	return delta > 0 ? asHeader : { kind: "poll" };
}

const AXES = {
	fiveHour: { flat: "five_hour", limitKind: "session" },
	sevenDay: { flat: "seven_day", limitKind: "weekly_all" },
} as const;

/**
 * Write one axis into the copy, in whichever representation the normalizer
 * reads it from, so the payload keeps its shape: the flat window when it holds
 * a number, else the `limits[]` entry, else a new flat window.
 */
function writeAxis(
	data: UsageData,
	axis: keyof typeof AXES,
	utilization: number,
	resetsAt: string | undefined,
): void {
	const { flat, limitKind } = AXES[axis];
	const window = data[flat];
	if (window && Number.isFinite(window.utilization)) {
		data[flat] = {
			...window,
			utilization,
			...(resetsAt !== undefined ? { resets_at: resetsAt } : {}),
		};
		return;
	}
	const index = (data.limits ?? []).findIndex(
		(e) => e.kind === limitKind && Number.isFinite(e.percent),
	);
	if (data.limits && index >= 0) {
		data.limits = data.limits.map((entry, i) =>
			i === index
				? {
						...entry,
						percent: utilization,
						...(resetsAt !== undefined ? { resets_at: resetsAt } : {}),
					}
				: entry,
		);
		return;
	}
	data[flat] = { utilization, resets_at: resetsAt ?? null };
}

/** What the poll says about the 5h window. */
function pollFiveHourShape(data: UsageData): FiveHourClaimShape {
	if (reportsNoSessionWindow(data as AnthropicUsageData)) return "absent";
	if (data.five_hour !== null && typeof data.five_hour === "object")
		return "present";
	return (data.limits ?? []).some((entry) => entry?.kind === "session")
		? "present"
		: "unknown";
}

/**
 * A copy without the poll's 5h window or `limits[]` session entries:
 * `five_hour: null` when the window is known absent, no key at all when the
 * only 5h reading left is one the evidence has outdated.
 */
function withoutFiveHour(data: UsageData, absent: boolean): UsageData {
	const { five_hour: _fiveHour, ...rest } = data;
	const copy = (absent ? { ...rest, five_hour: null } : rest) as UsageData;
	if (data.limits)
		copy.limits = data.limits.filter((entry) => entry?.kind !== "session");
	return copy;
}

/**
 * The poll reading with each 5h/7d axis taken from whichever source is newer:
 *
 * - no header, or its reset has passed: the poll's axis;
 * - the same window (resets within {@link HEADER_WINDOW_IDENTITY_TOLERANCE_MS}):
 *   the higher utilization, timed by the newer of the two;
 * - a header window resetting later than the poll's (the window rolled since
 *   the poll), or a poll axis with no reset: the header;
 * - a header window resetting earlier than the poll's: the poll.
 *
 * Before that, the newest 5h evidence decides whether the window exists: the
 * poll's (`reportsNoSessionWindow` for absence) at its observation time, and
 * the headers' shape. When absence is newest the view has `five_hour: null`
 * and no `limits[]` session entry, timed by that absence. When presence is
 * newer than some absence, a 5h reading observed before the absence is
 * dropped; with none left the view has no 5h reading at all, timed by the poll.
 *
 * With `headers` null this is the poll reading itself, and the returned data is
 * the same object. Otherwise the poll payload is copied, never mutated.
 */
export function buildUsageView(
	poll: PollReading,
	headers: HeaderWindows | null,
	now: number,
): UsageView {
	const pollFreshAtMs = poll.freshAtMs ?? poll.writtenAtMs;
	const pollAxis: UsageAxisView = {
		source: "poll",
		observedAtMs: poll.observedAtMs,
		freshAtMs: pollFreshAtMs,
	};
	const view: UsageView = {
		data: poll.data,
		fiveHour: pollAxis,
		sevenDay: pollAxis,
		pollWrittenAtMs: poll.writtenAtMs,
		pollObservedAtMs: poll.observedAtMs,
		pollFreshAtMs,
	};
	if (headers === null) return view;

	const normalized = normalizeAnthropicUsage(
		poll.data as AnthropicUsageData,
		now,
	);
	const polled = {
		fiveHour: normalized.session,
		sevenDay: normalized.weeklyAll,
	};
	const fromHeaders = {
		fiveHour: headers.fiveHour,
		sevenDay: headers.sevenDay,
	};
	let copy: UsageData | null = null;

	const pollData = poll.data as UsageData;
	const pollAtMs = poll.observedAtMs ?? poll.writtenAtMs;
	const pollShape = pollFiveHourShape(pollData);
	const shape = headers.fiveHourShape;
	const absentAtMs = laterOf(
		pollShape === "absent" ? pollAtMs : null,
		headers.fiveHourAbsentAtMs,
	);
	if (absentAtMs !== null) {
		const presentAtMs = laterOf(
			laterOf(
				pollShape === "present" ? pollAtMs : null,
				shape?.kind === "present" ? shape.observedAtMs : null,
			),
			headers.fiveHour?.observedAtMs ?? null,
		);
		if (presentAtMs === null || absentAtMs > presentAtMs) {
			if (pollShape !== "absent") copy = withoutFiveHour(pollData, true);
			const headerAbsentAtMs =
				shape?.kind === "absent" ? shape.observedAtMs : null;
			if (headerAbsentAtMs !== null) {
				view.fiveHour =
					pollShape === "absent"
						? {
								source: "merged",
								observedAtMs: Math.max(
									poll.observedAtMs ?? Number.NEGATIVE_INFINITY,
									headerAbsentAtMs,
								),
								freshAtMs: Math.max(pollFreshAtMs, headerAbsentAtMs),
							}
						: {
								source: "header",
								observedAtMs: headerAbsentAtMs,
								freshAtMs: headerAbsentAtMs,
							};
			}
			fromHeaders.fiveHour = null;
		} else {
			if ((fromHeaders.fiveHour?.observedAtMs ?? absentAtMs) < absentAtMs)
				fromHeaders.fiveHour = null;
			const pollCurrent = pollShape === "present" && pollAtMs >= absentAtMs;
			if (pollShape !== "unknown" && !pollCurrent) {
				copy = withoutFiveHour(pollData, false);
				polled.fiveHour = null;
			}
		}
	}

	for (const axis of ["fiveHour", "sevenDay"] as const) {
		const header = fromHeaders[axis];
		const choice = chooseAxis(polled[axis], header, now);
		if (choice.kind === "poll" || header === null) continue;
		copy ??= { ...pollData };
		if (choice.kind === "header") {
			writeAxis(copy, axis, choice.utilization, choice.resetsAt);
			view[axis] = {
				source: "header",
				observedAtMs: header.observedAtMs,
				freshAtMs: header.observedAtMs,
			};
			continue;
		}
		if (choice.utilization !== polled[axis]?.utilization)
			writeAxis(copy, axis, choice.utilization, undefined);
		view[axis] = {
			source: "merged",
			observedAtMs: Math.max(
				poll.observedAtMs ?? Number.NEGATIVE_INFINITY,
				header.observedAtMs,
			),
			freshAtMs: Math.max(pollFreshAtMs, header.observedAtMs),
		};
	}
	if (copy !== null) view.data = copy;
	return view;
}

/**
 * Whether the poll reports a capacity axis no header carries: the OAuth-apps
 * weekly with a numeric utilization, or overage credit that is enabled with a
 * numeric utilization. `limits[]` is not one of these; the family-weekly gate
 * reads it from the poll alone.
 */
export function reportsPollOnlyAxis(data: AnyUsageData): boolean {
	const d = data as UsageData;
	const oauth = d.seven_day_oauth_apps;
	if (
		oauth &&
		typeof oauth.utilization === "number" &&
		Number.isFinite(oauth.utilization)
	) {
		return true;
	}
	const extra = d.extra_usage;
	return (
		!!extra &&
		extra.is_enabled === true &&
		typeof extra.utilization === "number" &&
		Number.isFinite(extra.utilization)
	);
}

/**
 * Fresh when the 5h and 7d axes are each within `maxAgeMs` of the source they
 * were taken from, and a reported poll-only axis ({@link reportsPollOnlyAxis})
 * is too. A view with no header windows is therefore fresh exactly when its
 * poll is.
 */
export function isUsageViewFresh(
	view: UsageView,
	now: number,
	maxAgeMs: number,
): boolean {
	if (now - view.fiveHour.freshAtMs > maxAgeMs) return false;
	if (now - view.sevenDay.freshAtMs > maxAgeMs) return false;
	return (
		!reportsPollOnlyAxis(view.data) || now - view.pollFreshAtMs <= maxAgeMs
	);
}
