import type { DatabaseOperations } from "@clankermux/database";
import { fetchOpenRouterMetadata } from "@clankermux/providers";
import type { OpenRouterAccountMetadata } from "@clankermux/types";

interface OpenRouterMetadataTarget {
	id: string;
	provider: string;
	disabled?: boolean;
	api_key?: string | null;
	custom_endpoint?: string | null;
}

/** Keep the last successful snapshot on failure. Never contact custom endpoints. */
export async function refreshOpenRouterAccountMetadata(
	dbOps: DatabaseOperations,
	account: OpenRouterMetadataTarget,
): Promise<OpenRouterAccountMetadata | null> {
	return writeSnapshot(dbOps, account, fetchOpenRouterMetadata);
}

/**
 * Persist metadata that was already read from the key endpoint, under the
 * same guards as a refresh. Anything that does not validate as a snapshot is
 * dropped rather than refetched.
 */
export async function storeOpenRouterAccountMetadata(
	dbOps: DatabaseOperations,
	account: OpenRouterMetadataTarget,
	metadata: unknown,
): Promise<OpenRouterAccountMetadata | null> {
	const snapshot = toOpenRouterAccountMetadata(metadata);
	if (!snapshot) return null;
	return writeSnapshot(dbOps, account, async () => snapshot);
}

async function writeSnapshot(
	dbOps: DatabaseOperations,
	account: OpenRouterMetadataTarget,
	obtain: (apiKey: string) => Promise<OpenRouterAccountMetadata | null>,
): Promise<OpenRouterAccountMetadata | null> {
	if (
		account.disabled ||
		account.provider !== "openrouter" ||
		!account.api_key ||
		account.custom_endpoint
	)
		return null;
	try {
		if ((await dbOps.getAccount(account.id))?.disabled) return null;
		const metadata = await obtain(account.api_key);
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
		return toOpenRouterAccountMetadata(JSON.parse(json));
	} catch {
		return null;
	}
}

function toOpenRouterAccountMetadata(
	candidate: unknown,
): OpenRouterAccountMetadata | null {
	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
		return null;
	const value = candidate as Record<string, unknown>;
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
	if (typeof value.fetchedAt !== "number" || !Number.isFinite(value.fetchedAt))
		return null;
	return {
		label: value.label as string | null,
		creatorUserId: value.creatorUserId as string | null,
		isFreeTier: value.isFreeTier as boolean | null,
		limitUsd: value.limitUsd as number | null,
		limitRemainingUsd: value.limitRemainingUsd as number | null,
		limitReset: value.limitReset as string | null,
		usageUsd: value.usageUsd as number | null,
		usageDailyUsd: value.usageDailyUsd as number | null,
		usageWeeklyUsd: value.usageWeeklyUsd as number | null,
		usageMonthlyUsd: value.usageMonthlyUsd as number | null,
		expiresAt: value.expiresAt as string | null,
		fetchedAt: value.fetchedAt,
	};
}
