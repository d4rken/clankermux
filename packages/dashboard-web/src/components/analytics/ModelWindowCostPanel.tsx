import type { QuotaDriftCohort, QuotaDriftModel } from "@clankermux/types";
import { Coins, Loader2 } from "lucide-react";
import {
	formatCapacity,
	formatCoefficient,
	formatInterval,
	quotaWindowLabel,
	supportText,
	unidentifiedReasonText,
} from "../../lib/quota-drift-display";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import {
	Table,
	TableBody,
	TableCell,
	TableFrame,
	TableHead,
	TableHeader,
	TableRow,
} from "../ui/table";

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
				</CardTitle>
				<CardDescription className="text-xs">
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
								// Bare: one table is emitted per fitted window inside this
								// map, so a frame would stack N borders down the card.
								<TableFrame variant="bare">
									<Table density="compact">
										<TableHeader className="bg-transparent">
											<TableRow className="border-t-0">
												<TableHead>Model</TableHead>
												{/* The unit is in the HEADER, not only in the prose
												    above: a reader scanning the table takes "/ 1M" as
												    raw tokens, and the whole column is in
												    list-price-weighted equivalents. */}
												<TableHead>% of window / 1M eq-tokens</TableHead>
												<TableHead>90% interval</TableHead>
												<TableHead>Implied capacity</TableHead>
												<TableHead>Share of traffic</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{window.models.map((model) => (
												<ModelRow key={model.key} model={model} />
											))}
										</TableBody>
									</Table>
								</TableFrame>
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
			<TableRow>
				<TableCell className="font-medium">{model.key}</TableCell>
				{/* One span across the three numeric columns: there is no number to
				    put in any of them, and three repeated placeholders would read as
				    three separate missing values. */}
				<TableCell className="text-muted-foreground" colSpan={3}>
					{reason}
				</TableCell>
				<TableCell className="figure text-muted-foreground">
					{share == null ? "—" : `${(share * 100).toFixed(1)}%`}
				</TableCell>
			</TableRow>
		);
	}

	const support = supportText(model);

	return (
		<TableRow>
			<TableCell className="font-medium">
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
			</TableCell>
			<TableCell className="figure font-medium">
				{formatCoefficient(model.latest?.pointEstimate ?? null)}
			</TableCell>
			<TableCell className="figure text-muted-foreground">
				{formatInterval(
					model.latest?.ciLow ?? null,
					model.latest?.ciHigh ?? null,
				)}
			</TableCell>
			<TableCell className="figure">
				{/* "eq-tokens", never bare "tokens": the capacity is 100/coefficient
				    in the same price-equivalent unit the coefficient is denominated
				    in, and calling it tokens invites a reader to compare it against a
				    raw-token budget it is not. formatCapacity already carries the
				    millions multiplier ("45.0M"), so the unit written here is
				    eq-tokens rather than Mtok-eq — the latter would state the million
				    twice. */}
				{formatCapacity(model.latest?.impliedCapacityMtok ?? null)} eq-tokens
			</TableCell>
			<TableCell className="figure text-muted-foreground">
				{share == null ? "—" : `${(share * 100).toFixed(1)}%`}
			</TableCell>
		</TableRow>
	);
}
