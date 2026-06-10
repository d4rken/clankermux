import type { CacheFlowPoint } from "@clankermux/types";
import { formatNumber, formatPercentage } from "@clankermux/ui-common";
import { Layers } from "lucide-react";
import { useMemo } from "react";
import { COLORS } from "../../constants";
import { formatCompactNumber, shortLabel } from "../../lib/chart-utils";
import { Badge } from "../ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";

type CacheStatus = "read" | "write" | "uncached";

const STATUS_ORDER: CacheStatus[] = ["read", "write", "uncached"];

const STATUS_LABELS: Record<CacheStatus, string> = {
	read: "Cache read",
	write: "Cache write",
	uncached: "Uncached input",
};

// COLORS has no neutral/muted constant, so uncached uses a literal gray.
const STATUS_COLORS: Record<CacheStatus, string> = {
	read: COLORS.success,
	write: COLORS.warning,
	uncached: "#6b7280",
};

function bucketTokens(row: CacheFlowPoint, status: CacheStatus): number {
	switch (status) {
		case "read":
			return row.cacheReadTokens;
		case "write":
			return row.cacheWriteTokens;
		case "uncached":
			return row.uncachedTokens;
	}
}

function rowTotal(row: CacheFlowPoint): number {
	return row.cacheReadTokens + row.cacheWriteTokens + row.uncachedTokens;
}

function EmptyCacheFlowState({ loading }: { loading: boolean }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Cache Flow</CardTitle>
				<CardDescription>
					Input tokens by cache status, model, and account
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="flex min-h-40 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
					{loading
						? "Loading cache analytics..."
						: "No cache activity in this range"}
				</div>
			</CardContent>
		</Card>
	);
}

function CacheFlowGraph({ flow }: { flow: CacheFlowPoint[] }) {
	const graph = useMemo(() => {
		const modelTotals = new Map<string, number>();
		const accountTotals = new Map<string, number>();

		for (const row of flow) {
			const total = rowTotal(row);
			modelTotals.set(row.model, (modelTotals.get(row.model) ?? 0) + total);
			accountTotals.set(
				row.accountName,
				(accountTotals.get(row.accountName) ?? 0) + total,
			);
		}

		const models = Array.from(modelTotals.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 8);
		const accounts = Array.from(accountTotals.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 8);

		const modelSet = new Set(models.map(([name]) => name));
		const accountSet = new Set(accounts.map(([name]) => name));
		const visibleRows = flow.filter(
			(row) => modelSet.has(row.model) && accountSet.has(row.accountName),
		);

		// Middle-column totals across the visible rows, in fixed order; only
		// statuses with traffic get a node.
		const statusTotals = new Map<CacheStatus, number>();
		const modelStatusLinks = new Map<string, number>();
		const statusAccountLinks = new Map<string, number>();
		for (const row of visibleRows) {
			for (const status of STATUS_ORDER) {
				const tokens = bucketTokens(row, status);
				if (tokens <= 0) continue;
				statusTotals.set(status, (statusTotals.get(status) ?? 0) + tokens);
				const modelKey = `${row.model}|${status}`;
				modelStatusLinks.set(
					modelKey,
					(modelStatusLinks.get(modelKey) ?? 0) + tokens,
				);
				const accountKey = `${status}|${row.accountName}`;
				statusAccountLinks.set(
					accountKey,
					(statusAccountLinks.get(accountKey) ?? 0) + tokens,
				);
			}
		}

		const statuses = STATUS_ORDER.filter(
			(status) => (statusTotals.get(status) ?? 0) > 0,
		).map((status) => [status, statusTotals.get(status) ?? 0] as const);

		const visibleTotal = statuses.reduce((sum, [, tokens]) => sum + tokens, 0);
		const maxTokens = Math.max(
			1,
			...modelStatusLinks.values(),
			...statusAccountLinks.values(),
		);
		const height = Math.max(
			280,
			Math.max(models.length, accounts.length, statuses.length) * 52 + 48,
		);

		return {
			models,
			accounts,
			statuses,
			modelStatusLinks,
			statusAccountLinks,
			visibleTotal,
			maxTokens,
			height,
		};
	}, [flow]);

	const nodeY = (index: number, count: number) => {
		if (count <= 1) return graph.height / 2;
		const top = 40;
		const bottom = graph.height - 40;
		return top + (index * (bottom - top)) / (count - 1);
	};

	const modelY = new Map(
		graph.models.map(([name], index) => [
			name,
			nodeY(index, graph.models.length),
		]),
	);
	const statusY = new Map(
		graph.statuses.map(([status], index) => [
			status,
			nodeY(index, graph.statuses.length),
		]),
	);
	const accountY = new Map(
		graph.accounts.map(([name], index) => [
			name,
			nodeY(index, graph.accounts.length),
		]),
	);

	const leftX = 44;
	const midX = 412;
	const rightX = 760;
	const nodeWidth = 190;

	const strokeWidthFor = (tokens: number) =>
		2 + Math.sqrt(tokens / graph.maxTokens) * 14;

	return (
		<div className="overflow-x-auto">
			<svg
				viewBox={`0 0 980 ${graph.height}`}
				className="h-auto min-w-[760px] w-full"
				role="img"
				aria-label="Cache token flow graph"
			>
				<title>Cache token flow</title>
				{graph.models.flatMap(([model]) =>
					graph.statuses.map(([status]) => {
						const tokens =
							graph.modelStatusLinks.get(`${model}|${status}`) ?? 0;
						if (tokens <= 0) return null;
						const y1 = modelY.get(model) ?? graph.height / 2;
						const y2 = statusY.get(status) ?? graph.height / 2;
						return (
							<g key={`${model}-${status}`}>
								<title>
									{`${model} -> ${STATUS_LABELS[status]}: ${formatNumber(tokens)} tokens`}
								</title>
								<path
									d={`M ${leftX + nodeWidth} ${y1} C 300 ${y1}, 300 ${y2}, ${midX} ${y2}`}
									fill="none"
									stroke={STATUS_COLORS[status]}
									strokeLinecap="round"
									strokeOpacity="0.32"
									strokeWidth={strokeWidthFor(tokens)}
								/>
							</g>
						);
					}),
				)}

				{graph.statuses.flatMap(([status]) =>
					graph.accounts.map(([account]) => {
						const tokens =
							graph.statusAccountLinks.get(`${status}|${account}`) ?? 0;
						if (tokens <= 0) return null;
						const y1 = statusY.get(status) ?? graph.height / 2;
						const y2 = accountY.get(account) ?? graph.height / 2;
						return (
							<g key={`${status}-${account}`}>
								<title>
									{`${STATUS_LABELS[status]} -> ${account}: ${formatNumber(tokens)} tokens`}
								</title>
								<path
									d={`M ${midX + nodeWidth} ${y1} C 660 ${y1}, 660 ${y2}, ${rightX} ${y2}`}
									fill="none"
									stroke={STATUS_COLORS[status]}
									strokeLinecap="round"
									strokeOpacity="0.26"
									strokeWidth={strokeWidthFor(tokens)}
								/>
							</g>
						);
					}),
				)}

				{graph.models.map(([name, tokens], index) => {
					const y = nodeY(index, graph.models.length);
					return (
						<g key={name} transform={`translate(${leftX} ${y - 19})`}>
							<title>{`${name}: ${formatNumber(tokens)} tokens`}</title>
							<rect
								width={nodeWidth}
								height="38"
								rx="6"
								fill="var(--card)"
								stroke="var(--border)"
							/>
							<text
								x="12"
								y="17"
								fill="var(--foreground)"
								fontSize="12"
								fontWeight="600"
							>
								{shortLabel(name, 22)}
							</text>
							<text x="12" y="31" fill="var(--muted-foreground)" fontSize="11">
								{formatCompactNumber(tokens)} tok
							</text>
						</g>
					);
				})}

				{graph.statuses.map(([status, tokens], index) => {
					const y = nodeY(index, graph.statuses.length);
					const share =
						graph.visibleTotal > 0
							? Math.round((tokens / graph.visibleTotal) * 100)
							: 0;
					return (
						<g key={status} transform={`translate(${midX} ${y - 19})`}>
							<title>{`${STATUS_LABELS[status]}: ${formatNumber(tokens)} tokens`}</title>
							<rect
								width={nodeWidth}
								height="38"
								rx="6"
								fill="var(--card)"
								stroke={STATUS_COLORS[status]}
							/>
							<text
								x="12"
								y="17"
								fill="var(--foreground)"
								fontSize="12"
								fontWeight="600"
							>
								{STATUS_LABELS[status]}
							</text>
							<text x="12" y="31" fill="var(--muted-foreground)" fontSize="11">
								{formatCompactNumber(tokens)} tok · {share}%
							</text>
						</g>
					);
				})}

				{graph.accounts.map(([name, tokens], index) => {
					const y = nodeY(index, graph.accounts.length);
					return (
						<g key={name} transform={`translate(${rightX} ${y - 19})`}>
							<title>{`${name}: ${formatNumber(tokens)} tokens`}</title>
							<rect
								width={nodeWidth}
								height="38"
								rx="6"
								fill="var(--card)"
								stroke="var(--border)"
							/>
							<text
								x="12"
								y="17"
								fill="var(--foreground)"
								fontSize="12"
								fontWeight="600"
							>
								{shortLabel(name, 22)}
							</text>
							<text x="12" y="31" fill="var(--muted-foreground)" fontSize="11">
								{formatCompactNumber(tokens)} tok
							</text>
						</g>
					);
				})}
			</svg>
		</div>
	);
}

interface CacheFlowPanelProps {
	cacheFlow?: CacheFlowPoint[];
	loading: boolean;
}

export function CacheFlowPanel({ cacheFlow, loading }: CacheFlowPanelProps) {
	const totals = useMemo(() => {
		let read = 0;
		let write = 0;
		let uncached = 0;
		for (const row of cacheFlow ?? []) {
			read += row.cacheReadTokens;
			write += row.cacheWriteTokens;
			uncached += row.uncachedTokens;
		}
		return { read, write, uncached, total: read + write + uncached };
	}, [cacheFlow]);

	if (!cacheFlow || cacheFlow.length === 0 || totals.total === 0) {
		return <EmptyCacheFlowState loading={loading} />;
	}

	const cacheHitRate = (totals.read / totals.total) * 100;

	return (
		<Card>
			<CardHeader>
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div>
						<CardTitle className="flex items-center gap-2">
							<Layers className="h-5 w-5" />
							Cache Flow
						</CardTitle>
						<CardDescription>
							Input tokens by cache status, model, and account
						</CardDescription>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Badge variant="secondary">
							{formatCompactNumber(totals.total)} input tokens
						</Badge>
						<Badge variant="outline">
							{formatPercentage(cacheHitRate, 0)} cache hit
						</Badge>
					</div>
				</div>
			</CardHeader>
			<CardContent>
				<CacheFlowGraph flow={cacheFlow} />
			</CardContent>
		</Card>
	);
}
