import { useState } from "react";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import { AccountSetupSection } from "./AccountSetupSection";

/** The three regional bases MiMo serves Token Plan from. */
const MIMO_REGIONS = [
	{
		value: "https://token-plan-sgp.xiaomimimo.com/anthropic",
		label: "Singapore (token-plan-sgp)",
	},
	{
		value: "https://token-plan-cn.xiaomimimo.com/anthropic",
		label: "China (token-plan-cn)",
	},
	{
		value: "https://token-plan-ams.xiaomimimo.com/anthropic",
		label: "Europe (token-plan-ams)",
	},
] as const;

/**
 * Sentinels rather than URLs, because Radix rejects an empty `SelectItem`
 * value. Both submit an empty endpoint: picking the default must leave the
 * account without a region of its own, not pin it to the Singapore URL.
 */
const DEFAULT_REGION = "default";
const CUSTOM_REGION = "custom";

export function MimoAccountFields({
	apiKey,
	customEndpoint,
	onApiKeyChange,
	onCustomEndpointChange,
}: {
	apiKey: string;
	customEndpoint: string;
	onApiKeyChange: (value: string) => void;
	onCustomEndpointChange: (value: string) => void;
}) {
	const [region, setRegion] = useState<string>(DEFAULT_REGION);
	return (
		<div className="flex flex-col gap-group">
			<AccountSetupSection title="Connect to MiMo Token Plan">
				<p>
					Create a Token Plan key in the MiMo console and paste it below, then
					pick the region your subscription was bought in. A key is only
					accepted by its own region.
				</p>
			</AccountSetupSection>
			<div className="flex flex-col gap-item">
				<Label htmlFor="apiKey">MiMo Token Plan API Key</Label>
				<Input
					id="apiKey"
					type="password"
					value={apiKey}
					onChange={(event) => onApiKeyChange(event.target.value)}
					placeholder="tp-..."
				/>
			</div>
			<div className="flex flex-col gap-item">
				<Label htmlFor="mimo-region">Region</Label>
				<Select
					value={region}
					onValueChange={(value: string) => {
						setRegion(value);
						onCustomEndpointChange(
							value === DEFAULT_REGION || value === CUSTOM_REGION ? "" : value,
						);
					}}
				>
					<SelectTrigger id="mimo-region">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={DEFAULT_REGION}>Default (Singapore)</SelectItem>
						{MIMO_REGIONS.map((entry) => (
							<SelectItem key={entry.value} value={entry.value}>
								{entry.label}
							</SelectItem>
						))}
						<SelectItem value={CUSTOM_REGION}>
							Other (enter a base URL)
						</SelectItem>
					</SelectContent>
				</Select>
				{region === CUSTOM_REGION ? (
					<>
						<Input
							id="customEndpoint"
							type="url"
							value={customEndpoint}
							onChange={(event) => onCustomEndpointChange(event.target.value)}
							placeholder="https://token-plan-sgp.xiaomimimo.com/anthropic"
						/>
						<p className="text-xs leading-relaxed text-muted-foreground">
							Use the base URL shown in your MiMo console. It must carry no
							credentials, query string or fragment.
						</p>
					</>
				) : (
					<p className="text-xs leading-relaxed text-muted-foreground">
						{region === DEFAULT_REGION
							? "Leave as Default to send requests to MiMo's Singapore base."
							: "Requests for this account go to the selected regional base."}
					</p>
				)}
			</div>
		</div>
	);
}
