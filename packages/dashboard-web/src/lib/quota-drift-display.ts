import type {
	QuotaDriftCohort,
	QuotaDriftModel,
	QuotaDriftPoint,
	QuotaDriftUnidentifiedReason,
	QuotaDriftWindowResult,
} from "@clankermux/types";
import { format } from "date-fns";
import { providerDisplayName } from "../utils/provider-utils";

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
	/**
	 * The earliest instant the stretch's claim is established for, ms since epoch.
	 *
	 * REASON-SENSITIVE, because the two kinds of reason establish different
	 * things — see {@link gapFromMs}. `no-exposure` names the first window's
	 * START; every other reason names the first window's END.
	 */
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
 * The earliest instant one unmeasured point's reason is established for.
 *
 * A rolling point is plotted at its window END and summarises the whole
 * 14-day window behind it, so which of the two boundaries the claim reaches
 * back to depends entirely on WHAT is being claimed:
 *
 *  - `no-exposure` is a statement about the window's CONTENTS. Zero eq-tokens
 *    across the whole window means the model was already absent when the window
 *    opened, so the claim holds from the window's start;
 *  - every other reason — collinearity, sub-floor share, too few segments, a
 *    wide interval, or a reasonless legacy point — is a statement about the FIT
 *    plotted at the window's end. That one fit failed. Nothing about it
 *    establishes that a fit ending 14 days earlier would have, so dating the
 *    failure at the window's start would claim it up to two weeks before the
 *    evidence supports.
 */
function gapFromMs(
	reason: QuotaDriftUnidentifiedReason | null,
	point: QuotaDriftPoint,
): number {
	return reason === "no-exposure" ? point.windowStartMs : point.windowEndMs;
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
				fromMs: gapFromMs(reason, point),
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
			: `not measurable ${gapPeriodText(stretch)}`;
	}
	if (stretch.entireSeries) return GAP_THROUGHOUT[stretch.reason];
	return `${GAP_WITH_PERIOD[stretch.reason]} ${gapPeriodText(stretch)}`;
}

/**
 * The period suffix a stretch's sentence ends with.
 *
 * The single-window case gets its own wording rather than "from X to X".
 * Repeating one date either side of "to" reads as a span; what actually
 * happened is that ONE fit failed, and only a reason dated at the window's end
 * (see {@link gapFromMs}) can collapse this way.
 */
function gapPeriodText(stretch: QuotaGapStretch): string {
	if (stretch.ongoing) return `since ${formatGapDate(stretch.fromMs)}`;
	if (stretch.fromMs === stretch.toMs)
		return `in the fit ending ${formatGapDate(stretch.toMs)}`;
	return `from ${formatGapDate(stretch.fromMs)} to ${formatGapDate(stretch.toMs)}`;
}

/** One unmeasured stretch, ready to render. */
export interface QuotaGapLine {
	/**
	 * Stable identity for this stretch, `<model>@<toMs>`.
	 *
	 * A model can contribute several lines, so the model key alone is not unique
	 * and would collide as a React key. `toMs` is the discriminator because it is
	 * the one boundary every reason places the same way, and two stretches of one
	 * model can never end on the same fit window.
	 */
	id: string;
	stretch: QuotaGapStretch;
	text: string;
}

/** Every unmeasured stretch of one model, oldest first. */
export interface QuotaModelGaps {
	key: string;
	lines: QuotaGapLine[];
}

/**
 * Every unmeasured stretch of every model, grouped by model and in the order
 * the models arrive. Models that were measurable throughout contribute nothing.
 *
 * ALL of them, not the longest one. A model can be below the share floor early,
 * measurable in the middle and out of use at the end, and those are three
 * different answers to "why is the line missing here". Reducing them to one
 * discards the reader's actual question.
 *
 * This is the COLLAPSED content behind the panel's expander, not body copy:
 * rendered open it is a fifty-line ledger nobody reads. The default view
 * carries none of it — the cost table above the charts already names each
 * model's current reason, so the expander exists for the reader who wants
 * the dated history.
 */
export function summarizeModelGaps(
	models: readonly QuotaDriftModel[],
): QuotaModelGaps[] {
	const out: QuotaModelGaps[] = [];
	for (const model of models) {
		const stretches = summarizeGaps(model.points);
		if (stretches.length === 0) continue;
		out.push({
			key: model.key,
			lines: stretches.map((stretch) => ({
				id: `${model.key}@${stretch.toMs}`,
				stretch,
				text: gapStretchText(stretch),
			})),
		});
	}
	return out;
}

/* ── Windows that never moved ───────────────────────────────────────────── */

/** Full day label for a flat-window boundary, e.g. `12 Jul 2026`. */
function formatFlatDate(ms: number): string {
	return format(new Date(ms), "d MMM yyyy");
}

/** `0%`, `12.5%` — the constant value a window has been reporting. */
function formatFlatValue(pct: number): string {
	return `${pct.toFixed(1).replace(/\.0$/, "")}%`;
}

/**
 * One sentence for a window the provider has reported without change, or null
 * when it did move (or when we cannot say it did not).
 *
 * The wording states a MEASUREMENT and nothing else: what was reported, over
 * which period, ending at the newest reading we have. Two things it must never
 * become:
 *
 *  - an inference about the provider ("the limit was removed", "this window no
 *    longer applies"). The percentage series cannot support any of that;
 *  - a claim that spans time we did not observe. The closing date is the last
 *    actual reading, so a window frozen by a STALLED SAMPLER is visible as an
 *    old end date instead of reading like a live provider fact.
 *
 * `flatSince` is already gated on traffic having been sent against the window,
 * so the sentence may say so.
 *
 * The third thing it must never become is a claim about accounts it was not
 * established on. `flatScope` says whether every still-sampled account in the
 * cohort was checked, or only the ones whose readings still carry this window,
 * and the wording is qualified accordingly. An ABSENT scope — a cached payload
 * written before the field existed — reads as the qualified form: it cannot
 * vouch for the wider claim, and the narrower one is true either way.
 */
export function flatWindowNotice(
	provider: string,
	window: QuotaDriftWindowResult,
): string | null {
	const since = window.flatSince ?? null;
	const lastObserved = window.lastObservedMs ?? null;
	if (since === null || lastObserved === null) return null;

	const name = providerDisplayName(provider);
	const value = window.flatValuePct ?? null;
	const everyAccount = window.flatScope === "all-accounts";
	const what =
		value === null
			? // Each account is constant, at values that disagree — so there is no
				// single number to name, and inventing one would be a fabrication.
				`has reported an unchanged value for this window on every account${
					everyAccount ? "" : " still reporting it"
				}`
			: `has reported ${formatFlatValue(value)} for this window${
					everyAccount ? "" : " on the accounts still reporting it"
				}`;
	return (
		`${name} ${what} since ${formatFlatDate(since)}, ` +
		`through the latest reading on ${formatFlatDate(lastObserved)}, ` +
		"while this proxy kept sending traffic against it. " +
		"There is nothing here to measure."
	);
}

/* ── Windows our readings no longer include ─────────────────────────────── */

/** How a notice names the value a window reports. */
function windowValueLabel(window: string): string {
	if (window === "five_hour") return "a 5-hour value";
	if (window === "seven_day") return "a weekly value";
	return "a value for this window";
}

/**
 * One sentence for a window our readings have stopped carrying a value for, or
 * null when they still carry one (or when we cannot say when they stopped).
 *
 * ## The claim is about OUR readings, and the wording has to stay inside that
 *
 * What the payload records is a null percentage, which proves absence from the
 * NORMALIZED reading and nothing else: a missing field, an explicit null, a
 * non-finite value and an unrecognised limits shape all reduce to the same
 * null, so a normalizer bug and a provider change are indistinguishable from
 * here. The sentence therefore says what our readings did not include, and
 * never that the provider retired, removed or stopped anything — the same
 * discipline {@link flatWindowNotice} keeps, for the same reason.
 *
 * It also carries no permanence. A transient omission produces this sentence
 * and then clears when readings resume, which is correct: it describes a period
 * that was observed, not a state that will continue.
 *
 * ## Three scopes, because the accounts outside the claim are not one group
 *
 * `notReportedScope` says who the absence was established on, and the wording
 * differs by what is known about the rest:
 *
 *  - `all-accounts` — every still-sampled account stopped carrying the window;
 *  - `reporting-subset` — every account outside the claim carries the window in
 *    its newest reading, so the sentence may say the others still report one;
 *  - `partial-cohort` — at least one account outside the claim is not reporting
 *    the window either, and its absence is simply too young or undatable. The
 *    sentence states what was established and stops there.
 *
 * An ABSENT scope — a cached payload written before the field existed — reads
 * as the LAST of those, not the second. Whether the remaining accounts still
 * report the window is exactly what such a payload cannot vouch for, and saying
 * they do would be a false statement about them rather than a cautious one.
 *
 * Both this and {@link flatWindowNotice} can be present at once, on a cohort
 * split between accounts that still report the window and accounts that do not.
 * They are then two facts about two sets of accounts, each already qualified by
 * its own scope, so the panel states both rather than merging them into one
 * history no single account had.
 */
export function notReportedNotice(
	provider: string,
	window: QuotaDriftWindowResult,
): string | null {
	const since = window.notReportedSince ?? null;
	if (since === null) return null;

	const name = providerDisplayName(provider);
	const value = windowValueLabel(window.window);
	const date = formatFlatDate(since);
	if (window.notReportedScope === "all-accounts") {
		return (
			`No ${name} usage reading since ${date} has included ${value}. ` +
			"There is nothing after that date for this chart to measure."
		);
	}
	if (window.notReportedScope === "reporting-subset") {
		return (
			`Some ${name} accounts have included ${value} in no reading ` +
			`since ${date}, while others still report one.`
		);
	}
	// `partial-cohort`, or a payload with no scope at all. What the rest of the
	// cohort's readings currently contain was not established, and the sentence
	// says that instead of guessing which way it went.
	return (
		`Some ${name} accounts have included ${value} in no reading ` +
		`since ${date}. Whether the cohort's other accounts still report one ` +
		"was not established."
	);
}

/**
 * What the last reading that DID carry a value for this window showed, or null
 * when the panel cannot quote one.
 *
 * The reader's next question once a window drops out of the readings is whether
 * it was near exhaustion when it went, and the series alone cannot answer it:
 * the chart plots implied cost per model, not the window percentage, and the
 * flat-window value is null whenever the flat claim was withheld - which is the
 * live case this sentence exists for.
 *
 * ## What it asserts, and what it deliberately does not
 *
 * ONE recorded reading: a date and the percentage that reading contained. Not a
 * level the window "was at" over any period, not the cohort's state, and not
 * anything about now. Two accounts sharing that newest timestamp at different
 * percentages leave nothing to quote, and the server sends null rather than
 * picking one - so an absent value here means the sentence is omitted, never
 * that it renders empty or with a substitute.
 *
 * Shown only alongside {@link notReportedNotice}. While readings still carry
 * the window the newest value is just current usage, which the dashboard states
 * elsewhere and in a form that keeps up with it.
 */
export function lastObservedValueNotice(
	window: QuotaDriftWindowResult,
): string | null {
	if ((window.notReportedSince ?? null) === null) return null;
	const at = window.lastObservedMs ?? null;
	const pct = window.lastObservedValuePct ?? null;
	if (at === null || pct === null) return null;

	return (
		"The most recent reading in this cohort that included " +
		`${windowValueLabel(window.window)}, on ${formatFlatDate(at)}, ` +
		`showed ${formatFlatValue(pct)}.`
	);
}
