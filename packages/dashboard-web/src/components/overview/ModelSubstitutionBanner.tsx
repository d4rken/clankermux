import type { ModelSubstitutionPair } from "@clankermux/types";
import { substitutionShare } from "@clankermux/types";
import { ArrowDownRight } from "lucide-react";
import { useModelSubstitutions } from "../../hooks/queries";
import { Button } from "../ui/button";
import { useAcknowledgedSubstitutions } from "./useAcknowledgedSubstitutions";

/**
 * Presentational half, split out so both render directions can be asserted
 * without a query client.
 *
 * Shows only pairs the viewer has never acknowledged. The standing state — an
 * account that has been substituting for days — belongs to the Accounts chip;
 * repeating it here every day would train the eye to skip the banner, and this
 * one has to still work the day a DIFFERENT provider starts doing it.
 */
export function ModelSubstitutionBannerView({
	pairs,
	onAcknowledge,
}: {
	pairs: ModelSubstitutionPair[];
	onAcknowledge?: () => void;
}) {
	if (pairs.length === 0) return null;
	return (
		<div
			role="alert"
			className="flex items-start gap-row p-row rounded-lg bg-warning/15 border border-warning/30"
		>
			<ArrowDownRight className="h-5 w-5 text-warning-strong mt-tight shrink-0" />
			<div className="text-sm min-w-0 flex-1">
				<p className="font-medium text-warning-strong">
					A provider served a different model than it was asked for
				</p>
				<p className="text-muted-foreground">
					These accounts answered as another model. Requests are routed around
					them while it continues. Dismiss hides each pair below until a
					different one appears.
				</p>
				<ul className="mt-item space-y-tight">
					{pairs.map((pair) => (
						<li
							key={`${pair.accountId}/${pair.outgoingModel}/${pair.reportedModel}`}
							className="text-muted-foreground break-all"
						>
							<span className="font-mono text-foreground">
								{pair.outgoingModel}
							</span>
							{" answered as "}
							<span className="font-mono text-foreground">
								{pair.reportedModel}
							</span>
							{" · "}
							{pair.accountName}
							{" · "}
							{pair.substituted} of {pair.comparable} requests (
							{Math.round(substitutionShare(pair) * 100)}%)
						</li>
					))}
				</ul>
				{onAcknowledge && (
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="mt-item"
						aria-label="Dismiss model substitution warnings"
						onClick={onAcknowledge}
					>
						Dismiss
					</Button>
				)}
			</div>
		</div>
	);
}

export function ModelSubstitutionBanner() {
	// Same range and therefore the same cache entry as the Accounts page uses,
	// so opening both pages does not run the scan twice.
	const { data } = useModelSubstitutions("24h");
	const { acknowledge, isAcknowledged } = useAcknowledgedSubstitutions();
	const unseen = (data?.pairs ?? []).filter((pair) => !isAcknowledged(pair));
	return (
		<ModelSubstitutionBannerView
			pairs={unseen}
			onAcknowledge={() => acknowledge(unseen)}
		/>
	);
}
