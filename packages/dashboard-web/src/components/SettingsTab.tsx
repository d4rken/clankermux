import React from "react";
import { CacheWarmingCard } from "./overview/CacheWarmingCard";
import { DataRetentionCard } from "./overview/DataRetentionCard";
import { ModelSubstitutionSettingsCard } from "./overview/ModelSubstitutionSettingsCard";
import { UsageThrottlingCard } from "./overview/UsageThrottlingCard";
import { ProjectAttributionCard } from "./settings/ProjectAttributionCard";

export const SettingsTab = React.memo(() => {
	return (
		<div className="space-y-section">
			{/* The two routing/spend cards pair up; retention runs full width below
			    because it carries six settings and a summary footer, and squeezing
			    it into one half-width column was what left a page-height void
			    beside it. `items-start` keeps the short throttling card from
			    stretching to match its taller neighbour. */}
			<div className="grid grid-cols-1 items-start gap-section lg:grid-cols-2">
				<CacheWarmingCard />
				<UsageThrottlingCard />
				{/* Beside the other two routing cards: like them it decides what the
				    proxy does with a request rather than how data is kept. One
				    setting, so it sits in the half-width column. */}
				<ModelSubstitutionSettingsCard />
			</div>
			<DataRetentionCard />
			{/* Full width for the same reason as retention: two list editors and a
			    third read-only list do not fit a half-width column. */}
			<ProjectAttributionCard />
		</div>
	);
});
