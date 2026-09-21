import type { DegradedAccount } from "@clankermux/types";
import { substitutionShare } from "@clankermux/types";
import { ArrowDownRight } from "lucide-react";
import { StatusChip } from "./StatusChip";

/**
 * The account is being answered by a model other than the one it is sent.
 *
 * One word on the chip, the evidence in the tooltip: the row already carries
 * plan, priority and rate-limit chips, and a chip that spelled out both model
 * names would dominate them while saying less per pixel. `ArrowDownRight`
 * appears nowhere else in the cluster.
 *
 * Absence is the whole clearing rule. The server decides what counts as
 * degraded NOW — recent enough, frequent enough, over a large enough sample —
 * so an account that stops substituting simply stops appearing in `degraded`
 * and the chip disappears with it. There is nothing to dismiss and no state
 * held here.
 */
export function DegradedChip({
	degraded,
}: {
	degraded: DegradedAccount | undefined;
}) {
	if (!degraded || degraded.pairs.length === 0) return null;
	const title = degraded.pairs
		.map(
			(pair) =>
				`Sent ${pair.outgoingModel}, served ${pair.reportedModel} on ${pair.substituted} of ${pair.comparable} requests (${Math.round(
					substitutionShare(pair) * 100,
				)}%), most recently ${new Date(pair.lastAtMs).toLocaleString()}`,
		)
		.join("\n");
	return (
		<StatusChip
			className="bg-warning/15 text-warning-strong border border-warning/30"
			title={title}
			aria-label={`Degraded: ${title}`}
		>
			<ArrowDownRight className="h-3 w-3" aria-hidden="true" />
			Degraded
		</StatusChip>
	);
}
