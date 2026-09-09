/**
 * Offline reproduction of the anonymized 2026-09-09 persisted-snapshot evaluation.
 * No database, network or provider I/O. Not a runtime forecast or a new API mode.
 */
import {
	classifyWorkloadGuidance,
	computeWorkloadHeadroom,
	type RunwayAccountSource,
	toRunwayAccountInput,
	type WorkloadHeadroomRow,
} from "../../packages/core/src/index";

const now = Date.parse("2026-09-09T12:36:38.782Z");
const readings = [
	{
		observedAt: "2026-09-09T12:34:56.058Z",
		fiveHour: {
			pct: 42,
			resetMs: 1788970199894,
		},
		sevenDay: {
			pct: 57,
			resetMs: 1789441199894,
		},
		fable: {
			family: "fable",
			percent: 95,
			resetsAtMs: 1789441200894,
		},
	},
	{
		observedAt: "2026-09-09T12:35:30.638Z",
		fiveHour: {
			pct: 1,
			resetMs: 1788969600410,
		},
		sevenDay: {
			pct: 56,
			resetMs: 1789365600411,
		},
		fable: {
			family: "fable",
			percent: 100,
			resetsAtMs: 1789365600411,
		},
	},
	{
		observedAt: "2026-09-09T12:35:30.038Z",
		fiveHour: {
			pct: 0,
			resetMs: 1788970199943,
		},
		sevenDay: {
			pct: 38,
			resetMs: 1789462799943,
		},
		fable: {
			family: "fable",
			percent: 48,
			resetsAtMs: 1789462799944,
		},
	},
	{
		observedAt: "2026-09-09T12:35:13.319Z",
		fiveHour: {
			pct: 34,
			resetMs: 1788960000204,
		},
		sevenDay: {
			pct: 78,
			resetMs: 1789282800204,
		},
		fable: {
			family: "fable",
			percent: 100,
			resetsAtMs: 1789282800205,
		},
	},
	{
		observedAt: "2026-09-09T12:35:30.092Z",
		fiveHour: {
			pct: 0,
			resetMs: 1788965999980,
		},
		sevenDay: {
			pct: 58,
			resetMs: 1789329599980,
		},
		fable: {
			family: "fable",
			percent: 100,
			resetsAtMs: 1789329599980,
		},
	},
];

const sources: RunwayAccountSource[] = readings.map((reading, index) => ({
	id: `evaluation-${index + 1}`,
	name: "Evaluation account",
	provider: "anthropic",
	usageData: null,
	prediction: null,
	burnAnchors: null,
	usageObservedAtMs: Date.parse(reading.observedAt),
	windowObservations: {
		fiveHour: reading.fiveHour,
		sevenDay: reading.sevenDay,
		weeklyScoped: reading.fable
			? [
					{
						family: "fable",
						percent: reading.fable.percent,
						resetsAtMs: reading.fable.resetsAtMs,
						displayName: "Fable",
						isActive: true,
					},
				]
			: null,
	},
}));
const weekly = sources.map((source) => ({
	...source,
	windowObservations: source.windowObservations
		? { ...source.windowObservations, fiveHour: null }
		: null,
}));
for (const source of weekly) {
	if (
		toRunwayAccountInput(source).windows.some(
			(window) => window.windowKind === "five_hour",
		)
	) {
		throw new Error("Weekly-only fixture still has a five-hour input");
	}
}
function summarize(rows: WorkloadHeadroomRow[]) {
	return rows.map((row) => ({
		dimension: `${row.dimensionKind}/${row.dimensionId}`,
		eligible: row.eligibleAccountIds.length,
		projected:
			row.eligibleAccountIds.length -
			row.unreadableAccountIds.length -
			row.unopenedAccountIds.length,
		learning: row.learningAccountIds.length,
		longHorizon: {
			kind: row.outcome.kind,
			exhaustsAt:
				"exhaustsAtMs" in row.outcome
					? new Date(row.outcome.exhaustsAtMs).toISOString()
					: null,
			headroom: row.headroom,
			absence: row.headroomAbsence,
			evidence: row.projectionBasis,
			guidance: classifyWorkloadGuidance(row, row),
		},
		nextReset: row.nextReset
			? {
					resetsAt: new Date(row.nextReset.resetsAtMs).toISOString(),
					kind: row.nextReset.outcome.kind,
					exhaustsAt:
						"exhaustsAtMs" in row.nextReset.outcome
							? new Date(row.nextReset.outcome.exhaustsAtMs).toISOString()
							: null,
					headroom: row.nextReset.headroom,
					absence: row.nextReset.headroomAbsence,
					evidence: row.nextReset.projectionBasis,
					guidance: classifyWorkloadGuidance(row, row.nextReset),
				}
			: null,
	}));
}
const combined = summarize(computeWorkloadHeadroom(sources, now));
const weeklyOnly = summarize(computeWorkloadHeadroom(weekly, now));
const baselineClass = combined.find(
	(row) => row.dimension === "class/anthropic",
);
const weeklyClass = weeklyOnly.find(
	(row) => row.dimension === "class/anthropic",
);
if (baselineClass?.projected !== 3 || weeklyClass?.projected !== 5) {
	throw new Error(
		"The captured weekly-coverage result changed; revisit the evaluation report",
	);
}
console.log(
	JSON.stringify(
		{
			evaluatedAt: new Date(now).toISOString(),
			source:
				"Frozen anonymized persisted observations; no live-cache regression or revision anchors",
			model:
				"Existing fixed account burn; weekly-only is a conditional budget scenario, not concurrency advice",
			combined,
			weeklyOnly,
		},
		null,
		2,
	),
);
