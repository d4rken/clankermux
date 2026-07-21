import type { AccountIdentity } from "@clankermux/types";

type UnknownRecord = Record<string, unknown>;

/**
 * Map Anthropic's `organization_type`/`type` values to the short plan tiers we
 * store. Unknown values are NOT dropped — they fall through lowercased so a
 * newly-introduced tier is still captured (see {@link extractAnthropicIdentity}).
 */
const ANTHROPIC_TIER_MAP: Record<string, string> = {
	claude_max: "max",
	claude_pro: "pro",
	claude_team: "team",
	claude_enterprise: "enterprise",
};

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
 * Normalize Anthropic's `organization.rate_limit_tier` string to a short
 * multiplier token. The concrete field name/values are treated as best-effort
 * (confirm at runtime — see the one-time profile-org-keys debug log): the known
 * shape is `default_claude_max_20x` / `default_claude_max_5x` /
 * `default_claude_max_1x`.
 *
 * Rules:
 *   - A trailing `_(\d+x)` suffix (case-insensitive) → just that token, e.g.
 *     "default_claude_max_20x" → "20x".
 *   - No parseable `\d+x` suffix but a non-empty string → the cleaned string
 *     with any leading `default_claude_`/`default_` prefix stripped, so nothing
 *     is silently lost (e.g. "default_claude_pro" → "claude_pro").
 *   - Empty/whitespace/non-string → null.
 */
function normalizeRateLimitTier(value: unknown): string | null {
	const raw = nullableString(value);
	if (raw === null) return null;
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	const suffix = trimmed.match(/_(\d+x)$/i);
	if (suffix) return suffix[1].toLowerCase();
	// No multiplier suffix — keep the value but drop the noisy default_ prefix(es).
	return trimmed.replace(/^default_(claude_)?/i, "");
}

/**
 * Resolve a normalized {@link AccountIdentity} from an Anthropic OAuth profile
 * payload (the `GET /api/oauth/profile` response, which nests `account` and
 * `organization`).
 *
 * The precise subfield names are treated as best-effort: the extractor accepts
 * either `email_address` or `email`, and either `organization_type` or `type`,
 * guarding every access so a missing field becomes a null field rather than a
 * throw. Returns null only when BOTH `account` and `organization` are absent
 * (nothing identity-bearing to capture).
 */
export function extractAnthropicIdentity(
	json: unknown,
): AccountIdentity | null {
	const root = asRecord(json);
	const account = asRecord(root?.account);
	const organization = asRecord(root?.organization);
	if (!account && !organization) return null;

	const externalAccountId = nullableString(account?.uuid);
	const email = normalizeEmail(account?.email_address ?? account?.email);

	const organizationName = nullableString(organization?.name);
	const rawTier = nullableString(
		organization?.organization_type ?? organization?.type,
	);
	let planTier: string | null = null;
	if (rawTier) {
		const key = rawTier.toLowerCase();
		planTier = ANTHROPIC_TIER_MAP[key] ?? key;
	}

	// The rate-limit multiplier lives in a SEPARATE field so it can't be clobbered
	// by a token-refresh envelope that lacks it (COALESCE preserves the prior).
	const rateLimitTier = normalizeRateLimitTier(organization?.rate_limit_tier);

	return {
		externalAccountId,
		email,
		organizationName,
		planTier,
		rateLimitTier,
	};
}
