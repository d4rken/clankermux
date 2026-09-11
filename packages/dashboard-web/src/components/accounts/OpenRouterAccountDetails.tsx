import type { OpenRouterAccountMetadata } from "@clankermux/types";
import { InsetPanel } from "../ui/inset-panel";

const dollars = (value: number) => `$${value.toFixed(2)}`;

export function OpenRouterAccountDetails({
	metadata,
}: {
	metadata?: OpenRouterAccountMetadata | null;
}) {
	if (!metadata)
		return (
			<p className="text-xs text-muted-foreground">
				OpenRouter account details unavailable. Use Refresh to try again.
			</p>
		);
	const rows: [string, string][] = [];
	if (metadata.label) rows.push(["Key", metadata.label]);
	if (metadata.creatorUserId) rows.push(["Created by", metadata.creatorUserId]);
	if (metadata.isFreeTier !== null)
		rows.push(["Tier", metadata.isFreeTier ? "Free" : "Paid"]);
	if (metadata.limitUsd !== null) {
		rows.push([
			"Key spending limit",
			`${dollars(metadata.limitUsd)}${metadata.limitReset ? ` · ${metadata.limitReset}` : ""}`,
		]);
	}
	if (metadata.limitRemainingUsd !== null)
		rows.push(["Key budget remaining", dollars(metadata.limitRemainingUsd)]);
	for (const [label, value] of [
		["Total usage", metadata.usageUsd],
		["Today", metadata.usageDailyUsd],
		["This week", metadata.usageWeeklyUsd],
		["This month", metadata.usageMonthlyUsd],
	] as const) {
		if (value !== null) rows.push([label, dollars(value)]);
	}
	if (metadata.expiresAt)
		rows.push(["Key expires", new Date(metadata.expiresAt).toLocaleString()]);
	return (
		<InsetPanel>
			<dl className="flex flex-wrap gap-x-section gap-y-item text-xs">
				{rows.map(([label, value]) => (
					<div key={label} className="min-w-0">
						<dt className="text-muted-foreground">{label}</dt>
						<dd className="font-medium tabular-nums break-words">{value}</dd>
					</div>
				))}
			</dl>
			<p className="mt-item text-xs text-muted-foreground">
				Updated {new Date(metadata.fetchedAt).toLocaleString()}. OpenRouter does
				not provide the account email.
			</p>
		</InsetPanel>
	);
}
