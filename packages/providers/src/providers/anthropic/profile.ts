import { CLAUDE_CLI_VERSION } from "@clankermux/core";
import { Logger } from "@clankermux/logger";
import type { AccountIdentity } from "@clankermux/types";
import { extractAnthropicIdentity } from "./identity";

const log = new Logger("AnthropicProfile");

export const ANTHROPIC_PROFILE_ENDPOINT =
	"https://api.anthropic.com/api/oauth/profile";

const REQUEST_TIMEOUT_MS = 5_000;
let profileRateLimitedUntil = 0;

function retryAfterMs(response: Response): number | null {
	const value = response.headers.get("retry-after");
	if (!value) return null;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
	const dateMs = Date.parse(value);
	return Number.isFinite(dateMs) && dateMs > Date.now()
		? dateMs - Date.now()
		: null;
}

/**
 * Fetch and normalize an Anthropic OAuth account's profile identity.
 *
 * Uses Claude Code's OAuth headers for account setup and subscription checks.
 * A profile 429 defers further profile reads across this process, including
 * manual rechecks, until Retry-After expires.
 *
 * FAILS OPEN: any non-2xx status, thrown error, or non-JSON body is logged as a
 * warning and returns null. Never throws.
 */
export async function fetchAnthropicProfile(
	accessToken: string,
): Promise<AccountIdentity | null> {
	if (Date.now() < profileRateLimitedUntil) return null;
	profileRateLimitedUntil = 0;
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
			if (response.status === 429) {
				const delayMs = retryAfterMs(response) ?? 60_000;
				profileRateLimitedUntil = Math.max(
					profileRateLimitedUntil,
					Date.now() + delayMs,
				);
				log.warn(
					`Profile endpoint rate-limited; retrying after ${Math.ceil(delayMs / 1000)}s`,
				);
			}
			log.warn(
				`Profile endpoint returned ${response.status} ${response.statusText}`,
			);
			return null;
		}

		const json = await response.json();
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
