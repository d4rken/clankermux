import type { ModelFamily } from "@clankermux/core";
import { listLiveScopedFamilies, mergeScopedFamilies } from "@clankermux/core";
import type { AnalyticsSection } from "@clankermux/types";
import { useQueries } from "@tanstack/react-query";
import React, { useMemo, useState } from "react";
import type { TimeRange } from "../../constants";
import {
	usageScopedHistoryQueryOptions,
	useAccounts,
	useAnalytics,
	usePaymentsSummary,
	useRunway,
	useUsageHistory,
	useUsageScopedHistory,
} from "../../hooks/queries";
import { usePoolUsage } from "../../hooks/usePoolUsage";
import { dataAvailability } from "../../lib/data-availability";
import { AccountPerformanceSection } from "./AccountPerformanceSection";
import { AccountUtilizationCard } from "./AccountUtilizationCard";
import { LimitsCapacityOverview } from "./LimitsCapacityOverview";
import { PaymentsHistoryCard } from "./PaymentsHistoryCard";
import { UsageSawtoothChart } from "./UsageSawtoothChart";

// Account Performance table plus the plan-cost / burn-rate summary band, both
// of which come from `totals`.
//
// Exported so tests seeding the query cache key on the SAME list — a divergent
// list yields `undefined` analytics, and the sections computed from it render
// their own pending state instead of the numbers under test.
export const LIMITS_SECTIONS: readonly AnalyticsSection[] = [
	"totals",
	"accountPerformance",
];

/**
 * Range every family panel starts on, and the range of the always-on discovery
 * read. Weekly windows, so a weekly span.
 */
const DEFAULT_FAMILY_RANGE: TimeRange = "7d";

export const LimitsTab = React.memo(() => {
	// Each time-ranged card owns its own range now (the live pool tiles and
	// utilization card below are range-independent and get no selector).
	const [fiveHourUsageRange, setFiveHourUsageRange] =
		useState<TimeRange>("24h");
	const [sevenDayUsageRange, setSevenDayUsageRange] = useState<TimeRange>("7d");
	const [perfRange, setPerfRange] = useState<TimeRange>("7d");
	// One range per family panel, defaulting to 7d. Sparse: a family the user
	// has not touched shares the discovery query's cache entry.
	const [familyRanges, setFamilyRanges] = useState<
		Partial<Record<ModelFamily, TimeRange>>
	>({});

	const accountsQuery = useAccounts();
	const { data: accounts, isLoading: accountsLoading } = accountsQuery;
	// The runway is computed server-side; this tab owns the query and hands the
	// rows down, so LimitsCapacityOverview stays a pure view component.
	const runwayQuery = useRunway();
	const { data: runway, isLoading: runwayLoading } = runwayQuery;
	const analyticsQuery = useAnalytics(
		perfRange,
		{ accounts: [], models: [], status: "all" },
		"normal",
		false,
		{ sections: LIMITS_SECTIONS },
	);
	const { data: analytics, isLoading: analyticsLoading } = analyticsQuery;
	// One query per window: each graph states the availability of its OWN read.
	const fiveHourUsageQuery = useUsageHistory(fiveHourUsageRange);
	const { data: fiveHourUsageHistory, isLoading: fiveHourUsageHistoryLoading } =
		fiveHourUsageQuery;
	const sevenDayUsageQuery = useUsageHistory(sevenDayUsageRange);
	const { data: sevenDayUsageHistory, isLoading: sevenDayUsageHistoryLoading } =
		sevenDayUsageQuery;
	// Per-model-family weekly history. This one read is always on: it discovers
	// which families HAVE recorded history, which is half of the panel list (the
	// other half is what the accounts currently report). It also serves every
	// family panel still on the default range, since one response carries them
	// all and react-query dedupes the identical key.
	const scopedDefaultQuery = useUsageScopedHistory(DEFAULT_FAMILY_RANGE);
	// Payments-ledger spend summary follows the Account Performance card's range.
	const paymentsQuery = usePaymentsSummary(perfRange);
	const { data: paymentsSummary, isLoading: paymentsLoading } = paymentsQuery;

	// One computation and one clock, shared with the Overview. Both pages used to
	// run their own `computePoolUsage` against their own 30s interval, so the
	// same two numbers could differ between tabs by up to a refresh period.
	const { now, fiveHour: fiveHourPool, sevenDay: weeklyPool } = usePoolUsage();
	// Which per-family panels exist: the union of what the pool reports right now
	// and what has been recorded. Live-only would blink the panel out at every
	// window rollover (a scoped limit disappears from the payload the moment its
	// reset passes) and whenever the accounts read fails; history-only could not
	// show a family whose first snapshot has not been written yet.
	const scopedFamilies = useMemo(
		() =>
			mergeScopedFamilies(
				listLiveScopedFamilies(accounts ?? [], now),
				scopedDefaultQuery.data?.families ?? [],
			),
		[accounts, now, scopedDefaultQuery.data],
	);
	// One query per panel, through the SHARED options so the key and the polling
	// cadence cannot drift from the discovery read above.
	const scopedResults = useQueries({
		queries: scopedFamilies.map((family) =>
			usageScopedHistoryQueryOptions(
				familyRanges[family.family] ?? DEFAULT_FAMILY_RANGE,
			),
		),
	});
	// There is deliberately no page-wide loading gate. Each section states the
	// availability of the ONE query it is computed from, so a slow or failed read
	// can only blank the section that depends on it. `/api/analytics` is the
	// slowest read on this page; letting it hold the whole tab hostage is exactly
	// what hid a resolved runway behind an unrelated request.
	//
	// `pending` is `isLoading && !data`, so a background refetch never blanks a
	// section that already has numbers to show.
	const accountsUnavailable =
		dataAvailability(accountsQuery, accountsLoading).state === "unavailable";
	const accountsPending = accountsLoading && !accounts;
	const accountsUnavailableReason = accountsUnavailable
		? "Account data unavailable"
		: undefined;
	const analyticsUnavailable =
		dataAvailability(analyticsQuery, analyticsLoading).state === "unavailable";
	const analyticsPending = analyticsLoading && !analytics;
	// The sawtooth graphs claim "Collecting data" when they have no rows, which
	// asserts that no history EXISTS. That claim is only true once the read has
	// resolved, so each window carries its own pending/unavailable state.
	const fiveHourUsageUnavailable =
		dataAvailability(fiveHourUsageQuery, fiveHourUsageHistoryLoading).state ===
		"unavailable";
	const sevenDayUsageUnavailable =
		dataAvailability(sevenDayUsageQuery, sevenDayUsageHistoryLoading).state ===
		"unavailable";
	// Same rule the two account-wide panels use, per family: `isError && !data`
	// would let a query that has simply never run fall through to the panel's
	// "Collecting data" claim, which asserts that no history EXISTS.
	const familyPanels = scopedFamilies.map((family, index) => {
		const result = scopedResults[index];
		const unavailable =
			result === undefined ||
			dataAvailability(result, result.isLoading).state === "unavailable";
		return {
			family: family.family,
			displayName: family.displayName,
			usageHistory: result?.data,
			loading: result?.isLoading === true && !result.data,
			unavailableReason: unavailable ? "Usage history unavailable" : undefined,
			range: familyRanges[family.family] ?? DEFAULT_FAMILY_RANGE,
			onRangeChange: (range: TimeRange) =>
				setFamilyRanges((previous) => ({
					...previous,
					[family.family]: range,
				})),
		};
	});
	const paymentsUnavailable =
		dataAvailability(paymentsQuery, paymentsLoading).state === "unavailable";
	const paymentsPending = paymentsLoading && !paymentsSummary;
	// Gated on the runway read ALONE. The response carries the account names its
	// pin labels and causes need, so a failing /api/accounts — which empties the
	// two window panels beside it — must not empty this one too.
	const runwayUnavailable =
		dataAvailability(runwayQuery, runwayLoading).state === "unavailable";
	const runwaysUnavailableReason = runwayUnavailable
		? "Runway data unavailable"
		: undefined;

	const totals = analytics?.totals;
	const accountList = accounts ?? [];
	// Null, never 0: an unresolved analytics read has no figure, and "$0.00"
	// would read as a range that genuinely cost nothing.
	const analyticsResolved = !analyticsPending && !analyticsUnavailable;
	const costSummary = {
		planCostUsd: analyticsResolved ? (totals?.planCostUsd ?? null) : null,
		avgDailyPlanCostUsd: analyticsResolved
			? (totals?.avgDailyPlanCostUsd ?? null)
			: null,
		avgWeeklyPlanCostUsd: analyticsResolved
			? (totals?.avgWeeklyPlanCostUsd ?? null)
			: null,
	};

	return (
		<div className="space-y-section">
			{/* The two rolling windows share one visual hierarchy so their usage,
			    reporting coverage and recovery timing can be compared at a glance. */}
			<LimitsCapacityOverview
				fiveHour={fiveHourPool}
				sevenDay={weeklyPool}
				now={now}
				runways={runway?.keys ?? []}
				accounts={runway?.accounts ?? []}
				windowsLoading={accountsPending}
				windowsUnavailableReason={accountsUnavailableReason}
				runwaysLoading={runwayLoading && !runway}
				runwaysUnavailableReason={runwaysUnavailableReason}
			/>

			{/* Per-account live utilization — grouped with the pool tiles above as the
			    live, range-independent capacity view (no range selector). */}
			<AccountUtilizationCard
				accounts={accountList}
				now={now}
				loading={accountsPending}
				unavailableReason={accountsUnavailableReason}
			/>

			{/* Recorded usage history + forecast; each graph owns its range picker. */}
			<UsageSawtoothChart
				accounts={accountList}
				now={now}
				fiveHour={{
					usageHistory: fiveHourUsageHistory,
					loading: fiveHourUsageHistoryLoading && !fiveHourUsageHistory,
					unavailableReason: fiveHourUsageUnavailable
						? "Usage history unavailable"
						: undefined,
					range: fiveHourUsageRange,
					onRangeChange: setFiveHourUsageRange,
				}}
				sevenDay={{
					usageHistory: sevenDayUsageHistory,
					loading: sevenDayUsageHistoryLoading && !sevenDayUsageHistory,
					unavailableReason: sevenDayUsageUnavailable
						? "Usage history unavailable"
						: undefined,
					range: sevenDayUsageRange,
					onRangeChange: setSevenDayUsageRange,
				}}
				families={familyPanels}
			/>

			{/* Account performance + folded-in Plan Value / Cost / Value Ratio summary;
			    own range picker in the card header. */}
			<AccountPerformanceSection
				accountPerformance={analytics?.accountPerformance ?? []}
				loading={analyticsPending}
				unavailable={analyticsUnavailable}
				range={perfRange}
				onRangeChange={setPerfRange}
				costSummary={costSummary}
				paymentsSummary={paymentsSummary}
			/>

			{/* Recent payments-ledger entries (auto renewals + manual credits). */}
			<PaymentsHistoryCard
				payments={paymentsSummary?.recentPayments ?? []}
				loading={paymentsPending}
				unavailableReason={
					paymentsUnavailable ? "Payments data unavailable" : undefined
				}
			/>
		</div>
	);
});
