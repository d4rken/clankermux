import type { AccountIdentity } from "@clankermux/types";
import { decodeJwtPayloadSafe } from "../../oauth/jwt";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as UnknownRecord)
		: null;
}

function nullableString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function normalizeEmail(value: unknown): string | null {
	const raw = nullableString(value);
	if (raw === null) return null;
	const normalized = raw.trim().toLowerCase();
	return normalized === "" ? null : normalized;
}

/**
 * Resolve a normalized {@link AccountIdentity} from Codex OAuth token claims.
 *
 * The external id and plan tier come from the access token's
 * `https://api.openai.com/auth` claim. The email is resolved with a precedence:
 * the id token's top-level `email` claim wins when present, otherwise it falls
 * back to the access token's `https://api.openai.com/profile` claim's `email`
 * (Codex omits the id_token on a plain refresh, but the access token still
 * carries the profile email — so email is captured even without an id_token).
 * `organizationName` is always null for Codex — the ChatGPT tokens carry no
 * workspace/org name. Every field access is guarded, so a missing claim yields a
 * null field rather than a throw. Returns null only when the access token itself
 * cannot be decoded.
 */
export function extractCodexIdentity(
	accessToken: string,
	idToken?: string | null,
): AccountIdentity | null {
	const payload = decodeJwtPayloadSafe(accessToken);
	if (!payload) return null;

	const auth = asRecord(payload["https://api.openai.com/auth"]);
	const externalAccountId = nullableString(auth?.chatgpt_account_id);
	const rawPlan = nullableString(auth?.chatgpt_plan_type);
	// Codex already emits plus/pro/team/enterprise; lowercase for consistency.
	const planTier = rawPlan ? rawPlan.toLowerCase() : null;

	// Email precedence: prefer the id_token's top-level email when an id_token is
	// present, else fall back to the access token's profile-claim email (present
	// even on a plain refresh that omits the id_token).
	const profile = asRecord(payload["https://api.openai.com/profile"]);
	const accessTokenEmail = normalizeEmail(profile?.email);
	let email = accessTokenEmail;
	if (idToken) {
		const idPayload = decodeJwtPayloadSafe(idToken);
		email = normalizeEmail(idPayload?.email) ?? accessTokenEmail;
	}

	return {
		externalAccountId,
		email,
		organizationName: null,
		planTier,
		// Codex has no rate-limit multiplier concept (Anthropic-only) → always null.
		rateLimitTier: null,
	};
}
