import type { QuotaDriftResponse } from "@clankermux/types";
import {
	Activity,
	ChevronDown,
	Loader2,
	TrendingDown,
	TrendingUp,
} from "lucide-react";
import {
	cohortLabel,
	formatRelativeChange,
	isReportableVerdict,
	quotaWindowLabel,
} from "../../lib/quota-drift-display";
import { badgeVariants } from "../ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { InfoPopover } from "../ui/info-popover";

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
				<div className="flex items-start justify-between gap-item">
					<div className="min-w-0">
						<CardTitle className="flex flex-wrap items-center gap-item">
							<Activity className="h-4 w-4" aria-hidden="true" />
							Detected events
							{!loading && !computing && callouts.length > 0 ? (
								<span
									className={badgeVariants({
										variant: "secondary",
										className: "figure",
									})}
								>
									{changed.reduce((sum, c) => sum + c.model.changes.length, 0)}
									<span className="sr-only"> detected changes</span>
								</span>
							) : null}
						</CardTitle>
						<CardDescription>
							Observed changes in implied cost across all retained history.
						</CardDescription>
					</div>
					<InfoPopover label="What these numbers are not">
						<p>
							Implied window cost is fitted from reported usage percentages and
							this proxy's recorded requests, across all retained history.
						</p>
						<ul className="space-y-item list-disc pl-group">
							<li>
								This is <span className="font-medium">implied cost</span>{" "}
								inferred from the provider's reported percentages, not the
								provider's internal quota accounting.
							</li>
							<li>
								A change in how the provider weights input, output and cached
								tokens against each other is indistinguishable here from a
								change in capacity.
							</li>
							<li>
								Implied capacity is denominated in{" "}
								<span className="font-medium">price-equivalent tokens</span>: it
								is conditional on the provider's list-price ratios between
								input, output and cached tokens holding, and is not a
								measurement of a raw-token quota. A shift in those ratios alone
								moves it.
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
								how model ids are normalized — would look identical to a change
								by the provider.
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
					</InfoPopover>
				</div>
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
						Computing: the first pass has not finished yet. Refreshes every 30
						minutes.
					</p>
				) : callouts.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						Nothing measurable yet. No model has enough separable traffic of its
						own.
					</p>
				) : (
					<div className="space-y-item">
						{changed.map(({ cohort, window, model }) =>
							model.changes.map((change) => (
								<div
									key={`${cohort.key}-${window.window}-${model.key}-${change.boundaryMs}`}
									className="flex flex-wrap items-center gap-item border-b py-item last:border-0"
								>
									{change.direction === "cheaper" ? (
										<TrendingDown
											className="h-4 w-4 shrink-0 text-success-strong"
											aria-hidden="true"
										/>
									) : (
										<TrendingUp
											className="h-4 w-4 shrink-0 text-destructive-strong"
											aria-hidden="true"
										/>
									)}
									<div className="min-w-0 flex-1 text-sm">
										<p className="font-medium break-words">{model.key}</p>
										<p className="text-xs text-muted-foreground">
											{cohortLabel(cohort)} · {quotaWindowLabel(window.window)}
										</p>
									</div>
									<span className="figure text-sm font-medium">
										<span className="sr-only">
											observed change in implied cost of{" "}
										</span>
										{formatRelativeChange(change.relativeChange)}
									</span>
									<span className="text-xs text-muted-foreground">
										Around {new Date(change.boundaryMs).toLocaleDateString()}
									</span>
								</div>
							)),
						)}
						{unchanged.length > 0 ? (
							<details className="group text-sm">
								<summary className="flex cursor-pointer list-none items-center gap-item text-muted-foreground rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
									No change detected in {unchanged.length} model/window series
									<ChevronDown
										className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180"
										aria-hidden="true"
									/>
								</summary>
								<ul className="mt-item space-y-tight text-xs text-muted-foreground">
									{unchanged.map(({ cohort, window, model }) => (
										<li key={`${cohort.key}-${window.window}-${model.key}`}>
											{model.key} · {cohortLabel(cohort)} ·{" "}
											{quotaWindowLabel(window.window)}
										</li>
									))}
								</ul>
							</details>
						) : null}
					</div>
				)}
			</CardContent>
		</Card>
	);
}
