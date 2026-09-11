import { Logger } from "@clankermux/logger";
import {
	devinSessionExpiresAt,
	extractDevinIdentity,
	usageCache,
} from "@clankermux/providers";
import type {
	Account,
	AccountIdentity,
	DevinUsageData,
} from "@clankermux/types";

const log = new Logger("DevinUsagePolling");

export interface DevinPollingEffects {
	onQuotaMetadata?: (
		account: Account,
		usage: DevinUsageData,
		isCurrent: () => boolean,
	) => Promise<void>;
	onAuthenticationFailure?: (account: Account) => Promise<void>;
}

/** Poll metadata only. Re-read credentials so account edits never retain an old token. */
export function startDevinUsagePolling(
	account: Account,
	db: {
		getAccount(id: string): Promise<Account | null>;
		setAccountIdentityFromProfile(
			id: string,
			identity: AccountIdentity,
		): Promise<void>;
		updateDevinSessionExpiry?(
			id: string,
			expectedApiKey: string,
			expectedEndpoint: string | null,
			expiresAt: number | null,
		): Promise<boolean>;
	},
	intervalMs: number,
	cache: Pick<typeof usageCache, "startPolling"> = usageCache,
	effects: DevinPollingEffects = {},
): boolean {
	if (account.provider !== "devin" || !account.api_key) return false;
	const endpoint = account.custom_endpoint ?? null;
	cache.startPolling(
		account.id,
		async () => {
			const current = await db.getAccount(account.id);
			if (current?.provider !== "devin" || !current.api_key)
				throw new Error("Devin account credentials unavailable");
			// The endpoint is captured by this poll generation. Account edits restart it.
			if ((current.custom_endpoint ?? null) !== endpoint)
				throw new Error(
					"Devin account endpoint changed; restart usage polling",
				);
			return current.api_key;
		},
		"devin",
		intervalMs,
		endpoint,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{
			onMetadata: async (usage, token, isCurrent) => {
				const identity = extractDevinIdentity(usage);
				if (!isCurrent()) return;
				try {
					const current = await db.getAccount(account.id);
					if (
						!isCurrent() ||
						current?.provider !== "devin" ||
						current.api_key !== token ||
						(current.custom_endpoint ?? null) !== endpoint
					)
						return;
					const expiresAt = devinSessionExpiresAt(token);
					if (expiresAt !== current.expires_at && db.updateDevinSessionExpiry) {
						try {
							await db.updateDevinSessionExpiry(
								account.id,
								token,
								endpoint,
								expiresAt,
							);
						} catch {
							log.warn(
								`Could not update Devin session expiry for account ${account.id}`,
							);
						}
					}
					if (!isCurrent()) return;
					try {
						await effects.onQuotaMetadata?.(current, usage, isCurrent);
					} catch {
						log.warn(
							`Could not reconcile Devin quota for account ${account.id}`,
						);
					}
					if (!identity || !isCurrent()) return;
					// Match the repository's COALESCE merge: absent metadata never clears identity.
					const unchanged =
						(identity.email === null ||
							identity.email === current.identity_email) &&
						(identity.externalAccountId === null ||
							identity.externalAccountId === current.identity_external_id) &&
						(identity.planTier === null ||
							identity.planTier === current.identity_plan_tier) &&
						(identity.organizationName === null ||
							identity.organizationName === current.identity_organization_name);
					if (unchanged && current.identity_profile_fetched_at != null) return;
					await db.setAccountIdentityFromProfile(account.id, identity);
				} catch {
					log.warn(
						`Could not persist Devin metadata identity for account ${account.id}`,
					);
				}
			},
			onAuthenticationFailure: async (token, isCurrent) => {
				if (!isCurrent()) return;
				const current = await db.getAccount(account.id);
				if (
					!isCurrent() ||
					current?.provider !== "devin" ||
					current.api_key !== token ||
					(current.custom_endpoint ?? null) !== endpoint
				)
					return;
				await effects.onAuthenticationFailure?.(current);
			},
		},
	);
	return true;
}
