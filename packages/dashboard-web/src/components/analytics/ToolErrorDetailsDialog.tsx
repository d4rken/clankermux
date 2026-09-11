import type { ToolErrorSupportingRequest } from "@clankermux/types";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { type AnalyticsRequestFilters, api } from "../../api";
import type { TimeRange } from "../../constants";
import {
	createToolErrorExport,
	formatToolErrorExport,
	type SelectedToolErrorExample,
} from "../../lib/tool-error-export";
import { CopyButton } from "../CopyButton";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";

interface Props {
	toolName: string;
	timeRange: TimeRange;
	filters?: AnalyticsRequestFilters;
	onClose: () => void;
	onRefresh: () => void;
}
interface ViewSelection {
	tool: string;
	range: string;
	to: number;
	sampleId?: number;
	offset?: number;
}
function useErrorDetails(
	selection: ViewSelection,
	filters?: AnalyticsRequestFilters,
) {
	return useQuery({
		queryKey: ["tool-error-details", selection, filters],
		queryFn: () => api.getToolErrors(selection, filters),
		retry: false,
		refetchInterval: false,
		refetchOnWindowFocus: false,
		staleTime: Infinity,
	});
}
function Pagination({
	offset,
	hasMore,
	onChange,
}: {
	offset: number;
	hasMore: boolean;
	onChange: (offset: number) => void;
}) {
	return (
		<div className="flex items-center gap-item">
			<Button
				variant="outline"
				size="sm"
				disabled={offset === 0}
				onClick={() => onChange(Math.max(0, offset - 20))}
			>
				Previous
			</Button>
			<span className="text-xs text-muted-foreground">
				Page {offset / 20 + 1}
			</span>
			<Button
				variant="outline"
				size="sm"
				disabled={!hasMore}
				onClick={() => onChange(offset + 20)}
			>
				Next
			</Button>
		</div>
	);
}
function ReadFailure({ retry }: { retry: () => void }) {
	return (
		<div role="alert" className="space-y-item">
			<p>
				Unable to load error details. The saved message may have expired or the
				analytics worker may be busy.
			</p>
			<Button variant="outline" onClick={retry}>
				Retry
			</Button>
		</div>
	);
}
function date(value: number) {
	return new Date(value).toLocaleString();
}

function GroupDetail({
	selection,
	filters,
}: {
	selection: ViewSelection;
	filters?: AnalyticsRequestFilters;
}) {
	const [offset, setOffset] = useState(0);
	const query = useErrorDetails({ ...selection, offset }, filters);
	const [examples, setExamples] = useState<SelectedToolErrorExample[]>([]);
	const [pending, setPending] = useState<string | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [previewFormat, setPreviewFormat] = useState<"markdown" | "json">(
		"markdown",
	);
	const data = query.data;
	const exported = useMemo(() => {
		if (!data?.detail) return null;
		try {
			const document = createToolErrorExport(data, examples);
			return { document, error: null };
		} catch (error) {
			return {
				document: null,
				error:
					error instanceof Error ? error.message : "Unable to prepare export",
			};
		}
	}, [data, examples]);
	async function load(request: ToolErrorSupportingRequest) {
		if (pending || examples.length >= 3 || !selection.sampleId) return;
		setPending(request.requestId);
		setLoadError(null);
		try {
			const evidence = await api.getToolErrorExample(
				{
					...selection,
					sampleId: selection.sampleId,
					requestId: request.requestId,
				},
				filters,
			);
			setExamples((previous) => [
				...previous.filter(
					(item) => item.request.requestId !== request.requestId,
				),
				{ request, evidence },
			]);
		} catch {
			setLoadError(request.requestId);
		} finally {
			setPending(null);
		}
	}
	if (query.isPending) return <p role="status">Loading supporting requests…</p>;
	if (query.isError || !data?.detail)
		return <ReadFailure retry={() => void query.refetch()} />;
	const detail = data.detail;
	return (
		<div className="min-w-0 space-y-group">
			<div>
				<h3 className="text-sm font-medium">Saved error message</h3>
				<pre className="mt-item whitespace-pre-wrap break-words rounded-md bg-muted p-group text-xs">
					{detail.group.errorText}
				</pre>
				{detail.group.errorText.length >= 500 && (
					<p className="text-xs text-muted-foreground">
						This message may be truncated at the 500-character capture limit.
					</p>
				)}
			</div>
			<p className="text-sm">
				{detail.group.occurrences} captured occurrences in{" "}
				{detail.distinctRequests} requests. {data.totalErrors} reported errors
				across all messages for this tool.
			</p>
			<p className="text-xs text-muted-foreground">
				{detail.distinctProjects} known projects;{" "}
				{detail.requestsWithoutProject} requests without a project.{" "}
				{detail.knownSessions} known sessions; {detail.requestsWithoutSession}{" "}
				requests without a session. First observed {date(detail.firstObserved)}.
				Last observed {date(detail.lastObserved)}.
			</p>
			<details>
				<summary className="cursor-pointer text-sm">Affected projects</summary>
				<ul className="mt-item text-sm">
					{detail.projects.map((row) => (
						<li key={JSON.stringify(row.project)}>
							{row.project ?? "(no project)"}: {row.requests} requests
						</li>
					))}
				</ul>
				{detail.projectsOmitted > 0 && (
					<p>{detail.projectsOmitted} more projects omitted.</p>
				)}
			</details>
			<div className="space-y-item">
				<h3 className="text-sm font-medium">Supporting requests</h3>
				<p className="text-xs text-muted-foreground">
					Load up to three examples to include in the export. Model names
					describe the request receiving the result.
				</p>
				{detail.requests.map((request) => {
					const selected = examples.find(
						(item) => item.request.requestId === request.requestId,
					);
					return (
						<div
							key={request.requestId}
							className="rounded-md border p-group space-y-item"
						>
							<div className="flex flex-wrap items-center justify-between gap-item">
								<a
									href={`/requests?request=${encodeURIComponent(request.requestId)}`}
									target="_blank"
									rel="noreferrer"
									className="text-sm underline"
								>
									{request.requestId}
								</a>
								<span className="text-xs text-muted-foreground">
									{date(request.timestamp)}
								</span>
							</div>
							<p className="text-xs">
								{request.project ?? "(no project)"} ·{" "}
								{request.model ?? "(model unknown)"} ·{" "}
								{request.payloadAvailable
									? "Payload stored"
									: "No payload stored"}
							</p>
							{selected ? (
								<>
									<p className="text-xs">
										Call details: {selected.evidence.state}
										{selected.evidence.totalMatches > 1
											? ` (${selected.evidence.totalMatches} matching calls)`
											: ""}
									</p>
									<Button
										size="sm"
										variant="outline"
										onClick={() =>
											setExamples((items) =>
												items.filter(
													(item) =>
														item.request.requestId !== request.requestId,
												),
											)
										}
									>
										Remove from export
									</Button>
								</>
							) : (
								<Button
									size="sm"
									variant="outline"
									disabled={pending !== null || examples.length >= 3}
									onClick={() => void load(request)}
								>
									{pending === request.requestId
										? "Loading…"
										: request.payloadAvailable
											? "Load call details"
											: "Include request details"}
								</Button>
							)}
							{loadError === request.requestId && (
								<p role="alert" className="text-sm">
									Unable to load this example. Retry using the button above.
								</p>
							)}
						</div>
					);
				})}
				<Pagination
					offset={offset}
					hasMore={detail.hasMore}
					onChange={setOffset}
				/>
			</div>
			{examples.length > 0 && (
				<div className="space-y-item">
					<h3 className="text-sm font-medium">
						Selected examples ({examples.length}/3)
					</h3>
					{examples.map(({ request, evidence }) => (
						<details key={request.requestId} open>
							<summary className="cursor-pointer text-sm">
								{request.requestId}: {evidence.state}
							</summary>
							{evidence.matches.map((match) => (
								<div
									key={`${match.messageIndex}:${match.blockIndex}`}
									className="space-y-item p-item"
								>
									<p className="text-xs">
										Tool call {match.toolUseId ?? "(ID unavailable)"}
									</p>
									<pre className="whitespace-pre-wrap break-words bg-muted p-item text-xs">
										{match.input ?? "Input unavailable"}
										{match.inputTruncated ? "\n[Input excerpt truncated]" : ""}
									</pre>
									<pre className="whitespace-pre-wrap break-words bg-muted p-item text-xs">
										{match.result}
										{match.resultTruncated
											? "\n[Result excerpt truncated]"
											: ""}
									</pre>
								</div>
							))}
							{evidence.omittedMatches > 0 && (
								<p className="text-xs">
									{evidence.omittedMatches} additional matches omitted.
								</p>
							)}
							<Button
								size="sm"
								variant="ghost"
								onClick={() =>
									setExamples((items) =>
										items.filter(
											(item) => item.request.requestId !== request.requestId,
										),
									)
								}
							>
								Remove example
							</Button>
						</details>
					))}
				</div>
			)}
			<div className="space-y-item">
				<h3 className="text-sm font-medium">Copy preview</h3>
				{exported?.error && <p role="alert">{exported.error}</p>}
				{exported?.document && (
					<>
						<div className="flex flex-wrap gap-item">
							<CopyButton
								value={formatToolErrorExport(exported.document, "markdown")}
								variant="outline"
							>
								Copy Markdown
							</CopyButton>
							<CopyButton
								value={formatToolErrorExport(exported.document, "json")}
								variant="outline"
							>
								Copy JSON
							</CopyButton>
							<Button
								size="sm"
								variant="ghost"
								onClick={() =>
									setPreviewFormat((f) =>
										f === "markdown" ? "json" : "markdown",
									)
								}
							>
								Preview {previewFormat === "markdown" ? "JSON" : "Markdown"}
							</Button>
						</div>
						{exported.document.excerptsOmittedForExport > 0 && (
							<p className="text-xs">
								{exported.document.excerptsOmittedForExport} call excerpts
								omitted to keep the export within 64 KiB.
							</p>
						)}
						<pre
							data-testid="tool-error-export-preview"
							className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-group text-xs"
						>
							{formatToolErrorExport(exported.document, previewFormat)}
						</pre>
					</>
				)}
			</div>
		</div>
	);
}

function ToolErrorDetailsView({
	toolName,
	timeRange,
	filters,
	onClose,
	onRefresh,
}: Props) {
	const [to] = useState(() => Date.now());
	const [offset, setOffset] = useState(0);
	const [sampleId, setSampleId] = useState<number | null>(null);
	const selection = { tool: toolName, range: timeRange, to };
	const query = useErrorDetails({ ...selection, offset }, filters);
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Tool error details: {toolName}</DialogTitle>
					<DialogDescription>
						Saved error messages and supporting calls. Up to three texts are
						captured per tool per request, limited to 500 characters each.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-wrap justify-between gap-item">
					<p className="text-xs text-muted-foreground">
						As of {date(to)}. The time window stays fixed while browsing.
					</p>
					<Button size="sm" variant="outline" onClick={onRefresh}>
						Refresh view
					</Button>
				</div>
				{query.isPending ? (
					<p role="status">Loading saved error messages…</p>
				) : query.isError || !query.data ? (
					<ReadFailure retry={() => void query.refetch()} />
				) : (
					<>
						<p className="text-sm">
							{query.data.totalErrors} reported errors ·{" "}
							{query.data.capturedTexts} captured texts ·{" "}
							{query.data.distinctGroups} distinct saved messages
						</p>
						<div className="grid gap-group md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
							<div className="min-w-0 space-y-item">
								<p className="text-xs text-muted-foreground">
									Messages are grouped by identical saved text. Reported errors
									without a captured text cannot appear here.
								</p>
								{query.data.groups.length === 0 ? (
									<p>No saved error texts in this selection.</p>
								) : (
									query.data.groups.map((group) => (
										<button
											type="button"
											key={group.sampleId}
											aria-pressed={sampleId === group.sampleId}
											onClick={() => setSampleId(group.sampleId)}
											className={`w-full rounded-md border p-group text-left hover:bg-muted ${sampleId === group.sampleId ? "bg-muted" : ""}`}
										>
											<span className="block whitespace-pre-wrap break-words text-xs">
												{group.errorText}
											</span>
											<span className="mt-item block text-xs text-muted-foreground">
												{group.occurrences} captured occurrences
											</span>
										</button>
									))
								)}
								<Pagination
									offset={offset}
									hasMore={query.data.hasMore}
									onChange={setOffset}
								/>
							</div>
							<div className="min-w-0">
								{sampleId === null ? (
									<p className="text-sm text-muted-foreground">
										Select a saved message to inspect its requests and copy
										details.
									</p>
								) : (
									<GroupDetail
										key={sampleId}
										selection={{ ...selection, sampleId }}
										filters={filters}
									/>
								)}
							</div>
						</div>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

export function ToolErrorDetailsDialog(props: Props) {
	return (
		<ToolErrorDetailsView
			key={JSON.stringify([props.toolName, props.timeRange, props.filters])}
			{...props}
		/>
	);
}
