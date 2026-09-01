import { useQuotaDrift } from "../../../hooks/queries";
import { cohortLabel } from "../../../lib/quota-drift-display";
import {
	ClaimSeriesAuditPanel,
	ModelWindowCostPanel,
	QuotaChangeVerdicts,
	QuotaDriftPanel,
	SectionHeading,
} from "..";

/**
 * Quota view: what a model actually costs against a usage window, and whether
 * that number has moved.
 *
 * Deliberately has NO time-range selector, unlike its sibling tabs. The fit
 * runs over the whole retained history on the server and the endpoint takes no
 * parameters; a range picker here would either do nothing or silently change
 * which evidence a verdict rests on, and both are worse than its absence.
 *
 * Accounts are grouped into cohorts by (provider, plan tier, rate-limit tier)
 * because pooling different tiers would average away the very quantity being
 * measured. Each cohort gets its own pair of panels rather than a selector:
 * there are a handful at most, and a selector would hide the fact that a second
 * cohort disagrees.
 */
export function QuotaTab() {
	const { data, isLoading } = useQuotaDrift();
	const cohorts = data?.cohorts ?? [];

	return (
		<div className="space-y-section">
			<QuotaChangeVerdicts data={data} loading={isLoading} />

			{isLoading && cohorts.length === 0 ? (
				<>
					<ModelWindowCostPanel loading />
					<QuotaDriftPanel loading />
				</>
			) : (
				cohorts.map((cohort) => (
					<section key={cohort.key} className="space-y-section">
						<SectionHeading
							title={cohortLabel(cohort)}
							description={
								<>
									{cohort.accountIds.length} account
									{cohort.accountIds.length === 1 ? "" : "s"} fitted together.
									{cohort.tierProvenance === "assumed"
										? " Tier inferred from today's account values rather than recorded per sample."
										: null}
								</>
							}
						/>
						<ModelWindowCostPanel cohort={cohort} />
						<QuotaDriftPanel cohort={cohort} />
					</section>
				))
			)}

			{/* The material every panel above is built on, collapsed and last: it is
			    a census of the captured readings, not an analysis, and a reader who
			    wants to know whether a verdict rests on anything comes here after
			    seeing the verdict. */}
			<ClaimSeriesAuditPanel audit={data?.claimAudit} />
		</div>
	);
}
