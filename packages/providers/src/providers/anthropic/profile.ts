import { CLAUDE_CLI_VERSION } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import type { AccountIdentity } from "@clankermux/types";
import { extractAnthropicIdentity } from "./identity";

const log = new Logger("AnthropicProfile");

export const ANTHROPIC_PROFILE_ENDPOINT =
	"https://api.anthropic.com/api/oauth/profile";

const REQUEST_TIMEOUT_MS = 5_000;

/**
 * One-time diagnostic latch: log the KEY NAMES (never values — the org name is
 * PII) of the profile response's `organization` object the first time we parse a
 * successful profile. Confirms the real `rate_limit_tier` field name post-deploy;
 * a follow-up will remove this.
 */
let loggedProfileOrgShapeOnce = false;

function logProfileOrgKeysOnce(json: unknown): void {
	if (loggedProfileOrgShapeOnce) return;
	const root =
		json != null && typeof json === "object" && !Array.isArray(json)
			? (json as Record<string, unknown>)
			: null;
	const org = root?.organization;
	if (org != null && typeof org === "object" && !Array.isArray(org)) {
		loggedProfileOrgShapeOnce = true;
		// Keys only — NO values, since organization.name contains PII.
		log.debug("[identity-capture] profile organization keys:", {
			keys: Object.keys(org as Record<string, unknown>),
		});
	}
}

/**
 * Fetch and normalize an Anthropic OAuth account's profile identity.
 *
 * This is a USER-INITIATED / opt-in call — it runs only on account add/reauth
 * and a one-time startup backfill for accounts missing identity, never on the
 * request hot path. It carries the `claude-code/<version>` User-Agent (and the
 * OAuth beta header) on purpose: the profile endpoint lives in the same
 * aggressively-rate-limited bucket as the usage endpoint, and the claude-code
 * UA is what keeps these low-frequency identity reads out of the throttled
 * path.
 *
 * FAILS OPEN: any non-2xx status, thrown error, or non-JSON body is logged as a
 * warning and returns null. Never throws.
 */
export async function fetchAnthropicProfile(
	accessToken: string,
): Promise<AccountIdentity | null> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(ANTHROPIC_PROFILE_ENDPOINT, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"anthropic-beta": "oauth-2025-04-20",
				"Content-Type": "application/json",
				"User-Agent": `claude-code/${CLAUDE_CLI_VERSION}`,
			},
			signal: controller.signal,
		});

		if (!response.ok) {
			log.warn(
				`Profile endpoint returned ${response.status} ${response.statusText}`,
			);
			return null;
		}

		const json = await response.json();
		logProfileOrgKeysOnce(json);
		return extractAnthropicIdentity(json);
	} catch (error) {
		log.warn(
			"Failed to fetch Anthropic profile:",
			error instanceof Error ? error.message : String(error),
		);
		return null;
	} finally {
		clearTimeout(timeoutId);
	}
}
