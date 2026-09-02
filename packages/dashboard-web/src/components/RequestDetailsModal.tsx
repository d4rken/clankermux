import { HttpError } from "@clankermux/http-common";
import {
	formatBytes,
	formatCost,
	formatTimestamp,
	formatTokens,
} from "@clankermux/ui-common";
import { Eye, Paperclip } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { api, type RequestPayload, type RequestSummary } from "../api";
import { decodeBase64Utf8 } from "../lib/base64";
import {
	projectAttributionLabel,
	resolveProjectAttributionSource,
} from "../lib/project-attribution";
import {
	getRefusalFallbackBadge,
	getRequestModelPresentation,
} from "../lib/request-model";
import { ConversationView } from "./ConversationView";
import { CopyButton } from "./CopyButton";
import { TokenUsageDisplay } from "./TokenUsageDisplay";
import { Alert } from "./ui/alert";
import { Badge } from "./ui/badge";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "./ui/dialog";
import { Label } from "./ui/label";
import { Skeleton } from "./ui/skeleton";
import { Switch } from "./ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

interface RequestDetailsModalProps {
	request: RequestPayload;
	summary: RequestSummary | undefined;
	isOpen: boolean;
	onClose: () => void;
}

/**
 * Execution errors do not imply that payload hydration failed. In particular,
 * persisted error summaries deliberately carry `request.error`, so using that
 * field as a hydration guard made every historical error row permanently empty.
 */
export function shouldHydrateRequestPayload(
	request: RequestPayload,
	isOpen: boolean,
	hydratedId: string | null,
	failedId: string | null,
): boolean {
	return (
		isOpen &&
		!request.meta?.pending &&
		hydratedId !== request.id &&
		(!request.request || request.meta?.bodiesOmitted === true) &&
		failedId !== request.id
	);
}

/**
 * One "heading + copy button + preformatted payload" block.
 *
 * Five byte-identical copies of this sat inline across the request, response
 * and metadata tabs, which meant five copies each of the heading offset, the
 * `<pre>` padding and the bare `<h3>`.
 */
function PayloadSection({
	title,
	getValue,
	children,
}: {
	title: string;
	getValue: () => string;
	children: ReactNode;
}) {
	return (
		<div>
			<div className="flex items-center justify-between mb-item">
				<h3 className="display-face font-semibold">{title}</h3>
				<CopyButton variant="ghost" size="sm" getValue={getValue}>
					Copy
				</CopyButton>
			</div>
			<pre className="bg-muted p-group rounded-lg overflow-x-auto text-sm font-mono">
				{children}
			</pre>
		</div>
	);
}

/**
 * Stands in for a {@link PayloadSection} while the stored payload is being
 * fetched.
 *
 * The header block is `h-8` because that is exactly what the real header row
 * measures — the `size="sm"` CopyButton beside the heading is the tallest thing
 * in it. The body block cannot be measured the same way: a payload `<pre>` is
 * content-sized and unbounded, so `h-40` is a nominal stand-in rather than a
 * match, chosen to fill the tab without implying a specific payload length.
 *
 * A bare Skeleton carries no role and no accessible text, so the message the
 * replaced text line announced moves to a visually hidden status line and the
 * wrapper carries `aria-busy`. `role="status"` deliberately stays off the
 * decorative blocks.
 */
function PayloadSkeleton({ label }: { label: string }) {
	return (
		<div aria-busy="true" className="space-y-item">
			<span className="sr-only" role="status">
				{label}
			</span>
			<Skeleton className="h-8 w-40" />
			<Skeleton className="h-40 w-full rounded-lg" />
		</div>
	);
}

export function RequestDetailsModal({
	request,
	summary,
	isOpen,
	onClose,
}: RequestDetailsModalProps) {
	const [beautifyMode, setBeautifyMode] = useState(true);
	const [hydrated, setHydrated] = useState<RequestPayload | null>(null);
	const [failedId, setFailedId] = useState<string | null>(null);
	const [loadError, setLoadError] = useState<{
		id: string;
		message: string;
	} | null>(null);

	const effective: RequestPayload =
		hydrated && hydrated.id === request.id ? hydrated : request;

	// Hydrate when we have no request payload at all (legacy case), or when
	// the list view handed us a body-less summary placeholder.
	const needsHydration = shouldHydrateRequestPayload(
		request,
		isOpen,
		hydrated?.id ?? null,
		failedId,
	);

	useEffect(() => {
		if (!needsHydration) return;
		let cancelled = false;
		api
			.getRequestPayload(request.id)
			.then((payload) => {
				if (!cancelled) {
					setHydrated(payload);
					setLoadError(null);
				}
			})
			.catch((err) => {
				if (cancelled) return;
				if (err instanceof HttpError && err.status === 404) {
					setFailedId(request.id);
					return;
				}
				setFailedId(request.id);
				setLoadError({
					id: request.id,
					message: err instanceof Error ? err.message : String(err),
				});
			});
		return () => {
			cancelled = true;
		};
	}, [needsHydration, request.id]);

	const formatJson = (str: string): string => {
		try {
			const parsed = JSON.parse(str);
			return JSON.stringify(parsed, null, 2);
		} catch {
			// If it's not valid JSON, return as-is
			return str;
		}
	};

	const formatHeaders = (headers: Record<string, string>): string => {
		if (!beautifyMode) {
			return Object.entries(headers)
				.map(([key, value]) => `${key}: ${value}`)
				.join("\n");
		}
		return JSON.stringify(headers, null, 2);
	};

	const formatBody = (body: string | null): string => {
		const decoded = decodeBase64Utf8(body);
		if (!beautifyMode) return decoded;
		return formatJson(decoded);
	};

	const _isError = effective.error || !request.meta.success;
	const statusCode = effective.response?.status;
	const executionError =
		request.error ?? summary?.errorMessage ?? effective.error ?? null;
	const payloadUnavailable = failedId === request.id;
	const currentLoadError =
		loadError?.id === request.id ? loadError.message : null;
	const modelPresentation = getRequestModelPresentation(summary);
	const refusalBadge = getRefusalFallbackBadge(summary);
	const requestSucceeded = summary?.success ?? effective.meta?.success;
	// Live summaries carry the source; hydrated historical rows only have the
	// stored envelope's meta block. Falling back keeps both views in agreement.
	const attributionLabel = projectAttributionLabel(
		resolveProjectAttributionSource(
			summary?.projectAttributionSource,
			effective.meta?.projectAttributionSource,
		),
	);

	return (
		<Dialog open={isOpen} onOpenChange={onClose}>
			<DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-item">
						<Eye className="h-5 w-5" />
						Request Details
					</DialogTitle>
					<DialogDescription className="flex items-center justify-between">
						<div className="flex items-center gap-item flex-wrap">
							<span className="font-mono text-sm">
								{formatTimestamp(request.meta.timestamp)}
							</span>
							{statusCode && (
								<Badge
									variant={
										requestSucceeded === false
											? "destructive"
											: statusCode >= 200 && statusCode < 300
												? "success"
												: statusCode >= 400 && statusCode < 500
													? "warning"
													: "destructive"
									}
								>
									{statusCode}
								</Badge>
							)}
							{modelPresentation && (
								<Badge
									variant="secondary"
									title={
										modelPresentation.requestedOnly
											? "Requested model; the provider did not report a served model"
											: "Provider-reported model"
									}
								>
									{modelPresentation.value}
									{modelPresentation.requestedOnly ? " · requested" : ""}
								</Badge>
							)}
							{refusalBadge && (
								<Badge variant="outline" title={refusalBadge.title}>
									{refusalBadge.label}
								</Badge>
							)}
							{summary?.totalTokens && (
								<Badge variant="outline">
									{formatTokens(summary.totalTokens)} tokens
								</Badge>
							)}
							{(summary?.attachmentChars ?? 0) > 0 && (
								<Badge
									variant="outline"
									title="Attached images/documents (decoded size)"
								>
									<Paperclip className="h-3 w-3 mr-tight" />
									{formatBytes(
										Math.round((summary?.attachmentChars ?? 0) * 0.75),
									)}
								</Badge>
							)}
							{summary?.costUsd && summary.costUsd > 0 && (
								<Badge variant="default">{formatCost(summary.costUsd)}</Badge>
							)}
							{attributionLabel && (
								<Badge
									variant="outline"
									title="How this request's project was determined"
								>
									{summary?.project ?? "no project"} · {attributionLabel}
								</Badge>
							)}
						</div>
						<div className="flex items-center gap-item">
							<Label htmlFor="beautify-mode" className="text-sm">
								Beautify
							</Label>
							<Switch
								id="beautify-mode"
								checked={beautifyMode}
								onCheckedChange={setBeautifyMode}
							/>
						</div>
					</DialogDescription>
				</DialogHeader>

				{executionError && (
					<Alert tone="destructive" title={`Error: ${executionError}`} />
				)}
				{effective.meta?.synthetic && (
					<Alert
						tone="warning"
						title={`Rejected locally before upstream dispatch${
							effective.meta.providerName
								? ` by the ${effective.meta.providerName} provider gate`
								: ""
						}${
							effective.meta.failureSource
								? ` (${effective.meta.failureSource})`
								: ""
						}.`}
					/>
				)}
				{payloadUnavailable && (
					<Alert
						tone="warning"
						title={
							currentLoadError
								? `Could not load the stored payload: ${currentLoadError}`
								: "No payload was recorded for this request. Older local rejections and requests recorded while payload storage was disabled only have summary metadata."
						}
					/>
				)}

				<Tabs defaultValue="conversation" className="flex-1 overflow-hidden">
					<TabsList className="grid w-full grid-cols-5">
						<TabsTrigger value="conversation">Conversation</TabsTrigger>
						<TabsTrigger value="request">Request</TabsTrigger>
						<TabsTrigger value="response">Response</TabsTrigger>
						<TabsTrigger value="metadata">Metadata</TabsTrigger>
						<TabsTrigger value="tokens">Token Usage</TabsTrigger>
					</TabsList>

					<TabsContent value="conversation" className="mt-group flex-1 min-h-0">
						<ConversationView
							requestBody={decodeBase64Utf8(effective.request?.body ?? null)}
							responseBody={decodeBase64Utf8(effective.response?.body || null)}
						/>
					</TabsContent>

					<TabsContent
						value="request"
						className="mt-group space-y-group overflow-y-auto max-h-[60vh]"
					>
						{effective.request ? (
							<>
								<PayloadSection
									title="Headers"
									getValue={() => formatHeaders(effective.request.headers)}
								>
									{formatHeaders(effective.request.headers)}
								</PayloadSection>

								{effective.request.body && (
									<PayloadSection
										title="Body"
										getValue={() => formatBody(effective.request.body)}
									>
										{formatBody(effective.request.body)}
									</PayloadSection>
								)}
							</>
						) : needsHydration ? (
							<PayloadSkeleton label="Loading payload" />
						) : (
							<div className="text-center text-muted-foreground py-8">
								No request data available
							</div>
						)}
					</TabsContent>

					<TabsContent
						value="response"
						className="mt-group space-y-group overflow-y-auto max-h-[60vh]"
					>
						{/* Three-way, not two: a rendered response, else a payload still
						    being fetched, else the permanent no-response state. The
						    error branch below never switches on `needsHydration`, so
						    folding the loading state into it would have produced a
						    loading message that can never appear. */}
						{effective.response ? (
							<>
								<PayloadSection
									title="Headers"
									getValue={() =>
										effective.response
											? formatHeaders(effective.response.headers)
											: ""
									}
								>
									{formatHeaders(effective.response.headers)}
								</PayloadSection>

								{effective.response.body && (
									<PayloadSection
										title="Body"
										getValue={() =>
											effective.response
												? formatBody(effective.response.body)
												: ""
										}
									>
										{formatBody(effective.response.body)}
									</PayloadSection>
								)}
							</>
						) : needsHydration ? (
							<PayloadSkeleton label="Loading payload" />
						) : (
							<div className="text-center text-muted-foreground py-8">
								{executionError ? (
									<>
										<p className="text-destructive-strong font-medium">
											Error: {executionError}
										</p>
										<p className="mt-item">No response data available</p>
									</>
								) : (
									<p>No response data available</p>
								)}
							</div>
						)}
					</TabsContent>

					<TabsContent
						value="metadata"
						className="mt-group overflow-y-auto max-h-[60vh]"
					>
						<PayloadSection
							title="Request Metadata"
							getValue={() =>
								beautifyMode
									? JSON.stringify(effective.meta, null, 2)
									: JSON.stringify(effective.meta)
							}
						>
							{beautifyMode
								? JSON.stringify(effective.meta, null, 2)
								: JSON.stringify(effective.meta)}
						</PayloadSection>
					</TabsContent>

					<TabsContent
						value="tokens"
						className="mt-group overflow-y-auto max-h-[60vh]"
					>
						<TokenUsageDisplay summary={summary} />
					</TabsContent>
				</Tabs>
			</DialogContent>
		</Dialog>
	);
}
