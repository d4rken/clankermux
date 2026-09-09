import {
	type RunwayAccountSource,
	scopedFamilyIdle,
	scopedFamilyPresence,
	scopedFamilyReadings,
	scopedWeeklyWindowKind,
	toRunwayAccountInput,
	toScopedFamilyRunwayInput,
} from "./api-key-runway";
import {
	type ConsumptionPaceResult,
	computeCapacityRunway,
	consumptionPace,
	isUnstartedWindow,
	type RunwayAccountInput,
	windowForecast,
} from "./capacity-runway";
import type { ModelFamily } from "./model-mappings";
import { servableClassFor } from "./pool-classes";
import {
	extractSevenDay,
	SEVEN_DAY_ELIGIBLE_PROVIDERS,
} from "./usage-window-extract";
import {
	computeWorkloadHeadroom,
	projectionBasisFor,
	type WorkloadHeadroomRow,
} from "./workload-headroom";

/** Preserve the canonical weekly evidence and anchors; never fabricate provider payloads. */
export function weeklyOnlySource(
	source: RunwayAccountSource,
	now: number,
): RunwayAccountSource {
	const reading = source.usageData
		? extractSevenDay(source.usageData)
		: (source.windowObservations?.sevenDay ?? null);
	const scoped = scopedFamilyReadings(source, now);
	const reported = scopedFamilyPresence(source, now);
	const present =
		reported || scoped?.length
			? new Set([...(reported ?? []), ...(scoped ?? []).map((w) => w.family)])
			: null;
	const idle = scopedFamilyIdle(source, now);
	const weekly =
		reading && (reading.resetMs == null || reading.resetMs > now)
			? reading
			: null;
	return {
		...source,
		usageData: null,
		prediction: null,
		windowObservations: {
			fiveHour: null,
			sevenDay: weekly,
			weeklyScoped: scoped?.filter((w) => w.resetsAtMs > now) ?? null,
			weeklyScopedPresent: present ? [...present] : undefined,
			weeklyScopedIdle: idle ? [...idle] : undefined,
		},
	};
}

export interface WeeklyWorkload {
	row: WorkloadHeadroomRow;
	parentId: string | null;
	inputs: RunwayAccountInput[];
	observedAtMs: number | null;
	coverage: {
		eligibleAccounts: number;
		modeledAccounts: number;
		idleAccounts: number;
		learningAccounts: number;
		unavailableAccounts: number;
	};
	risk: {
		spentAccounts: number;
		atRiskAccounts: number;
		withinBudgetAccounts: number;
		unknownAccounts: number;
	};
	pace: ConsumptionPaceResult;
	paceReason:
		| "partial_coverage"
		| "weak_evidence"
		| "unsupported_credits"
		| "no_deadline"
		| "not_projected"
		| "search_unavailable"
		| "not_applicable"
		| null;
	applicable: boolean;
}

export function computeWeeklyWorkloads(
	sources: readonly RunwayAccountSource[],
	now: number,
): WeeklyWorkload[] {
	const weekly = sources.map((s) => weeklyOnlySource(s, now));
	// Reuse canonical grouping and exclusions without running legacy pace searches.
	const metered = weekly.filter((s) =>
		SEVEN_DAY_ELIGIBLE_PROVIDERS.has(s.provider),
	);
	const rows = computeWorkloadHeadroom(metered, now, 1, {
		probe: false,
		includePresentFamilies: true,
	});
	// Keep non-weekly workloads discoverable without treating paid fallback as subscription budget.
	for (const source of weekly.filter(
		(s) => !s.paused && !SEVEN_DAY_ELIGIBLE_PROVIDERS.has(s.provider),
	)) {
		const id = servableClassFor(source.provider).classId;
		if (rows.some((r) => r.dimensionKind === "class" && r.dimensionId === id))
			continue;
		const placeholder = computeWorkloadHeadroom([source], now, 1, {
			probe: false,
		})[0];
		if (placeholder)
			rows.push({
				...placeholder,
				eligibleAccountIds: [],
				unreadableAccountIds: [],
				learningAccountIds: [],
				unopenedAccountIds: [],
				spentAccountIds: [],
			});
	}
	return rows.map((row) => {
		const members = weekly.filter((s) => row.eligibleAccountIds.includes(s.id));
		const family =
			row.dimensionKind === "family" ? (row.dimensionId as ModelFamily) : null;
		const inputs = members.flatMap((s) => {
			const input = family
				? toScopedFamilyRunwayInput(s, family, now)
				: toRunwayAccountInput(s);
			return input ? [input] : [];
		});
		// The checkpoint includes eligible weekly evidence even if an account/family cannot be modeled.
		const deadlines = members
			.flatMap((s) => toRunwayAccountInput(s).windows)
			.concat(inputs.flatMap((i) => i.windows))
			.filter(
				(w) =>
					w.resetsAtMs !== null &&
					w.resetsAtMs > now &&
					!isUnstartedWindow({
						utilizationPct: w.utilizationPct,
						windowStartMs: w.windowStartMs,
						observedAtMs: w.observedAtMs,
					}),
			)
			.map((w) => w.resetsAtMs as number);
		if (deadlines.length) {
			const endsAt = Math.min(...deadlines);
			const outcome = computeCapacityRunway(inputs, now, endsAt - now, {
				probePaceMargin: false,
			});
			row = {
				...row,
				nextReset: {
					resetsAtMs: endsAt,
					outcome,
					projectionBasis: projectionBasisFor(inputs, outcome, now),
					headroom: null,
					headroomAbsence: null,
				},
			};
		} else row = { ...row, nextReset: null };
		const excluded = new Set([
			...row.unreadableAccountIds,
			...row.unopenedAccountIds,
		]);
		const learning = new Set(row.learningAccountIds);
		const idle = new Set(row.unopenedAccountIds);
		for (const input of inputs) {
			if (!learning.has(input.accountId)) continue;
			if (
				input.windows.some(
					(w) =>
						windowForecast(w, now)?.state === "learning" &&
						w.utilizationPct <= 0,
				)
			)
				idle.add(input.accountId);
		}
		const coverage = {
			eligibleAccounts: members.length,
			modeledAccounts: members.length - excluded.size,
			idleAccounts: idle.size,
			learningAccounts: [...learning].filter((id) => !idle.has(id)).length,
			unavailableAccounts: [...excluded].filter(
				(id) => !learning.has(id) && !idle.has(id),
			).length,
		};
		const risk = {
			spentAccounts: 0,
			atRiskAccounts: 0,
			withinBudgetAccounts: 0,
			unknownAccounts: 0,
		};
		for (const member of members) {
			const input = inputs.find((i) => i.accountId === member.id);
			if (!input?.windows.length) {
				risk.unknownAccounts++;
				continue;
			}
			if (input.windows.some((w) => w.utilizationPct >= 100)) {
				risk.spentAccounts++;
				continue;
			}
			const forecasts = input.windows.map((w) => ({
				window: w,
				forecast: windowForecast(w, now),
			}));
			if (
				forecasts.some(
					({ window: w, forecast: f }) =>
						f?.state === "projected" &&
						f.exhaustsAtMs !== null &&
						w.resetsAtMs !== null &&
						f.exhaustsAtMs < w.resetsAtMs,
				)
			)
				risk.atRiskAccounts++;
			else if (
				forecasts.every(
					({ window: w, forecast: f }) =>
						f?.state === "projected" && w.resetsAtMs !== null,
				)
			)
				risk.withinBudgetAccounts++;
			else risk.unknownAccounts++;
		}
		const applicable = members.some((s) =>
			SEVEN_DAY_ELIGIBLE_PROVIDERS.has(s.provider),
		);
		const next = row.nextReset;
		let paceReason: WeeklyWorkload["paceReason"] = !applicable
			? "not_applicable"
			: !next
				? "no_deadline"
				: excluded.size
					? "partial_coverage"
					: next.projectionBasis !== "measured"
						? "weak_evidence"
						: family && inputs.some((i) => i.codexResetCredits?.credits.length)
							? "unsupported_credits"
							: next.outcome.kind !== "runway" &&
									next.outcome.kind !== "beyond-horizon"
								? "not_projected"
								: null;
		let pace: ConsumptionPaceResult = { state: "unavailable", changePct: null };
		if (!paceReason && next) {
			const direction = next.outcome.kind === "runway" ? "reduce" : "increase";
			pace = consumptionPace(
				inputs,
				now,
				next.resetsAtMs,
				direction,
				family && direction === "reduce"
					? new Set([scopedWeeklyWindowKind(family)])
					: null,
			);
			if (pace.state === "unavailable") paceReason = "search_unavailable";
		}
		const observed = members
			.map((s) => s.usageObservedAtMs)
			.filter((t): t is number => t != null && Number.isFinite(t));
		const parentClasses = [
			...new Set(members.map((s) => servableClassFor(s.provider).classId)),
		];
		return {
			row,
			inputs,
			applicable,
			parentId:
				family && parentClasses.length === 1
					? `class:${parentClasses[0]}`
					: null,
			observedAtMs:
				observed.length === members.length && observed.length
					? Math.min(...observed)
					: null,
			coverage,
			risk,
			pace,
			paceReason,
		};
	});
}
