import type { ClientEfficiencyRow } from "@clankermux/types";
import { formatNumber } from "@clankermux/ui-common";
import { Layers } from "lucide-react";
import { useMemo, useState } from "react";
import { useSeriesPalette } from "../../hooks/useSeriesPalette";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { PanelEmptyState } from "../ui/panel-empty-state";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
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
	hasInferredRows,
	perCoveredRequest,
	rollUpClientEfficiency,
} from "./client-efficiency-rollup";
import {
	type BreakdownPart,
	contextParts,
	harnessLabel,
	tokenDifference,
	tokenParts,
} from "./harness-breakdown";

function amount(value: number | null): string {
	return value === null ? "—" : formatNumber(Math.round(value) + 0);
}

function signedAmount(value: number | null): string {
	return value === null
		? "—"
		: `${Math.round(value) > 0 ? "+" : ""}${amount(value)}`;
}

function BreakdownComparison({
	title,
	description,
	baseline,
	comparison,
	parts,
	unit,
}: {
	title: string;
	description: string;
	baseline: ClientEfficiencyGroup;
	comparison?: ClientEfficiencyGroup;
	parts: (group: ClientEfficiencyGroup) => BreakdownPart[];
	unit: string;
}) {
	const palette = useSeriesPalette();
	const groups = comparison ? [baseline, comparison] : [baseline];
	const series = groups.map((group) => ({ group, parts: parts(group) }));
	const totals = series.map((s) =>
		s.parts.some((p) => p.value === null)
			? null
			: s.parts.reduce((sum, p) => sum + (p.value ?? 0), 0),
	);
	const maximum = Math.max(1, ...totals.map((value) => value ?? 0));
	return (
		<section className="min-w-0 space-y-group" aria-label={title}>
			<div>
				<h3 className="text-sm font-medium">{title}</h3>
				<p className="mt-tight text-xs text-muted-foreground">{description}</p>
			</div>
			<div className="space-y-row" aria-hidden="true">
				{series.map(({ group, parts: segments }, index) => (
					<div key={group.key}>
						<div className="mb-tight flex justify-between gap-item text-xs">
							<span>{harnessLabel(group)}</span>
							<span className="figure">
								{amount(totals[index])} {unit}
							</span>
						</div>
						<div className="flex h-3 overflow-hidden rounded-sm bg-muted">
							{segments.map((segment) => (
								<span
									key={segment.label}
									style={{
										width: `${(100 * (segment.value ?? 0)) / maximum}%`,
										backgroundColor: palette.hue[segment.hue],
									}}
								/>
							))}
						</div>
					</div>
				))}
			</div>
			<TableFrame>
				<Table aria-label={title}>
					<TableHeader>
						<TableRow>
							<TableHead>Per request</TableHead>
							{groups.map((group) => (
								<TableHead key={group.key} className="text-right">
									{harnessLabel(group)}
								</TableHead>
							))}
							{comparison && (
								<TableHead
									className="text-right"
									title={`${harnessLabel(comparison)} minus ${harnessLabel(baseline)}`}
								>
									Difference
								</TableHead>
							)}
						</TableRow>
					</TableHeader>
					<TableBody>
						{series[0].parts.map((part, index) => {
							const other = series[1]?.parts[index].value;
							return (
								<TableRow key={part.label}>
									<TableCell>
										<span className="inline-flex items-center gap-item">
											<span
												aria-hidden="true"
												className="h-2.5 w-2.5 shrink-0 rounded-sm"
												style={{ backgroundColor: palette.hue[part.hue] }}
											/>
											{part.label}
										</span>
									</TableCell>
									<TableCell className="figure text-right">
										{amount(part.value)}
									</TableCell>
									{comparison && (
										<>
											<TableCell className="figure text-right">
												{amount(other ?? null)}
											</TableCell>
											<TableCell className="figure text-right">
												{signedAmount(
													part.value === null || other == null
														? null
														: other - part.value,
												)}
											</TableCell>
										</>
									)}
								</TableRow>
							);
						})}
						<TableRow className="font-medium">
							<TableCell>Total {unit}</TableCell>
							{totals.map((total, index) => (
								<TableCell
									key={groups[index].key}
									className="figure text-right"
								>
									{amount(total)}
								</TableCell>
							))}
							{comparison && (
								<TableCell className="figure text-right">
									{signedAmount(
										totals[0] === null || totals[1] === null
											? null
											: totals[1] - totals[0],
									)}
								</TableCell>
							)}
						</TableRow>
					</TableBody>
				</Table>
			</TableFrame>
		</section>
	);
}

function HarnessSelector({
	label,
	value,
	groups,
	onChange,
}: {
	label: string;
	value: string;
	groups: ClientEfficiencyGroup[];
	onChange: (key: string) => void;
}) {
	return (
		<div className="min-w-0 space-y-tight">
			<p className="text-xs text-muted-foreground">{label}</p>
			<Select value={value} onValueChange={onChange}>
				<SelectTrigger aria-label={label} className="w-full sm:w-48">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{groups.map((group) => (
						<SelectItem key={group.key} value={group.key}>
							{harnessLabel(group)}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

export function HarnessBreakdownPanel({
	rows,
	truncated = false,
	loading = false,
}: {
	rows: readonly ClientEfficiencyRow[];
	truncated?: boolean;
	loading?: boolean;
}) {
	const groups = useMemo(
		() =>
			rollUpClientEfficiency(rows, "harness").sort(
				(a, b) => b.requests - a.requests || a.label.localeCompare(b.label),
			),
		[rows],
	);
	const [baselineKey, setBaselineKey] = useState<string>();
	const [comparisonKey, setComparisonKey] = useState<string>();
	const baseline =
		groups.find((group) => group.key === baselineKey) ??
		groups.find((group) => group.label === "claude-code") ??
		groups[0];
	const alternatives = groups.filter((group) => group.key !== baseline?.key);
	const comparison =
		alternatives.find((group) => group.key === comparisonKey) ??
		alternatives.find((group) => group.label === "pi") ??
		alternatives[0];
	const selected = baseline
		? comparison
			? [baseline, comparison]
			: [baseline]
		: [];
	const difference =
		baseline && comparison ? tokenDifference(baseline, comparison) : null;
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-item">
					<Layers className="h-5 w-5" />
					What makes up the difference
				</CardTitle>
				<CardDescription>
					Compare recorded token use and the content carried in each request.
					The model, project and time filters above apply here too.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-group">
				{loading ? (
					<PanelEmptyState>Loading harness breakdown…</PanelEmptyState>
				) : !baseline ? (
					<PanelEmptyState>No client activity in this range</PanelEmptyState>
				) : (
					<>
						<div className="flex flex-wrap items-end gap-group">
							<HarnessSelector
								label="Baseline harness"
								value={baseline.key}
								groups={groups}
								onChange={setBaselineKey}
							/>
							{comparison && (
								<HarnessSelector
									label="Comparison harness"
									value={comparison.key}
									groups={alternatives}
									onChange={setComparisonKey}
								/>
							)}
						</div>
						{truncated && (
							<p className="text-xs text-warning-strong">
								This comparison covers only the busiest client rows returned by
								the server.
							</p>
						)}
						<div className="grid gap-group sm:grid-cols-2">
							{selected.map((group) => (
								<div
									key={group.key}
									className="rounded-md border px-group py-item text-xs"
								>
									<div className="font-medium">
										{harnessLabel(group)} · {formatNumber(group.requests)}{" "}
										requests
									</div>
									<p className="mt-tight text-muted-foreground">
										{formatNumber(group.observedRequests)} observed
										{hasInferredRows(group)
											? ` · ${formatNumber(group.inferredSessionRequests + group.inferredDeclaredRequests)} inferred`
											: ""}
										{!group.harness ? " · harness unidentified" : ""}
									</p>
									<p className="mt-tight text-muted-foreground">
										Context measured for{" "}
										{formatNumber(group.contextBreakdown.coveredRequests)} of{" "}
										{formatNumber(group.requests)} requests
										{group.contextBreakdown.coveredRequests > 0
											? ` · ${perCoveredRequest(group.contextBreakdown.messageCountSum, group.contextBreakdown.coveredRequests)?.toFixed(1)} messages/request`
											: ""}
									</p>
								</div>
							))}
						</div>
						{difference && comparison && (
							<p
								className="rounded-md border border-dashed px-group py-item text-sm"
								aria-live="polite"
							>
								{Math.abs(difference.delta) < 0.5 ? (
									"These harnesses record the same average tokens per request (rounded)."
								) : (
									<>
										{harnessLabel(comparison)} records{" "}
										<strong>
											{amount(Math.abs(difference.delta))}{" "}
											{difference.delta < 0 ? "fewer" : "more"} tokens/request
										</strong>{" "}
										than {harnessLabel(baseline)}.
										{Math.round(Math.abs(difference.driverDelta)) > 0 && (
											<>
												{" "}
												The largest{" "}
												{difference.delta < 0 ? "decrease" : "increase"} is{" "}
												{difference.driver.toLowerCase()} (
												{amount(Math.abs(difference.driverDelta))}{" "}
												{difference.driverDelta < 0 ? "fewer" : "more"}).
											</>
										)}
									</>
								)}
							</p>
						)}
						<div className="grid gap-section xl:grid-cols-2">
							<BreakdownComparison
								title="Recorded tokens"
								description="Average per attempted request. Cache reads count fully toward tokens; cost per request reflects their price. Missing usage contributes zero to this average."
								baseline={baseline}
								comparison={comparison}
								parts={tokenParts}
								unit="tokens"
							/>
							<BreakdownComparison
								title="Context carried"
								description="Average characters per fully measured request (coverage above). Tool results and other history are separate portions of the conversation. Attachments’ binary data is excluded."
								baseline={baseline}
								comparison={comparison}
								parts={contextParts}
								unit="chars"
							/>
						</div>
						<p className="text-xs text-muted-foreground">
							{comparison
								? `Differences are ${harnessLabel(comparison)} minus ${harnessLabel(baseline)}. `
								: "Only one harness is present in this selection. "}
							Other history includes message text, tool arguments, thinking and
							opaque signatures. Characters are not token estimates. Different
							models, tasks and conversation lengths can explain differences in
							consumption; this does not measure task quality.
						</p>
					</>
				)}
			</CardContent>
		</Card>
	);
}
