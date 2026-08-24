import type { QuotaDriftCohort, QuotaDriftModel } from "@clankermux/types";
import { Coins, Loader2 } from "lucide-react";
import {
	cohortLabel,
	formatCapacity,
	formatCoefficient,
	formatInterval,
	quotaWindowLabel,
	supportText,
	unidentifiedReasonText,
} from "../../lib/quota-drift-display";
import { Badge } from "../ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";

/**
 * "How many tokens is a model worth?" — the direct answer, per window.
 *
 * One row per model: the share of the window one million equivalent tokens
 * consumes, its interval, and the implied full-window capacity if the entire
 * window went to that one model.
 *
 * A row is only ever a NUMBER or a STATED REASON. There is no dash, no zero and
 * no greyed-out figure: an unidentified coefficient is not a small number, it
 * is the absence of one, and rendering it as `0.00%` would read as "this model
 * is free".
 */
export function ModelWindowCostPanel({
	cohort,
	loading = false,
}: {
	cohort?: QuotaDriftCohort;
	loading?: boolean;
}) {
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-item">
					<Coins className="h-5 w-5" />
					Window Cost per Model
					{cohort ? (
						<Badge variant="outline" className="ml-auto font-normal">
							{cohortLabel(cohort)}
						</Badge>
					) : null}
				</CardTitle>
				<CardDescription className="text-xs max-w-prose">
					Percentage of the window consumed per 1M price-equivalent tokens
					(input, output and cache weighted by the provider's own list-price
					ratios), with a 90% interval. "Implied capacity" is what the whole
					window would buy at that rate if nothing else ran — in the same
					price-equivalent unit, not raw tokens.
					{cohort?.tierProvenance === "assumed" ? (
						<>
							{" "}
							Tier for this group was inferred from today's account values, not
							recorded per sample.
						</>
					) : null}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-group">
				{loading ? (
					<p className="flex items-center gap-item text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Loading analysis…
					</p>
				) : !cohort || cohort.windows.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No fitted windows for this group yet.
					</p>
				) : (
					cohort.windows.map((window) => (
						<div key={window.window} className="space-y-item">
							<div className="flex flex-wrap items-baseline gap-item">
								<h3 className="text-sm font-medium">
									{quotaWindowLabel(window.window)}
								</h3>
								<span className="text-xs text-muted-foreground">
									{window.nSegments} observations · R² {window.r2.toFixed(2)}
								</span>
							</div>
							{window.models.length === 0 ? (
								<p className="text-sm text-muted-foreground">
									No models carried enough traffic in this window.
								</p>
							) : (
								<div className="overflow-x-auto">
									<table className="w-full text-sm">
										<thead>
											<tr className="text-xs text-muted-foreground text-left">
												<th className="font-normal pb-1">Model</th>
												{/* The unit is in the HEADER, not only in the prose
												    above: a reader scanning the table takes "/ 1M" as
												    raw tokens, and the whole column is in
												    list-price-weighted equivalents. */}
												<th className="font-normal pb-1">
													% of window / 1M eq-tokens
												</th>
												<th className="font-normal pb-1">90% interval</th>
												<th className="font-normal pb-1">Implied capacity</th>
												<th className="font-normal pb-1">Share of traffic</th>
											</tr>
										</thead>
										<tbody>
											{window.models.map((model) => (
												<ModelRow key={model.key} model={model} />
											))}
										</tbody>
									</table>
								</div>
							)}
						</div>
					))
				)}
			</CardContent>
		</Card>
	);
}

function ModelRow({ model }: { model: QuotaDriftModel }) {
	const reason = unidentifiedReasonText(model);
	const share = model.latest?.shareOfWindow;

	if (reason !== null) {
		return (
			<tr className="border-t">
				<td className="py-1.5 font-medium">{model.key}</td>
				{/* One span across the three numeric columns: there is no number to
				    put in any of them, and three repeated placeholders would read as
				    three separate missing values. */}
				<td className="py-1.5 text-muted-foreground" colSpan={3}>
					{reason}
				</td>
				<td className="py-1.5 text-muted-foreground">
					{share == null ? "—" : `${(share * 100).toFixed(1)}%`}
				</td>
			</tr>
		);
	}

	const support = supportText(model);

	return (
		<tr className="border-t">
			<td className="py-1.5 font-medium">
				{model.key}
				{/* How many independent clusters actually carried this model. The
				    interval cannot express it: the bootstrap resamples whole runs, so
				    two runs and forty can print the same width. Rendered only on rows
				    that print a number — see supportText. */}
				{support ? (
					<span className="block text-xs font-normal text-muted-foreground">
						{support}
					</span>
				) : null}
			</td>
			<td className="py-1.5 font-medium">
				{formatCoefficient(model.latest?.pointEstimate ?? null)}
			</td>
			<td className="py-1.5 text-muted-foreground">
				{formatInterval(
					model.latest?.ciLow ?? null,
					model.latest?.ciHigh ?? null,
				)}
			</td>
			<td className="py-1.5">
				{/* "eq-tokens", never bare "tokens": the capacity is 100/coefficient
				    in the same price-equivalent unit the coefficient is denominated
				    in, and calling it tokens invites a reader to compare it against a
				    raw-token budget it is not. formatCapacity already carries the
				    millions multiplier ("45.0M"), so the unit written here is
				    eq-tokens rather than Mtok-eq — the latter would state the million
				    twice. */}
				{formatCapacity(model.latest?.impliedCapacityMtok ?? null)} eq-tokens
			</td>
			<td className="py-1.5 text-muted-foreground">
				{share == null ? "—" : `${(share * 100).toFixed(1)}%`}
			</td>
		</tr>
	);
}
