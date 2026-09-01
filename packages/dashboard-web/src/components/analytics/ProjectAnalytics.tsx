import type { AnalyticsResponse } from "@clankermux/types";
import {
	formatCost,
	formatNumber,
	formatPercentage,
	formatTokens,
} from "@clankermux/ui-common";
import { FolderOpen } from "lucide-react";
import { useMemo } from "react";
import {
	attributionCoverage,
	describeProjectAttribution,
} from "../../lib/project-attribution";
import { cn } from "../../lib/utils";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import {
	Table,
	TableBody,
	TableCell,
	TableFrame,
	TableHead,
	TableHeader,
	TableRow,
} from "../ui/table";
import { PanelEmptyState } from "./PanelEmptyState";

type ProjectBreakdownRow = NonNullable<
	AnalyticsResponse["projectBreakdown"]
>[number];

// Display label only — the API keeps the NULL bucket as `project: null`, never
// as a sentinel string, so a project literally named "no-project" can't collide.
const NO_PROJECT_LABEL = "(no project)";

function projectLabel(project: string | null): string {
	return project ?? NO_PROJECT_LABEL;
}

// Stable identity for keys. Prefixed domains so no real project name (which
// can be arbitrary via the x-project header) can collide with the NULL bucket.
function projectKey(project: string | null): string {
	return project === null ? "null:bucket" : `project:${project}`;
}

interface ProjectAnalyticsProps {
	projectBreakdown: ProjectBreakdownRow[];
	/**
	 * Range-wide attribution coverage from the server. Separate from
	 * `projectBreakdown` because that array is truncated to the top-N projects
	 * and cannot describe the whole range.
	 */
	attributionCoverageTotals?: AnalyticsResponse["projectAttributionCoverage"];
	loading?: boolean;
}

/**
 * Project Breakdown — a per-project table with requests, tokens, plan/api cost
 * split, and success rate. Rows arrive from the server already ordered by
 * total tokens.
 */
export function ProjectAnalytics({
	projectBreakdown,
	attributionCoverageTotals,
	loading = false,
}: ProjectAnalyticsProps) {
	// Coverage comes from the server's range-wide aggregate, never from the
	// rows above: `projectBreakdown` is truncated to the top-N projects, so
	// summing it would report full coverage for a range whose unmeasured rows
	// were cut off. The rows' own per-project figures stay exact either way.
	const coverage = useMemo(
		() => attributionCoverage(attributionCoverageTotals),
		[attributionCoverageTotals],
	);

	if (projectBreakdown.length === 0) {
		return (
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-item">
						<FolderOpen className="h-5 w-5" />
						Project Breakdown
					</CardTitle>
					<CardDescription>
						Requests, tokens, and cost by project
					</CardDescription>
				</CardHeader>
				<CardContent>
					<PanelEmptyState>
						{loading
							? "Loading project analytics..."
							: "No requests in this range"}
					</PanelEmptyState>
				</CardContent>
			</Card>
		);
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-item">
					<FolderOpen className="h-5 w-5" />
					Project Breakdown
				</CardTitle>
				<CardDescription>Requests, tokens, and cost by project</CardDescription>
			</CardHeader>
			<CardContent>
				<TableFrame>
					<Table aria-label="Project breakdown">
						<TableHeader>
							<TableRow>
								<TableHead>Project</TableHead>
								<TableHead className="text-right">Requests</TableHead>
								<TableHead className="text-right">Tokens</TableHead>
								<TableHead className="text-right">Plan Value</TableHead>
								<TableHead className="text-right">Token Cost</TableHead>
								<TableHead className="text-right">Success</TableHead>
								<TableHead className="text-right">Attribution</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{projectBreakdown.map((row) => (
								<TableRow key={projectKey(row.project)}>
									<TableCell
										className={cn(
											"text-muted-foreground",
											row.project == null && "italic",
										)}
									>
										{projectLabel(row.project)}
									</TableCell>
									<TableCell className="figure text-right">
										{formatNumber(row.requests)}
									</TableCell>
									<TableCell className="figure text-right">
										{formatTokens(row.totalTokens)}
									</TableCell>
									<TableCell className="figure text-right">
										{formatCost(row.planCostUsd)}
									</TableCell>
									<TableCell className="figure text-right">
										{formatCost(row.apiCostUsd)}
									</TableCell>
									<TableCell className="figure text-right">
										{formatPercentage(row.successRate, 0)}
									</TableCell>
									<TableCell className="text-right text-muted-foreground">
										{describeProjectAttribution(row)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</TableFrame>
				<p className="mt-item text-xs text-muted-foreground">
					{/* Rows exist by this point (the empty range returns early), so a
					    null percent means the server sent no coverage aggregate —
					    say so instead of implying an empty range or a real 0%. */}
					{coverage.percent === null
						? "Attribution coverage is not reported by this server."
						: `Attribution source known for ${coverage.percent}% of requests in this range (${formatNumber(coverage.measured)} of ${formatNumber(coverage.total)}), including projects beyond the rows listed above. Rows recorded before the source was tracked are excluded from the inference share.`}
				</p>
			</CardContent>
		</Card>
	);
}
