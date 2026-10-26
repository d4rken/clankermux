import {
	parseCodexUsageHeaders,
	targetsChatGptCodexBackend,
} from "@clankermux/providers";
import type { Account } from "@clankermux/types";
import type { AccountQuota429 } from "./anthropic-account-quota";

const HOUR_MS = 60 * 60 * 1000;
// Allow small clock/rounding differences, never a different window's horizon.
const RESET_TOLERANCE_MS = 60_000;

/**
 * The Codex counterpart of `resolveLiveAccountQuota429`: a ChatGPT-backend 429
 * whose own `x-codex-*` headers report an account-wide window at 100% names
 * its cause and its reset.
 *
 * Only a reported percentage counts. A window without one is unknown, never
 * spent, so this reads the headers without `defaultUtilization`. Per-model
 * family limits (`x-codex-<family>-*`) are not account-wide and never bind.
 */
export function resolveLiveCodexAccountQuota429(
	account: Pick<Account, "provider" | "custom_endpoint">,
	response: Response,
	now: number = Date.now(),
): AccountQuota429 | null {
	if (
		response.status !== 429 ||
		account.provider !== "codex" ||
		!targetsChatGptCodexBackend(account)
	)
		return null;

	const usage = parseCodexUsageHeaders(response.headers, { baseTimeMs: now });
	if (!usage) return null;

	let binding: AccountQuota429["binding"] | null = null;
	let latestReset: number | null = null;
	for (const [window, kind, horizon] of [
		[usage.five_hour, "session", 5 * HOUR_MS],
		[usage.seven_day, "weekly", 7 * 24 * HOUR_MS],
	] as const) {
		if (!window || window.utilization < 100) continue;
		if (kind === "weekly") binding = "weekly";
		else binding ??= "session";

		const resetMs = window.resets_at
			? Date.parse(window.resets_at)
			: Number.NaN;
		if (
			Number.isFinite(resetMs) &&
			resetMs > now &&
			resetMs <= now + horizon + RESET_TOLERANCE_MS
		) {
			latestReset = Math.max(latestReset ?? 0, resetMs);
		}
	}
	if (binding === null) return null;
	return {
		binding,
		reason:
			binding === "weekly" ? "weekly_exhausted_429" : "session_exhausted_429",
		resetTime: latestReset ?? undefined,
	};
}
