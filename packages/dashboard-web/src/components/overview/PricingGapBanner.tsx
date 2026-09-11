import type { PricingGap } from "@clankermux/types";
import { AlertTriangle } from "lucide-react";
import { useSystemStatus } from "../../hooks/queries";
import { Button } from "../ui/button";
import { useDismissedPricingGaps } from "./useDismissedPricingGaps";

/**
 * Presentational half of {@link PricingGapBanner}, split out so both render
 * directions can be asserted without a query client.
 *
 * Renders whatever non-empty list the server supplies — it deliberately does NOT
 * re-implement the server's provider suppression (e.g. hiding Ollama), because
 * duplicating that policy in two places invites the two copies to drift apart.
 */
export function PricingGapBannerView({
	gaps,
	onDismiss,
}: {
	gaps: PricingGap[];
	onDismiss?: () => void;
}) {
	if (gaps.length === 0) return null;
	return (
		<div
			role="alert"
			className="flex items-start gap-row p-row rounded-lg bg-warning/15 border border-warning/30"
		>
			<AlertTriangle className="h-5 w-5 text-warning-strong mt-tight shrink-0" />
			<div className="text-sm min-w-0 flex-1">
				<p className="font-medium text-warning-strong">
					Requests recorded without pricing
				</p>
				<p className="text-muted-foreground">
					Requests for these models were recorded without a price since this
					process started. Check the provider&apos;s pricing catalogue before
					recovering missing costs. Dismiss hides these warnings in this browser
					until a new pricing failure occurs.
				</p>
				<ul className="mt-item space-y-tight">
					{gaps.map((gap) => (
						// Keyed on the server-supplied identity, NOT on
						// `provider/modelId`: both of those are sanitized, clipped display
						// labels, so two different entries can present the same pair and
						// hand React a duplicate key.
						<li key={gap.key} className="text-muted-foreground break-all">
							<span className="font-mono text-foreground">{gap.modelId}</span>{" "}
							{/* The server-derived identity, rendered in its OWN node on EVERY
							    row rather than concatenated into the label. `modelId` is
							    client-controlled text: a suffix living inside it could be
							    typed verbatim by a client and would impersonate a genuine
							    fingerprint. Nothing a client can write reaches this node. The
							    tooltip carries the full digest for complete disambiguation. */}
							<span className="font-mono text-xs" title={gap.key}>
								{`#${gap.fingerprint}`}
							</span>
							{" · "}
							{gap.provider}
							{" · "}
							{gap.occurrences}
							{gap.occurrences === 1 ? " request" : " requests"}
							{" · "}
							{gap.reason === "cost_missing"
								? "pricing entry is incomplete"
								: "not in the pricing catalogue"}
						</li>
					))}
				</ul>
				{onDismiss && (
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="mt-item"
						aria-label="Dismiss pricing warnings"
						onClick={onDismiss}
					>
						Dismiss
					</Button>
				)}
			</div>
		</div>
	);
}

/**
 * Banner shown when requests were recorded without a cost because the model
 * missed the pricing catalogue. Returns `null` while there are no gaps so it
 * takes no vertical space in the healthy case, and uses the warn (amber) tone
 * rather than the destructive red of the corruption banner: requests are still
 * served correctly, only costing is degraded.
 *
 */
export function DismissiblePricingGapBanner({ gaps }: { gaps: PricingGap[] }) {
	const { dismiss, isDismissed } = useDismissedPricingGaps();
	const visible = gaps.filter((gap) => !isDismissed(gap));
	return (
		<PricingGapBannerView gaps={visible} onDismiss={() => dismiss(visible)} />
	);
}

/** Reads the System Status poll the Overview already runs, with no new fetching. */
export function PricingGapBanner() {
	const { data } = useSystemStatus();
	return (
		<DismissiblePricingGapBanner gaps={data?.runtime?.pricingGaps ?? []} />
	);
}
