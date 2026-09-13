import type { RoutingAttempt } from "@clankermux/types";
import {
	REASONING_EFFORT_BACKEND_CLAMP,
	REASONING_EFFORT_PROXY_DEFAULT,
	REASONING_EFFORT_REASON_SEPARATOR,
	REASONING_EFFORT_TARGET_MODEL_PROFILE,
} from "@clankermux/types";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";

function formatSnapshot(snapshot: string | null): string {
	if (snapshot === null) return "Snapshot no longer retained";
	try {
		return JSON.stringify(JSON.parse(snapshot), null, 2);
	} catch {
		return "Snapshot unavailable";
	}
}

const REASON_PROSE: Record<string, string> = {
	[REASONING_EFFORT_BACKEND_CLAMP]:
		"the backend does not accept that effort for this model",
	[REASONING_EFFORT_TARGET_MODEL_PROFILE]:
		"the target model has no such effort level",
	[REASONING_EFFORT_PROXY_DEFAULT]: "the request carried no reasoning effort",
};

function formatReason(reason: string): string {
	return reason
		.split(REASONING_EFFORT_REASON_SEPARATOR)
		.map((part) => REASON_PROSE[part] ?? part)
		.join(" and ");
}

/**
 * One sentence, and only when the attempt really adapted something: an
 * unchanged effort is the common case and a row of empty fields on every
 * attempt would bury the ones that matter. A `requested` of null with an
 * `effective` value is the proxy-supplied case, which reads as a substitution
 * rather than a change.
 */
function ReasoningEffortAdaptationLine({
	attempt,
}: {
	attempt: RoutingAttempt;
}) {
	const requested = attempt.reasoning_effort_requested;
	const effective = attempt.reasoning_effort_effective;
	const reason = attempt.reasoning_effort_reason;
	if (reason === null || effective === null) return null;
	return (
		<p>
			Reasoning effort:{" "}
			{requested === null
				? `none requested, sent ${effective}`
				: `asked for ${requested}, sent ${effective}`}{" "}
			— {formatReason(reason)}
		</p>
	);
}

export function RoutingAttemptList({
	attempts,
}: {
	attempts: RoutingAttempt[];
}) {
	if (!attempts.length)
		return <p>No routing attempts were recorded for this request.</p>;
	return (
		<ol className="space-y-3">
			{attempts.map((attempt, index) => (
				<li
					key={attempt.id}
					className="rounded-md border p-3 space-y-2 text-sm"
				>
					<p className="font-medium">
						Attempt {index + 1} · {attempt.provider ?? "Local"} ·{" "}
						{attempt.account_id ?? "No destination"}
					</p>
					<p>
						{attempt.kind === "upstream_send"
							? "Sent upstream"
							: attempt.kind === "local_success"
								? "Completed locally"
								: "Rejected locally"}{" "}
						· {attempt.status ?? "In progress"}
					</p>
					<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
						<dt>Requested model</dt>
						<dd className="font-mono break-all">{attempt.requested_model}</dd>
						<dt>Resolved model</dt>
						<dd className="font-mono break-all">
							{attempt.resolved_model ?? "—"}
						</dd>
						<dt>Sent model</dt>
						<dd className="font-mono break-all">
							{attempt.outgoing_model ?? "—"}
						</dd>
						<dt>Upstream reported</dt>
						<dd className="font-mono break-all">
							{attempt.reported_model ?? "Not reported"}
						</dd>
					</dl>
					<ReasoningEffortAdaptationLine attempt={attempt} />
					{attempt.error && <p>{attempt.error}</p>}
					<details>
						<summary className="cursor-pointer">Routing decision</summary>
						<pre className="overflow-auto whitespace-pre-wrap break-all text-xs">
							{formatSnapshot(attempt.route_snapshot)}
						</pre>
					</details>
				</li>
			))}
		</ol>
	);
}
export function RoutingAttempts({ requestId }: { requestId: string }) {
	const query = useQuery({
		queryKey: ["routing-attempts", requestId],
		queryFn: () =>
			api.get<{ data: RoutingAttempt[] }>(
				`/api/requests/${encodeURIComponent(requestId)}/attempts`,
			),
	});
	if (query.isPending) return <p>Loading routing attempts…</p>;
	if (query.error) return <p role="alert">{query.error.message}</p>;
	return <RoutingAttemptList attempts={query.data.data} />;
}
