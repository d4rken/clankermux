import type { ModelSubstitutionsResponse } from "@clankermux/types";
import { substitutionShare } from "@clankermux/types";
import { Check } from "lucide-react";
import { StatusChip } from "../accounts/StatusChip";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";

/**
 * How often each provider answered as a model other than the one it was sent.
 *
 * Neither the range nor the filters are props: the range lives in the query key
 * so the payload handed here already belongs to the current selection, and this
 * endpoint takes no filters at all. The standard request filters key on the
 * FINAL request's account and model, and a substituted attempt is by design not
 * that attempt — a sibling serves it — so filtering by account would hide the
 * substitution on the account it happened to.
 */
export function ModelSubstitutionCard({
	data,
	loading,
	unavailableReason,
	staleNote,
}: {
	data: ModelSubstitutionsResponse | undefined;
	loading?: boolean;
	unavailableReason?: string | null;
	staleNote?: string | null;
}) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Model substitutions</CardTitle>
				<CardDescription>
					Where a provider answered with a different model than the one it was
					sent. Counted per attempt, not per request: the request itself usually
					succeeds afterwards on another account.
				</CardDescription>
			</CardHeader>
			<CardContent>
				{unavailableReason ? (
					<p className="text-muted-foreground text-sm">{unavailableReason}</p>
				) : loading && !data ? (
					<p className="text-muted-foreground text-sm">Loading…</p>
				) : !data || data.pairs.length === 0 ? (
					// A measured zero, not an empty state: every provider answering as
					// the model it was sent is the result this card exists to confirm.
					<p className="text-muted-foreground text-sm">
						No substitutions in this range. Every answer named the model it was
						asked for.
					</p>
				) : (
					<table className="w-full text-sm">
						<thead>
							<tr className="text-muted-foreground text-left">
								<th className="font-medium pb-item">Account</th>
								<th className="font-medium pb-item">Sent</th>
								<th className="font-medium pb-item">Served</th>
								<th className="font-medium pb-item text-right">Share</th>
								<th className="font-medium pb-item text-right">Attempts</th>
								<th className="font-medium pb-item text-right">Last seen</th>
							</tr>
						</thead>
						<tbody>
							{data.pairs.map((pair) => (
								<tr
									key={`${pair.accountId}/${pair.outgoingModel}/${pair.reportedModel}`}
									className="border-t border-border"
								>
									<td className="py-tight">{pair.accountName}</td>
									<td className="py-tight font-mono text-xs">
										{pair.outgoingModel}
									</td>
									<td className="py-tight font-mono text-xs">
										<span className="inline-flex items-center gap-item">
											{pair.reportedModel}
											{/* Without this the row reads as a failure of
											    enforcement: an accepted swap keeps happening on
											    purpose, and at a share near 100% that is the
											    obvious question to ask. Success tones rather than
											    the Degraded chip's warning tones, because the two
											    are the opposite answer to the same question. */}
											{pair.accepted ? (
												<StatusChip
													className="bg-success/15 text-success-strong border border-success/30 font-sans"
													title={`${pair.outgoingModel} answered as ${pair.reportedModel} is on the accepted list, so it is reported but never failed over.`}
												>
													<Check className="h-3 w-3" aria-hidden="true" />
													Accepted
												</StatusChip>
											) : null}
										</span>
									</td>
									<td className="py-tight text-right">
										{Math.round(substitutionShare(pair) * 100)}%
									</td>
									<td className="py-tight text-right text-muted-foreground">
										{pair.substituted} / {pair.comparable}
									</td>
									<td className="py-tight text-right text-muted-foreground">
										{new Date(pair.lastAtMs).toLocaleString()}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				{staleNote ? (
					<p className="text-muted-foreground text-xs mt-item">{staleNote}</p>
				) : null}
			</CardContent>
		</Card>
	);
}
