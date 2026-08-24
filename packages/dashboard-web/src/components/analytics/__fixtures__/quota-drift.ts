/**
 * Hand-built quota-drift payloads for the Quota-tab panel tests.
 *
 * Deliberately NOT named *.test.ts so bun's runner doesn't pick it up.
 *
 * Each builder isolates ONE state the panels must render differently:
 * measured, unidentified, changed, and underpowered. They are separate rather
 * than one big payload because the assertions are about which of them the panel
 * REFUSES to turn into a number.
 */
import type {
	QuotaDriftCohort,
	QuotaDriftModel,
	QuotaDriftPoint,
	QuotaDriftResponse,
	QuotaDriftUnidentifiedReason,
	QuotaDriftWindowResult,
} from "@clankermux/types";

export const FIXED_NOW = Date.UTC(2026, 2, 15, 12, 0, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

/** A run of identified rolling points around `capacityMtok`. */
export function identifiedPoints(
	count: number,
	capacityMtok: number,
): QuotaDriftPoint[] {
	return Array.from({ length: count }, (_, i) => {
		const point = 100 / capacityMtok;
		return {
			windowStartMs: FIXED_NOW - (count - i) * 2 * DAY - 14 * DAY,
			windowEndMs: FIXED_NOW - (count - i) * 2 * DAY,
			pointEstimate: point,
			ciLow: point * 0.92,
			ciHigh: point * 1.08,
			impliedCapacityMtok: capacityMtok,
			identified: true,
			nSegments: 120,
			unidentifiedReasons: [],
		};
	});
}

/**
 * A run of unidentified points — nulls all the way down, never zeros.
 *
 * The reason is a parameter because the panel's gap list has to say something
 * different for each: a stretch the fit could not separate reads nothing like
 * a stretch where the model was not routed at all.
 */
export function unidentifiedPoints(
	count: number,
	reason: QuotaDriftUnidentifiedReason = "collinear",
): QuotaDriftPoint[] {
	return Array.from({ length: count }, (_, i) => ({
		windowStartMs: FIXED_NOW - (count - i) * 2 * DAY - 14 * DAY,
		windowEndMs: FIXED_NOW - (count - i) * 2 * DAY,
		pointEstimate: null,
		ciLow: null,
		ciHigh: null,
		impliedCapacityMtok: null,
		identified: false,
		nSegments: 120,
		unidentifiedReasons: [reason],
	}));
}

/** A fully measured model: a number, an interval and a `stable` verdict. */
export function measuredModel(
	key = "claude-opus-5",
	capacityMtok = 45,
): QuotaDriftModel {
	const point = 100 / capacityMtok;
	return {
		key,
		points: identifiedPoints(6, capacityMtok),
		latest: {
			pointEstimate: point,
			ciLow: point * 0.92,
			ciHigh: point * 1.08,
			impliedCapacityMtok: capacityMtok,
			shareOfWindow: 0.64,
			identified: true,
			unidentifiedReasons: [],
		},
		changes: [],
		verdict: "stable",
	};
}

/** A model the fit could not separate from the traffic beside it. */
export function unidentifiedModel(key = "claude-haiku-4-5"): QuotaDriftModel {
	return {
		key,
		points: unidentifiedPoints(6),
		latest: {
			pointEstimate: null,
			ciLow: null,
			ciHigh: null,
			impliedCapacityMtok: null,
			shareOfWindow: 0.11,
			identified: false,
			unidentifiedReasons: ["collinear", "wide-interval"],
		},
		changes: [],
		// The scan RAN and found nothing — but on a coefficient that is not
		// identified, so the panel must not report it as "no change detected".
		verdict: "stable",
	};
}

/**
 * A model that was measured and then stopped being routed: identified points
 * first, `no-exposure` ones after.
 *
 * The shape of the biggest empty regions on the live chart, and the case that
 * must NOT read as "too little traffic to measure" — there was no traffic at
 * all, so there was nothing to measure.
 */
export function retiredModel(
	key = "claude-opus-4-8",
	measuredCount = 4,
	retiredCount = 4,
): QuotaDriftModel {
	const capacityMtok = 60;
	const total = measuredCount + retiredCount;
	const at = (
		index: number,
	): { windowStartMs: number; windowEndMs: number } => {
		const windowEndMs = FIXED_NOW - (total - index) * 2 * DAY;
		return { windowStartMs: windowEndMs - 14 * DAY, windowEndMs };
	};
	const points: QuotaDriftPoint[] = [];
	for (let i = 0; i < total; i++) {
		const measured = i < measuredCount;
		const estimate = 100 / capacityMtok;
		points.push({
			...at(i),
			pointEstimate: measured ? estimate : null,
			ciLow: measured ? estimate * 0.94 : null,
			ciHigh: measured ? estimate * 1.06 : null,
			impliedCapacityMtok: measured ? capacityMtok : null,
			identified: measured,
			nSegments: measured ? 140 : 0,
			unidentifiedReasons: measured ? [] : ["no-exposure"],
		});
	}
	return {
		key,
		points,
		// No column in the latest fit at all, which is what the compute path
		// emits for a model with no exposure left.
		latest: null,
		changes: [],
		verdict: "insufficient-evidence",
	};
}

/** A model with a detected step change. */
export function changedModel(key = "claude-sonnet-5"): QuotaDriftModel {
	const model = measuredModel(key, 120);
	return {
		...model,
		changes: [
			{
				boundaryMs: FIXED_NOW - 20 * DAY,
				before: 0.6,
				after: 0.83,
				relativeChange: 0.383,
				direction: "more-expensive",
				adjustedLevel: 0.0007,
				nCandidates: 68,
				nSegmentsBefore: 310,
				nSegmentsAfter: 260,
			},
		],
		verdict: "changed",
	};
}

/** A model whose changepoint scan could not run at all. */
export function underpoweredModel(key = "claude-fable-5"): QuotaDriftModel {
	return {
		...measuredModel(key, 30),
		changes: [],
		verdict: "insufficient-evidence",
	};
}

export function windowResult(
	window: "five_hour" | "seven_day",
	models: QuotaDriftModel[],
	overrides: Partial<QuotaDriftWindowResult> = {},
): QuotaDriftWindowResult {
	return {
		window,
		nSegments: 480,
		r2: 0.94,
		zeroObservedTokenDeltaShare: 0.012,
		models,
		...overrides,
	};
}

export function cohort(
	windows: QuotaDriftWindowResult[],
	overrides: Partial<QuotaDriftCohort> = {},
): QuotaDriftCohort {
	return {
		key: "anthropic|max|20x",
		provider: "anthropic",
		planTier: "max",
		rateLimitTier: "20x",
		accountIds: ["acct-1", "acct-2"],
		tierProvenance: "recorded",
		windows,
		...overrides,
	};
}

/**
 * A cohort as a payload written BEFORE per-point reasons and the movement
 * facts existed: every one of those keys physically absent, not null.
 *
 * The precompute refreshes every 30 minutes and the blob is served without
 * schema validation, so this is what the panel is handed for the first half
 * hour after any deploy.
 */
export function preChangeCohort(): QuotaDriftCohort {
	const built = cohort([
		windowResult("five_hour", [measuredModel(), unidentifiedModel()]),
	]);
	for (const window of built.windows) {
		const legacy = window as unknown as Record<string, unknown>;
		for (const key of [
			"lastMovementMs",
			"lastObservedMs",
			"flatValuePct",
			"flatSince",
		]) {
			delete legacy[key];
		}
		for (const model of window.models) {
			for (const point of model.points) {
				delete (point as unknown as Record<string, unknown>)
					.unidentifiedReasons;
			}
		}
	}
	return built;
}

export function readyResponse(cohorts: QuotaDriftCohort[]): QuotaDriftResponse {
	return {
		status: "ready",
		computedAt: FIXED_NOW,
		computeMs: 58_851,
		cohorts,
	};
}

export const COMPUTING: QuotaDriftResponse = {
	status: "computing",
	computedAt: null,
	computeMs: null,
	cohorts: [],
};
