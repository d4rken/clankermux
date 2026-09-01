import type { QuotaDriftResponse } from "@clankermux/types";
import {
	AlertTriangle,
	Loader2,
	Scale,
	TrendingDown,
	TrendingUp,
} from "lucide-react";
import {
	cohortLabel,
	formatRelativeChange,
	isReportableVerdict,
	quotaWindowLabel,
} from "../../lib/quota-drift-display";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { InsetPanel } from "../ui/inset-panel";

/**
 * Headline callouts for the Quota tab, plus the standing statement of what
 * these numbers are not.
 *
 * The caveat block is NOT decoration and is not optional. This panel makes
 * claims about a provider's behaviour from indirect evidence, and four
 * different causes move the measurement identically. Every reader who sees a
 * verdict has to see the list on the same screen, which is why it lives here
 * rather than in a doc, a tooltip, or an expandable.
 */
export function QuotaChangeVerdicts({
	data,
	loading = false,
}: {
	data?: QuotaDriftResponse;
	loading?: boolean;
}) {
	const computing = data?.status === "computing";
	const cohorts = data?.cohorts ?? [];

	// Every model whose verdict is safe to report as a verdict. A
	// `no-change-detected` on an unidentified coefficient is deliberately
	// excluded — see isReportableVerdict.
	const callouts = cohorts.flatMap((cohort) =>
		cohort.windows.flatMap((window) =>
			window.models
				.filter(isReportableVerdict)
				.map((model) => ({ cohort, window, model })),
		),
	);
	const changed = callouts.filter((c) => c.model.verdict === "changed");
	const unchanged = callouts.filter(
		(c) => c.model.verdict === "no-change-detected",
	);
	const anyAssumed = cohorts.some((c) => c.tierProvenance === "assumed");
	const hiddenLowerBound = Math.max(
		0,
		...cohorts.flatMap((c) =>
			c.windows.map((w) => w.zeroObservedTokenDeltaShare),
		),
	);

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-item">
					<Scale className="h-5 w-5" />
					Implied Window Cost
				</CardTitle>
				<CardDescription className="text-xs">
					How much of a usage window this proxy's own traffic implies a model
					consumes, fitted from the provider's reported percentages against the
					requests recorded here. It covers all retained history, not the window
					selected elsewhere on this page.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-group">
				{loading ? (
					<p className="flex items-center gap-item text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Loading analysis…
					</p>
				) : computing ? (
					<p className="flex items-center gap-item text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Computing — the first pass has not finished yet. This runs every 30
						minutes; nothing is missing.
					</p>
				) : callouts.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						Nothing measurable yet. A model needs enough traffic of its own,
						separable from whatever ran alongside it, before its cost against a
						window can be estimated at all.
					</p>
				) : (
					<div className="space-y-item">
						{changed.map(({ cohort, window, model }) =>
							model.changes.map((change) => (
								<p
									key={`${cohort.key}-${window.window}-${model.key}-${change.boundaryMs}`}
									className="flex items-start gap-item text-sm"
								>
									{change.direction === "cheaper" ? (
										<TrendingDown className="h-4 w-4 mt-0.5 shrink-0 text-success-strong" />
									) : (
										<TrendingUp className="h-4 w-4 mt-0.5 shrink-0 text-destructive-strong" />
									)}
									<span>
										<span className="font-medium">{model.key}</span> on the{" "}
										{quotaWindowLabel(window.window).toLowerCase()}:{" "}
										<span className="font-medium">
											observed change in implied cost of{" "}
											{formatRelativeChange(change.relativeChange)}
										</span>{" "}
										around {new Date(change.boundaryMs).toLocaleDateString()} (
										{cohortLabel(cohort)}).
									</span>
								</p>
							)),
						)}
						{unchanged.length > 0 ? (
							<p className="text-sm text-muted-foreground">
								No change detected for{" "}
								{unchanged
									.map(
										(c) =>
											`${c.model.key} (${quotaWindowLabel(c.window.window).toLowerCase()})`,
									)
									.join(", ")}
								. The test ran and found nothing; that is different from not
								having enough evidence to run it.
							</p>
						) : null}
					</div>
				)}

				{/* ── What this measurement is not ─────────────────────────────── */}
				<InsetPanel className="rounded-lg border-dashed space-y-item">
					<p className="flex items-center gap-item text-xs font-medium">
						<AlertTriangle className="h-3.5 w-3.5" />
						What these numbers are not
					</p>
					<ul className="text-xs text-muted-foreground space-y-0.5 list-disc pl-4 max-w-prose">
						<li>
							This is <span className="font-medium">implied cost</span> inferred
							from the provider's reported percentages, not the provider's
							internal quota accounting.
						</li>
						<li>
							A change in how the provider weights input, output and cached
							tokens against each other is indistinguishable here from a change
							in capacity.
						</li>
						<li>
							Implied capacity is denominated in{" "}
							<span className="font-medium">price-equivalent tokens</span>: it
							is conditional on the provider's list-price ratios between input,
							output and cached tokens holding, and is not a measurement of a
							raw-token quota. A shift in those ratios alone moves it.
						</li>
						<li>
							Usage on the same account that did not go through this proxy
							inflates the apparent cost and{" "}
							<span className="font-medium">cannot be measured here</span>.{" "}
							{hiddenLowerBound > 0
								? `At least ${(hiddenLowerBound * 100).toFixed(1)}% of observed window movement happened with no proxy traffic at all — a lower bound on hidden usage, not a coverage figure.`
								: "No window movement was observed without proxy traffic, which is a lower bound of zero on hidden usage and establishes nothing about coverage."}
						</li>
						<li>
							A change on this side of the measurement — token accounting, or
							how model ids are normalized — would look identical to a change by
							the provider.
						</li>
						{anyAssumed ? (
							<li>
								Some accounts' plan and rate-limit tiers were{" "}
								<span className="font-medium">
									inferred from today's values
								</span>{" "}
								rather than recorded per sample. A tier change refiles that
								account's whole history and reads exactly like quota drift.
							</li>
						) : null}
					</ul>
				</InsetPanel>
			</CardContent>
		</Card>
	);
}
