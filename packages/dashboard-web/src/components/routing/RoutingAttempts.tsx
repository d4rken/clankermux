import type { RoutingAttempt } from "@clankermux/types";
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
