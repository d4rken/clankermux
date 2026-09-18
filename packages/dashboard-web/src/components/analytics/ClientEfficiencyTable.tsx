import type { ClientEfficiencyRow } from "@clankermux/types";
import { formatNumber, formatTokens, formatUsd } from "@clankermux/ui-common";
import { Users } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "../ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { PanelEmptyState } from "../ui/panel-empty-state";
import {
	Table,
	TableBody,
	TableCell,
	TableFrame,
	TableHead,
	TableHeader,
	TableRow,
} from "../ui/table";
import {
	type ClientEfficiencyGroup,
	type ClientGrouping,
	cacheHitRate,
	costPerRequest,
	declaredHarnessMismatch,
	hasInferredRows,
	inferenceTiers,
	perCoveredRequest,
	rollUpClientEfficiency,
	successRate,
	tokensPerRequest,
	UNKNOWN_HARNESS_LABEL,
} from "./client-efficiency-rollup";
import { type SortDir, SortHeaderButton } from "./sort-header";

interface ClientEfficiencyTableProps {
	rows: readonly ClientEfficiencyRow[];
	/** The server hit its row cap, so these rows are a top-N slice. */
	truncated: boolean;
	loading?: boolean;
}

type SortKey =
	| "label"
	| "requests"
	| "successRate"
	| "cacheHitRate"
	| "avgTokensPerRequest"
	| "avgUncachedInput"
	| "outputTokens"
	| "costPerRequest"
	| "avgContextTokens"
	| "avgToolCount";

const NUMERIC_COLUMNS: Array<{ key: SortKey; label: string }> = [
	{ key: "requests", label: "Requests" },
	{ key: "successRate", label: "Success" },
	{ key: "cacheHitRate", label: "Cache hit" },
	{ key: "avgTokensPerRequest", label: "Avg tokens / req" },
	{ key: "avgUncachedInput", label: "Avg uncached in" },
	{ key: "outputTokens", label: "Tokens out" },
	{ key: "costPerRequest", label: "Cost / req" },
	{ key: "avgContextTokens", label: "Avg context" },
	{ key: "avgToolCount", label: "Avg tools" },
];

/** Every sortable metric of one displayed row, nulls included. */
function metrics(group: ClientEfficiencyGroup): Record<SortKey, number | null> {
	return {
		label: null,
		requests: group.requests,
		successRate: successRate(group),
		cacheHitRate: cacheHitRate(group),
		avgTokensPerRequest: tokensPerRequest(group),
		avgUncachedInput:
			group.requests > 0 ? group.inputTokens / group.requests : null,
		outputTokens: group.outputTokens,
		costPerRequest: costPerRequest(group),
		avgContextTokens: perCoveredRequest(
			group.contextTokensSum,
			group.contextCoveredRequests,
		),
		avgToolCount: perCoveredRequest(
			group.contextToolCountSum,
			group.contextCoveredRequests,
		),
	};
}

function formatMetric(key: SortKey, value: number): string {
	switch (key) {
		case "successRate":
		case "cacheHitRate":
			return `${value.toFixed(1)}%`;
		case "avgTokensPerRequest":
		case "avgUncachedInput":
		case "outputTokens":
		case "avgContextTokens":
			return formatTokens(Math.round(value));
		case "costPerRequest":
			return formatUsd(value);
		case "avgToolCount":
			return value.toFixed(1);
		default:
			return formatNumber(value);
	}
}

/**
 * The harness chip.
 *
 * Observed and inferred must not look alike: an inferred label is a claim about
 * a row the proxy never measured, and the whole point of storing `null` rather
 * than backfilling a guess is that the difference stays visible here. A group
 * carrying even one inferred row is marked, which understates confidence for a
 * mostly-observed group and is the safe direction.
 */
function HarnessChip({ group }: { group: ClientEfficiencyGroup }) {
	const inferred = hasInferredRows(group);
	const name = group.harness ?? UNKNOWN_HARNESS_LABEL;
	const suffix =
		group.otherHarnessCount > 0 ? ` +${group.otherHarnessCount}` : "";
	// Spanning several harnesses and holding inferred rows are independent facts,
	// so the title composes them rather than choosing between them.
	const facts: string[] = [];
	if (group.otherHarnessCount > 0) {
		facts.push(`Harnesses in this group: ${group.allHarnesses.join(", ")}`);
	}
	if (inferred) facts.push(...inferenceTiers(group));
	const title =
		facts.length > 0 ? facts.join(" · ") : "Detected from request headers";

	if (!group.harness && !inferred) {
		return (
			<span
				className="inline-flex items-center rounded-md border border-dashed px-2 py-0.5 text-xs text-muted-foreground"
				title="No harness could be identified for these requests"
			>
				{UNKNOWN_HARNESS_LABEL}
				{suffix}
			</span>
		);
	}

	return (
		<span
			className={
				inferred
					? "inline-flex items-center rounded-md border border-dashed px-2 py-0.5 text-xs text-muted-foreground"
					: "inline-flex items-center rounded-md border border-transparent bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
			}
			title={title}
		>
			{name}
			{inferred ? " (inferred)" : ""}
			{suffix}
		</span>
	);
}

/**
 * Per-client efficiency, rolled up by client or by harness.
 *
 * Both groupings read the SAME payload rows, whose grain is (key × harness).
 * Neither re-queries: a second read under a different grouping could straddle a
 * refresh and show two views of two different request sets side by side.
 */
export function ClientEfficiencyTable({
	rows,
	truncated,
	loading = false,
}: ClientEfficiencyTableProps) {
	const [grouping, setGrouping] = useState<ClientGrouping>("client");
	const [sortKey, setSortKey] = useState<SortKey>("requests");
	const [sortDir, setSortDir] = useState<SortDir>("desc");

	const groups = useMemo(
		() => rollUpClientEfficiency(rows, grouping),
		[rows, grouping],
	);

	const sorted = useMemo(() => {
		const copy = groups.map((group) => ({ group, values: metrics(group) }));
		copy.sort((a, b) => {
			if (sortKey === "label") {
				const cmp = a.group.label.localeCompare(b.group.label);
				return sortDir === "asc" ? cmp : -cmp;
			}
			const av = a.values[sortKey];
			const bv = b.values[sortKey];
			// Nulls sink regardless of direction: "not measurable" is not a small
			// value, and ranking it as one would put unpriced clients at the top of
			// an ascending cost sort.
			if (av == null && bv == null) return 0;
			if (av == null) return 1;
			if (bv == null) return -1;
			return sortDir === "asc" ? av - bv : bv - av;
		});
		return copy;
	}, [groups, sortKey, sortDir]);

	const handleSort = (key: SortKey) => {
		if (key === sortKey) {
			setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
			return;
		}
		setSortKey(key);
		setSortDir(key === "label" ? "asc" : "desc");
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-item">
					<Users className="h-5 w-5" />
					Client efficiency
				</CardTitle>
				<CardDescription>
					How each configured client spends tokens and cache. Rates are computed
					over the whole group, so switching the grouping re-derives them rather
					than averaging averages.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-group">
				<div className="flex flex-wrap gap-item">
					<Button
						type="button"
						size="sm"
						variant={grouping === "client" ? "secondary" : "outline"}
						aria-pressed={grouping === "client"}
						onClick={() => setGrouping("client")}
					>
						By client
					</Button>
					<Button
						type="button"
						size="sm"
						variant={grouping === "harness" ? "secondary" : "outline"}
						aria-pressed={grouping === "harness"}
						onClick={() => setGrouping("harness")}
					>
						By harness
					</Button>
				</div>

				{truncated && (
					<p className="text-xs text-warning-strong">
						The server returned its maximum number of client rows, so these
						totals cover only the busiest clients in range — not every request
						the filters select.
					</p>
				)}

				{loading ? (
					<PanelEmptyState>Loading client efficiency…</PanelEmptyState>
				) : sorted.length === 0 ? (
					<PanelEmptyState>No client activity in this range</PanelEmptyState>
				) : (
					<TableFrame>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>
										<SortHeaderButton
											label={grouping === "client" ? "Client" : "Harness"}
											active={sortKey === "label"}
											dir={sortDir}
											onClick={() => handleSort("label")}
										/>
									</TableHead>
									{NUMERIC_COLUMNS.map((column) => (
										<TableHead key={column.key} className="text-right">
											<SortHeaderButton
												label={column.label}
												active={sortKey === column.key}
												dir={sortDir}
												onClick={() => handleSort(column.key)}
											/>
										</TableHead>
									))}
								</TableRow>
							</TableHeader>
							<TableBody>
								{sorted.map(({ group, values }) => {
									const mismatch = declaredHarnessMismatch(group);
									return (
										<TableRow key={group.key} className="hover:bg-muted/40">
											<TableCell className="align-top">
												{/* Under the harness grouping the chip IS the label:
												    it renders the harness name itself, so a separate
												    label line would print that name twice. */}
												{grouping === "client" && (
													<div className="font-medium">{group.label}</div>
												)}
												<div className="mt-tight flex flex-wrap items-center gap-tight">
													<HarnessChip group={group} />
													{mismatch && (
														<span
															className="text-xs text-warning-strong"
															title="This client's requests were detected as a different harness than its configured application"
														>
															configured as {mismatch}
														</span>
													)}
												</div>
												{group.unpricedRequests > 0 && (
													<div className="text-xs text-muted-foreground">
														{formatNumber(group.unpricedRequests)} unpriced
													</div>
												)}
											</TableCell>
											{NUMERIC_COLUMNS.map((column) => {
												const value = values[column.key];
												return (
													<TableCell
														key={column.key}
														className="figure text-right align-top"
													>
														{value == null
															? "—"
															: formatMetric(column.key, value)}
													</TableCell>
												);
											})}
										</TableRow>
									);
								})}
							</TableBody>
						</Table>
					</TableFrame>
				)}
			</CardContent>
		</Card>
	);
}
