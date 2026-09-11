import type { DatabaseOperations } from "@clankermux/database";
import { fetchOpenRouterMetadata } from "@clankermux/providers";
import type { OpenRouterAccountMetadata } from "@clankermux/types";

/** Keep the last successful snapshot on failure. Never contact custom endpoints. */
export async function refreshOpenRouterAccountMetadata(
	dbOps: DatabaseOperations,
	account: {
		id: string;
		provider: string;
		api_key?: string | null;
		custom_endpoint?: string | null;
	},
): Promise<OpenRouterAccountMetadata | null> {
	if (
		account.provider !== "openrouter" ||
		!account.api_key ||
		account.custom_endpoint
	)
		return null;
	try {
		const metadata = await fetchOpenRouterMetadata(account.api_key);
		if (!metadata) return null;
		await dbOps
			.getAdapter()
			.run(
				"UPDATE accounts SET openrouter_metadata_json = ? WHERE id = ? AND provider = 'openrouter' AND api_key = ? AND (custom_endpoint IS NULL OR custom_endpoint = '')",
				[JSON.stringify(metadata), account.id, account.api_key],
			);
		return metadata;
	} catch {
		return null;
	}
}

/** Refresh existing accounts once per startup, sequentially and without blocking boot. */
export async function refreshOpenRouterAccountsOnStartup(
	dbOps: DatabaseOperations,
): Promise<void> {
	try {
		const accounts = await dbOps.getAllAccounts();
		for (const account of accounts) {
			if (account.provider === "openrouter")
				await refreshOpenRouterAccountMetadata(dbOps, account);
		}
	} catch {
		// The dashboard refresh action provides a retry if startup enrichment fails.
	}
}

/** A damaged snapshot must not break the accounts list. */
export function readOpenRouterAccountMetadata(
	json: string | null | undefined,
): OpenRouterAccountMetadata | null {
	if (!json) return null;
	try {
		const value = JSON.parse(json);
		if (!value || typeof value !== "object" || Array.isArray(value))
			return null;
		for (const key of ["label", "creatorUserId", "limitReset", "expiresAt"]) {
			if (value[key] !== null && typeof value[key] !== "string") return null;
		}
		for (const key of [
			"limitUsd",
			"limitRemainingUsd",
			"usageUsd",
			"usageDailyUsd",
			"usageWeeklyUsd",
			"usageMonthlyUsd",
		]) {
			if (
				value[key] !== null &&
				(typeof value[key] !== "number" || !Number.isFinite(value[key]))
			)
				return null;
		}
		if (value.isFreeTier !== null && typeof value.isFreeTier !== "boolean")
			return null;
		if (
			typeof value.fetchedAt !== "number" ||
			!Number.isFinite(value.fetchedAt)
		)
			return null;
		return value;
	} catch {
		return null;
	}
}
