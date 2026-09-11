/** Snapshot from OpenRouter's current-key endpoint. Dollar amounts are USD. */
export interface OpenRouterAccountMetadata {
	label: string | null;
	creatorUserId: string | null;
	isFreeTier: boolean | null;
	limitUsd: number | null;
	limitRemainingUsd: number | null;
	limitReset: string | null;
	usageUsd: number | null;
	usageDailyUsd: number | null;
	usageWeeklyUsd: number | null;
	usageMonthlyUsd: number | null;
	expiresAt: string | null;
	fetchedAt: number;
}
