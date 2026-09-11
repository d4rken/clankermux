import type { OpenRouterAccountMetadata } from "@clankermux/types";

export const OPENROUTER_KEY_ENDPOINT = "https://openrouter.ai/api/v1/key";

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

const string = (value: unknown): string | null =>
	typeof value === "string" && value.trim() ? value.trim() : null;
const amount = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: null;

export function parseOpenRouterMetadata(
	body: unknown,
	fetchedAt = Date.now(),
): OpenRouterAccountMetadata | null {
	const data = record(record(body)?.data);
	if (
		!data ||
		!["label", "creator_user_id", "is_free_tier", "usage", "limit"].some(
			(key) => key in data,
		)
	)
		return null;
	const expiresAt = string(data.expires_at);
	return {
		label: string(data.label),
		creatorUserId: string(data.creator_user_id),
		isFreeTier:
			typeof data.is_free_tier === "boolean" ? data.is_free_tier : null,
		limitUsd: amount(data.limit),
		limitRemainingUsd:
			typeof data.limit_remaining === "number" &&
			Number.isFinite(data.limit_remaining)
				? data.limit_remaining
				: null,
		limitReset: string(data.limit_reset),
		usageUsd: amount(data.usage),
		usageDailyUsd: amount(data.usage_daily),
		usageWeeklyUsd: amount(data.usage_weekly),
		usageMonthlyUsd: amount(data.usage_monthly),
		expiresAt:
			expiresAt && Number.isFinite(Date.parse(expiresAt)) ? expiresAt : null,
		fetchedAt,
	};
}

/** Free metadata read. Failures never prevent account creation or proxying. */
export async function fetchOpenRouterMetadata(
	apiKey: string,
): Promise<OpenRouterAccountMetadata | null> {
	try {
		const response = await fetch(OPENROUTER_KEY_ENDPOINT, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json",
			},
			signal: AbortSignal.timeout(5_000),
			redirect: "error",
		});
		if (!response.ok) {
			await response.body?.cancel();
			return null;
		}
		const metadata = parseOpenRouterMetadata(await response.json());
		// Only a provider-redacted label is safe to publish. Never expose the key
		// if a malformed response echoes it as a label or another string field.
		if (metadata) {
			for (const field of [
				"label",
				"creatorUserId",
				"limitReset",
				"expiresAt",
			] as const) {
				if (metadata[field]?.includes(apiKey)) metadata[field] = null;
			}
		}
		return metadata;
	} catch {
		return null;
	}
}
