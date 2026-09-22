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

/** A sentinel rather than a URL, because Radix rejects an empty `SelectItem` value. */
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
	// Empty, so Radix shows the placeholder and no region is chosen by default.
	// There is nothing sensible to preselect: a Token Plan key is accepted by the
	// region it was bought in and 401s everywhere else, so a guess here would be
	// wrong for two subscribers in three and would only surface on the first
	// request.
	const [region, setRegion] = useState<string>("");
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
						onCustomEndpointChange(value === CUSTOM_REGION ? "" : value);
					}}
				>
					<SelectTrigger id="mimo-region">
						<SelectValue placeholder="Select a region" />
					</SelectTrigger>
					<SelectContent>
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
				) : region ? (
					<p className="text-xs leading-relaxed text-muted-foreground">
						Requests for this account go to the selected regional base.
					</p>
				) : null}
			</div>
		</div>
	);
}
