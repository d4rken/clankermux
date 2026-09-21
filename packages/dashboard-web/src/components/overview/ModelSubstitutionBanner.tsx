import type { ModelSubstitutionPair } from "@clankermux/types";
import { substitutionShare } from "@clankermux/types";
import { ArrowDownRight } from "lucide-react";
import { useModelSubstitutions } from "../../hooks/queries";
import { ageLabel } from "../../lib/age-label";
import { Button } from "../ui/button";
import { useAcknowledgedSubstitutions } from "./useAcknowledgedSubstitutions";

/**
 * The window the list is drawn from, and the words the banner uses for it.
 *
 * Kept as one pair in one file: the copy states the bound, so a range changed
 * without the prose is a banner that says the wrong number of hours.
 */
const RANGE = "24h";
const RANGE_LABEL = "24 hours";

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
	now,
	onAcknowledge,
}: {
	pairs: ModelSubstitutionPair[];
	/** The page's clock, so every age on Overview advances on one tick. */
	now: number;
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
				{/* Bounded by the window, because that is the only claim these rows
				    support: they are the whole range, never the server's `degraded`
				    set, so the oldest can be most of a day old. Neither "still
				    happening" nor "handled" fits — the suppression behind the latter
				    is five minutes per hit, in `enforce` mode only. Each row's age
				    is what answers it per pair. */}
				<p className="text-muted-foreground">
					These accounts answered as another model in the last {RANGE_LABEL}.
					Dismiss hides each pair below until a different one appears.
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
							{" · last seen "}
							{/* The age ticks, and this list sits inside role="alert".
							    A live region re-announces content that changes, so the
							    ticking half is hidden from assistive tech and the
							    absolute instant — which never changes — is read
							    instead. Otherwise the whole warning is spoken again
							    every clock tick, with nothing new to report. */}
							<time
								className="whitespace-nowrap"
								dateTime={new Date(pair.lastAtMs).toISOString()}
								title={new Date(pair.lastAtMs).toLocaleString()}
							>
								<span aria-hidden="true">{ageLabel(pair.lastAtMs, now)}</span>
								<span className="sr-only">
									{new Date(pair.lastAtMs).toLocaleString()}
								</span>
							</time>
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

/**
 * What still deserves a banner.
 *
 * Accepted swaps never do. Acknowledging is how a VIEWER says "I have seen
 * this", and it is stored per browser; an exception is the OPERATOR having said
 * it already, server-side. Bannering one would ask them to dismiss their own
 * decision again in every browser they open the dashboard in.
 */
export function unacknowledgedSubstitutions(
	pairs: readonly ModelSubstitutionPair[],
	isAcknowledged: (pair: ModelSubstitutionPair) => boolean,
): ModelSubstitutionPair[] {
	return pairs.filter((pair) => !pair.accepted && !isAcknowledged(pair));
}

export function ModelSubstitutionBanner({ now }: { now: number }) {
	// Same range and therefore the same cache entry as the Accounts page uses,
	// so opening both pages does not run the scan twice.
	const { data } = useModelSubstitutions(RANGE);
	const { acknowledge, isAcknowledged } = useAcknowledgedSubstitutions();
	const unseen = unacknowledgedSubstitutions(data?.pairs ?? [], isAcknowledged);
	return (
		<ModelSubstitutionBannerView
			pairs={unseen}
			now={now}
			onAcknowledge={() => acknowledge(unseen)}
		/>
	);
}
