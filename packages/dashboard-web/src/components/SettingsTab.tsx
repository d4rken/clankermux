import React from "react";
import { CacheWarmingCard } from "./overview/CacheWarmingCard";
import { DataRetentionCard } from "./overview/DataRetentionCard";
import { UsageThrottlingCard } from "./overview/UsageThrottlingCard";

export const SettingsTab = React.memo(() => {
	return (
		<div className="space-y-6">
			{/* Configuration Cards Grid */}
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				<CacheWarmingCard />
				<UsageThrottlingCard />
				<DataRetentionCard />
			</div>
		</div>
	);
});
