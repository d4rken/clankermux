import React from "react";
import { CacheWarmingCard } from "./overview/CacheWarmingCard";
import { DataRetentionCard } from "./overview/DataRetentionCard";
import { UsageThrottlingCard } from "./overview/UsageThrottlingCard";

export const SettingsTab = React.memo(() => {
	return (
		<div className="space-y-section">
			{/* Configuration Cards Grid */}
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-section">
				<CacheWarmingCard />
				<UsageThrottlingCard />
				<DataRetentionCard />
			</div>
		</div>
	);
});
