import type {
	QuotaDriftCohort,
	QuotaDriftModel,
	QuotaDriftPoint,
	QuotaDriftUnidentifiedReason,
} from "@clankermux/types";
import { format } from "date-fns";

/**
 * Display helpers for the Analytics "Quota" tab.
 *
 * The rule the whole tab is built around: a number is shown ONLY when the
 * server marked it identified. Everything else reads as a stated reason, never
 * as a zero, a dash, or a suspiciously precise figure with a wide interval
 * beside it. `null` from the wire means "we could not tell", and the copy has
 * to say that in words.
 */

/** What the panel says instead of a number, and why. */
export const UNIDENTIFIED_COPY: Record<QuotaDriftUnidentifiedReason, string> = {
	// Deliberately the SAME headline phrase for the two collinearity-shaped
	// causes: to a reader, "we cannot separate this model from the others" and
	// "the interval is too wide to mean anything" are the same answer.
	"wide-interval": "Not enough independent traffic (estimate too imprecise)",
	collinear:
		"Not enough independent traffic (always runs alongside another model)",
	// NOT a measurement statement: the model simply was not routed here in this
	// period, so there was nothing to measure in the first place. Kept distinct
	// from `low-share`, which really does mean "it ran, and too little of it".
	"no-exposure": "Not in use during this period",
	"low-share": "Too little of this window's traffic to measure",
	"few-segments": "Not enough observations yet",
	"zero-estimate": "Not enough independent traffic (no measurable cost)",
};

/**
 * Priority order for turning a set of reasons into ONE sentence, most
 * informative first.
 *
 * `no-exposure` outranks everything: a model with no traffic at all in the
 * period cannot meaningfully be called collinear or imprecise, and saying it
 * was not in use is the answer the reader wanted. Below it, a model that is
 * BOTH collinear and wide-intervalled is collinear, and saying so is more
 * useful than describing the interval the collinearity caused.
 */
export const REASON_PRIORITY = [
	"no-exposure",
	"collinear",
	"low-share",
	"few-segments",
	"wide-interval",
	"zero-estimate",
] as const satisfies readonly QuotaDriftUnidentifiedReason[];

/** One line explaining why a model has no number, or null when it has one. */
export function unidentifiedReasonText(model: QuotaDriftModel): string | null {
	if (model.latest?.identified) return null;
	const reasons = model.latest?.unidentifiedReasons ?? [];
	const primary = primaryReason(reasons);
	return primary
		? UNIDENTIFIED_COPY[primary]
		: "Not enough independent traffic";
}

/**
 * The one reason that speaks for a set of them, or null when the set is empty.
 *
 * Empty is a real case the wire can produce (a payload written before point
 * reasons existed), and it must stay distinguishable from a known reason so
 * callers can fall back to generic wording rather than inventing a cause.
 */
export function primaryReason(
	reasons: readonly QuotaDriftUnidentifiedReason[],
): QuotaDriftUnidentifiedReason | null {
	for (const reason of REASON_PRIORITY) {
		if (reasons.includes(reason)) return reason;
	}
	return null;
}

/** Human label for a usage window. */
export function quotaWindowLabel(window: string): string {
	if (window === "five_hour") return "5-hour window";
	if (window === "seven_day") return "Weekly window";
	return window.replace(/_/g, " ");
}

/**
 * Cohort heading: the provider and the tier the accounts were filed under.
 * A cohort with no captured tier says so rather than rendering an empty gap.
 */
export function cohortLabel(cohort: QuotaDriftCohort): string {
	const parts = [cohort.provider];
	if (cohort.planTier) parts.push(cohort.planTier);
	if (cohort.rateLimitTier) parts.push(cohort.rateLimitTier);
	return parts.length === 1
		? `${cohort.provider} (tier unknown)`
		: parts.join(" · ");
}

/** `2.28` points of window per 1M eq-tokens, or the stated absence. */
export function formatCoefficient(value: number | null): string | null {
	if (value == null || !Number.isFinite(value)) return null;
	return `${value.toFixed(2)}%`;
}

/** A confidence interval as `2.15 – 2.45%`, or null when either bound is absent. */
export function formatInterval(
	low: number | null,
	high: number | null,
): string | null {
	if (low == null || high == null) return null;
	if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
	return `${low.toFixed(2)} – ${high.toFixed(2)}%`;
}

/** Implied full-window capacity in millions of equivalent tokens. */
export function formatCapacity(mtok: number | null): string | null {
	if (mtok == null || !Number.isFinite(mtok)) return null;
	if (mtok >= 100) return `${Math.round(mtok)}M`;
	if (mtok >= 10) return `${mtok.toFixed(1)}M`;
	return `${mtok.toFixed(2)}M`;
}

/** Signed relative move, e.g. `-18%`. Negative means the model got cheaper. */
export function formatRelativeChange(relative: number): string {
	const pct = relative * 100;
	const sign = pct > 0 ? "+" : "";
	return `${sign}${pct.toFixed(0)}%`;
}

/**
 * Whether a `stable` verdict may be REPORTED as stable.
 *
 * The changepoint scan can run, find nothing and return `stable` for a model
 * whose coefficient is not identified in the first place. Presenting that as
 * "no change detected" would claim a negative result about a quantity the panel
 * refuses to print — so the tab downgrades it to the same "not enough
 * independent traffic" answer it gives everywhere else.
 */
export function isReportableVerdict(model: QuotaDriftModel): boolean {
	if (model.verdict === "changed") return model.changes.length > 0;
	if (model.verdict === "stable") return model.latest?.identified === true;
	return false;
}

/* ── Gap summaries ──────────────────────────────────────────────────────── */

/**
 * One contiguous stretch of a model's series that carries no number, plus the
 * reason that speaks for it.
 *
 * The chart breaks its line at every such stretch and says nothing about why.
 * These stretches are what turns that silence into a sentence, and they are
 * derived here — in a pure function over the wire points — rather than in the
 * panel, because `ResponsiveContainer` renders no inspectable geometry under
 * `renderToStaticMarkup`: anything expressed as chart shape would ship
 * untested.
 */
export interface QuotaGapStretch {
	/** The reason that speaks for the stretch, or null when none was recorded. */
	reason: QuotaDriftUnidentifiedReason | null;
	/** Start of the stretch's first unmeasured fit window, ms since epoch. */
	fromMs: number;
	/** End of the stretch's last unmeasured fit window, ms since epoch. */
	toMs: number;
	/** Fit windows the stretch covers. */
	nPoints: number;
	/** Whether the stretch runs to the newest point of the series. */
	ongoing: boolean;
	/** Whether the stretch covers the whole series. */
	entireSeries: boolean;
}

/**
 * Split one model's series into its unmeasured stretches.
 *
 * Two collapsing rules, and the second is the one that matters:
 *
 *  - consecutive unmeasured points sharing a reason become ONE stretch, so a
 *    model that has been out of use for a month yields one line rather than
 *    fifteen;
 *  - a point that failed several criteria at once is reduced to a single
 *    reason by `REASON_PRIORITY` first, so a stretch is never mixed by the time
 *    it is compared. A change of reason genuinely starts a new stretch: a model
 *    that was pooled out and then stopped being routed altogether has two
 *    different things to say, and merging them would report whichever was
 *    longer as the whole story.
 */
export function summarizeGaps(
	points: readonly QuotaDriftPoint[],
): QuotaGapStretch[] {
	const stretches: QuotaGapStretch[] = [];
	let current: QuotaGapStretch | null = null;

	points.forEach((point, index) => {
		if (point.identified) {
			current = null;
			return;
		}
		const reason = primaryReason(point.unidentifiedReasons ?? []);
		if (current && current.reason === reason) {
			current.toMs = point.windowEndMs;
			current.nPoints += 1;
		} else {
			current = {
				reason,
				// The window START, not its end: a rolling window carrying no
				// exposure means the model was already absent when the window
				// opened, so that is the earliest instant the claim actually holds
				// for. Naming the end instead would understate the stretch.
				fromMs: point.windowStartMs,
				toMs: point.windowEndMs,
				nPoints: 1,
				ongoing: false,
				entireSeries: false,
			};
			stretches.push(current);
		}
		current.ongoing = index === points.length - 1;
		current.entireSeries = current.nPoints === points.length;
	});

	return stretches;
}

/**
 * Wording for a gap that covers the WHOLE series — there is no period to name,
 * because the model was never measurable on this window at all.
 */
const GAP_THROUGHOUT: Record<QuotaDriftUnidentifiedReason, string> = {
	"no-exposure": "not in use during this period",
	collinear:
		"always runs alongside another model, so its own cost cannot be separated",
	"wide-interval": "estimate too imprecise on this window",
	"low-share": "too little of this window's traffic to measure",
	"few-segments": "not enough observations on this window yet",
	"zero-estimate": "no separately measurable cost on this window",
};

/** Wording that takes a period suffix, as in "not in use since 7 Aug". */
const GAP_WITH_PERIOD: Record<QuotaDriftUnidentifiedReason, string> = {
	"no-exposure": "not in use",
	collinear: "not separable from the traffic beside it",
	"wide-interval": "estimate too imprecise",
	"low-share": "too little of this window's traffic to measure",
	"few-segments": "not enough observations",
	"zero-estimate": "no separately measurable cost",
};

/** Compact day label for a gap boundary, e.g. `7 Aug`. */
function formatGapDate(ms: number): string {
	return format(new Date(ms), "d MMM");
}

/**
 * One sentence for one stretch.
 *
 * Every phrase describes what THIS analysis could not do, never the model. "Not
 * separable from the traffic beside it" is a fact about the evidence; "this
 * model has no cost" would be a claim the fit cannot support.
 */
export function gapStretchText(stretch: QuotaGapStretch): string {
	if (stretch.reason === null) {
		// The wire listed no reason at all — a payload written before points
		// carried them. Say only what is known rather than picking a cause.
		return stretch.entireSeries
			? "not measurable on this window"
			: `not measurable since ${formatGapDate(stretch.fromMs)}`;
	}
	if (stretch.entireSeries) return GAP_THROUGHOUT[stretch.reason];
	const phrase = GAP_WITH_PERIOD[stretch.reason];
	return stretch.ongoing
		? `${phrase} since ${formatGapDate(stretch.fromMs)}`
		: `${phrase} from ${formatGapDate(stretch.fromMs)} to ${formatGapDate(stretch.toMs)}`;
}

/** One model's line in the gap list. */
export interface QuotaGapLine {
	key: string;
	stretch: QuotaGapStretch;
	text: string;
}

/**
 * The stretch that speaks for a model: the longest one, and the most recent of
 * those when several tie.
 *
 * Longest rather than newest because the line is answering "why is this chart
 * mostly empty", and the stretch that occupies most of it is the answer. Recency
 * only breaks ties so a model whose situation changed does not report the older
 * of two equal stretches.
 */
export function dominantGap(
	stretches: readonly QuotaGapStretch[],
): QuotaGapStretch | null {
	let best: QuotaGapStretch | null = null;
	for (const stretch of stretches) {
		if (
			best === null ||
			stretch.nPoints > best.nPoints ||
			(stretch.nPoints === best.nPoints && stretch.fromMs > best.fromMs)
		) {
			best = stretch;
		}
	}
	return best;
}

/**
 * One line per model that has an unexplained stretch, in the order the models
 * arrive. Models that were measurable throughout contribute nothing.
 *
 * This deliberately covers models the chart draws NO line for at all: a model
 * that was never separable has no series to look at, so the list is the only
 * place a reader can find out it exists and why it is missing.
 */
export function summarizeModelGaps(
	models: readonly QuotaDriftModel[],
): QuotaGapLine[] {
	const lines: QuotaGapLine[] = [];
	for (const model of models) {
		const stretch = dominantGap(summarizeGaps(model.points));
		if (!stretch) continue;
		lines.push({ key: model.key, stretch, text: gapStretchText(stretch) });
	}
	return lines;
}
