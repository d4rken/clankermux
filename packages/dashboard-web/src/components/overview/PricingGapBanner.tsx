import type { PricingGap } from "@clankermux/types";
import { AlertTriangle } from "lucide-react";
import { useSystemStatus } from "../../hooks/queries";

/**
 * Presentational half of {@link PricingGapBanner}, split out so both render
 * directions can be asserted without a query client.
 *
 * Renders whatever non-empty list the server supplies — it deliberately does NOT
 * re-implement the server's provider suppression (e.g. hiding Ollama), because
 * duplicating that policy in two places invites the two copies to drift apart.
 */
export function PricingGapBannerView({ gaps }: { gaps: PricingGap[] }) {
	if (gaps.length === 0) return null;
	return (
		<div
			role="alert"
			className="flex items-start gap-3 p-3 rounded-lg bg-warning/15 border border-warning/30"
		>
			<AlertTriangle className="h-5 w-5 text-warning-strong mt-0.5 shrink-0" />
			<div className="text-sm min-w-0">
				<p className="font-medium text-warning-strong">
					Requests recorded without pricing
				</p>
				<p className="text-muted-foreground">
					These models missed the pricing catalogue since this process started,
					so their requests were recorded with no cost and are invisible in cost
					analytics. Add or complete the pricing entry for each model.
				</p>
				<ul className="mt-2 space-y-1">
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
 * Reads the System Status poll the Overview already runs — no new fetching.
 */
export function PricingGapBanner() {
	const { data } = useSystemStatus();
	return <PricingGapBannerView gaps={data?.runtime?.pricingGaps ?? []} />;
}
