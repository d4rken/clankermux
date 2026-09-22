import type { AccountIdentity } from "@clankermux/types";
import { decodeJwtPayloadSafe } from "../../oauth/jwt";
import {
	GROK_CHAT_PROXY_ENDPOINT,
	GROK_CLI_IDENTITY_HEADERS,
} from "./client-identity";

/** Identity is decoration on a working account, so it gets a short budget. */
const PROFILE_TIMEOUT_MS = 10_000;

const PROFILE_URL = `${GROK_CHAT_PROXY_ENDPOINT}/v1/user`;

export interface GrokIdentityOptions {
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
}

export interface ResolvedGrokSubscriptionIdentity {
	identity: AccountIdentity;
	/** False when nothing at all was captured — the caller then writes nothing. */
	hasIdentity: boolean;
	/** True only when `/v1/user` answered, which is what may stamp a profile fetch. */
	fromProfile: boolean;
}

function nullableString(value: unknown): string | null {
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

function normalizeEmail(value: unknown): string | null {
	return nullableString(value)?.toLowerCase() ?? null;
}

/**
 * Identity from the OIDC id_token's claims — no network, so a refresh can
 * capture it without spending a request.
 *
 * Returns null when the token is absent, undecodable, or carries neither claim,
 * which keeps a COALESCE-merging write from advancing `identity_captured_at`
 * for nothing.
 */
export function extractGrokSubscriptionIdentity(
	idToken?: string | null,
): AccountIdentity | null {
	if (!idToken) return null;
	const claims = decodeJwtPayloadSafe(idToken);
	if (!claims) return null;

	const externalAccountId = nullableString(claims.sub);
	const email = normalizeEmail(claims.email);
	if (!externalAccountId && !email) return null;

	return {
		externalAccountId,
		email,
		// The id_token carries no workspace name and no plan; the profile below
		// supplies the organization, and xAI publishes no tier at all.
		organizationName: null,
		planTier: null,
		rateLimitTier: null,
	};
}

/**
 * Read the account's profile from the chat proxy.
 *
 * Never throws and never rejects: every failure — the 426 version gate, a 403,
 * a timeout, a body that is not the JSON we expect — answers null. Callers run
 * this AFTER the credentials are persisted, and an enrichment that could throw
 * would take a freshly rotated refresh token down with it.
 */
export async function fetchGrokSubscriptionProfile(
	accessToken: string,
	options: GrokIdentityOptions = {},
): Promise<AccountIdentity | null> {
	try {
		const budget = AbortSignal.timeout(PROFILE_TIMEOUT_MS);
		const response = await (options.fetchImpl ?? fetch)(PROFILE_URL, {
			method: "GET",
			headers: {
				...GROK_CLI_IDENTITY_HEADERS,
				Authorization: `Bearer ${accessToken}`,
			},
			signal: options.signal
				? AbortSignal.any([budget, options.signal])
				: budget,
		});
		if (!response.ok) return null;

		const data = (await response.json()) as Record<string, unknown> | null;
		if (data == null || typeof data !== "object") return null;

		const externalAccountId = nullableString(data.userId);
		const email = normalizeEmail(data.email);
		const organizationName = nullableString(data.organizationName);
		if (!externalAccountId && !email && !organizationName) return null;

		return {
			externalAccountId,
			email,
			organizationName,
			planTier: null,
			rateLimitTier: null,
		};
	} catch {
		return null;
	}
}

/**
 * Merge what the profile knows over what the token claims know.
 *
 * The profile is authoritative where it answers (it is the only source of the
 * organization name); the claims fill in whatever a failed or partial profile
 * left null, so a 426 still yields the user id and email from the id_token.
 */
export async function resolveGrokSubscriptionIdentity(
	accessToken: string,
	idToken?: string | null,
	options: GrokIdentityOptions = {},
): Promise<ResolvedGrokSubscriptionIdentity> {
	const claims = extractGrokSubscriptionIdentity(idToken);
	const profile = await fetchGrokSubscriptionProfile(accessToken, options);
	const identity: AccountIdentity = {
		externalAccountId:
			profile?.externalAccountId ?? claims?.externalAccountId ?? null,
		email: profile?.email ?? claims?.email ?? null,
		organizationName:
			profile?.organizationName ?? claims?.organizationName ?? null,
		planTier: profile?.planTier ?? claims?.planTier ?? null,
		rateLimitTier: profile?.rateLimitTier ?? claims?.rateLimitTier ?? null,
	};
	return {
		identity,
		hasIdentity: Object.values(identity).some((value) => value !== null),
		fromProfile: profile !== null,
	};
}
