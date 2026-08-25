import { useSetUsageThrottling, useUsageThrottling } from "../../hooks/queries";
import { SettingRow } from "../settings/SettingRow";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Switch } from "../ui/switch";

export function UsageThrottlingCard() {
	const { data, isLoading } = useUsageThrottling();
	const setUsageThrottling = useSetUsageThrottling();

	const fiveHourEnabled = data?.fiveHourEnabled ?? false;
	const weeklyEnabled = data?.weeklyEnabled ?? false;
	const busy = isLoading || setUsageThrottling.isPending;

	return (
		<Card className="card-hover">
			<CardHeader>
				<CardTitle>Usage Throttling</CardTitle>
				<CardDescription>
					Pace spending against each usage window separately.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-row">
				<SettingRow
					label="5-hour window"
					control={
						<Switch
							disabled={busy}
							checked={fiveHourEnabled}
							onCheckedChange={(checked) =>
								setUsageThrottling.mutate({
									fiveHourEnabled: checked,
									weeklyEnabled,
								})
							}
						/>
					}
					summary="Throttle requests when 5-hour usage is ahead of its pacing line."
					detail="While a window is ahead of pace the proxy answers the client with a retry-in-60-seconds error instead of sending another upstream request, so the remaining quota is spread across the rest of the window rather than spent early."
				/>
				<SettingRow
					label="Weekly window"
					control={
						<Switch
							disabled={busy}
							checked={weeklyEnabled}
							onCheckedChange={(checked) =>
								setUsageThrottling.mutate({
									fiveHourEnabled,
									weeklyEnabled: checked,
								})
							}
						/>
					}
					summary="Throttle requests when weekly usage is ahead of its pacing line."
					detail="Disable this if you expect usage to recover overnight — the weekly pacing line assumes an even burn across the whole week, which penalises a heavy day that a quiet night would have offset anyway."
				/>
			</CardContent>
		</Card>
	);
}
