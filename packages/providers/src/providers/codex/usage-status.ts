import { Logger } from "@clankermux/logger";
import type { UsageData, UsageWindow } from "../../usage-fetcher";
import { CODEX_USER_AGENT, CODEX_VERSION } from "./provider";
import { type CodexCreditsInfo, normalizeCodexWindow } from "./usage";

const log = new Logger("CodexUsageStatus");

/**
 * Canonical free rate-limit/usage read for Codex OAuth accounts. This is the
 * `ChatGptApi` path style from the official Codex CLI
 * (`backend-client/src/client/rate_limit_resets.rs:83`, base
 * `https://chatgpt.com/backend-api`). It costs ZERO quota — it powers the CLI's
 * `/status` without an inference call.
 *
 * We hardcode the canonical URL rather than deriving it from
 * `account.custom_endpoint`, which is the INFERENCE endpoint (may be, e.g.,
 * `https://api.openai.com/v1`). The official alternate path for a base WITHOUT
 * `/backend-api` is `/api/codex/usage` (rate_limit_resets.rs:82) — not probed
 * here; that is a later concern.
 */
export const CODEX_USAGE_STATUS_ENDPOINT =
	"https://chatgpt.com/backend-api/wham/usage";

const REQUEST_TIMEOUT_MS = 5_000;

export interface FetchCodexUsageStatusArgs {
	/** A FRESH access token (from `getValidAccessToken`). */
	accessToken: string;
	/**
	 * ChatGPT account id for the `ChatGPT-Account-Id` header. Callers resolve it
	 * (e.g. via `readChatgptAccountId`); `null`/empty omits the header.
	 */
	chatgptAccountId: string | null;
	/** Injected for testability. Defaults to global `fetch`. */
	fetchImpl?: typeof fetch;
	/** Injected for testability. Defaults to `Date.now`. */
	now?: () => number;
}

/**
 * Rich result of a `/wham/usage` read. Deliberately NOT just `UsageData | null`
 * so 1b can distinguish transport/status failures from a genuine exhausted-but-
 * reachable account (a 200 for an exhausted account must NOT trigger
 * success-recovery that clears `rate_limited_until`).
 */
export interface CodexUsageStatus {
	/** `{ five_hour, seven_day, codexCredits? }`; `null` when no usable windows. */
	usage: UsageData | null;
	/** Root `rate_limit.allowed`; `null` when absent/unparseable. */
	allowed: boolean | null;
	/** Root `rate_limit.limit_reached`; `null` when absent/unparseable. */
	limitReached: boolean | null;
	/** Root `rate_limit_reached_type.type`; `null` when absent. */
	rateLimitReachedType: string | null;
	/** Inline `rate_limit_reset_credits.available_count` summary; `null` when absent. */
	resetCreditsAvailableCount: number | null;
	/** `true` only on HTTP 200 with a parseable JSON-object body. */
	ok: boolean;
	/** HTTP status (for 1b to distinguish 404/405 vs 401/403/429/5xx); `null` on network throw. */
	status: number | null;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as UnknownRecord)
		: null;
}

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteInteger(value: unknown): number | null {
	const parsed = finiteNumber(value);
	return parsed === null ? null : Math.trunc(parsed);
}

function nullableString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function toIsoString(timestampMs: number): string | null {
	if (!Number.isFinite(timestampMs)) return null;
	try {
		return new Date(timestampMs).toISOString();
	} catch {
		return null;
	}
}

function failedStatus(status: number | null): CodexUsageStatus {
	return {
		usage: null,
		allowed: null,
		limitReached: null,
		rateLimitReachedType: null,
		resetCreditsAvailableCount: null,
		ok: false,
		status,
	};
}

/**
 * Parse a single `RateLimitWindowSnapshot` (SECONDS-based) into a `{ slot, data }`
 * pair, sharing the placeholder/slot semantics of the header parser via
 * `normalizeCodexWindow`. Reset time prefers absolute `reset_at` (epoch seconds),
 * falling back to `now + reset_after_seconds`.
 */
function parseWindow(
	value: unknown,
	nowMs: number,
): { slot: "five_hour" | "seven_day" | null; data: UsageWindow | null } {
	const win = asRecord(value);
	if (!win) return { slot: null, data: null };

	const utilization = finiteNumber(win.used_percent);
	const windowSeconds = finiteNumber(win.limit_window_seconds);
	const resetAt = finiteNumber(win.reset_at);
	const resetAfter = finiteNumber(win.reset_after_seconds);

	let resetsAt: string | null = null;
	if (resetAt !== null && resetAt > 0) {
		resetsAt = toIsoString(resetAt * 1_000);
	} else if (resetAfter !== null && resetAfter > 0) {
		resetsAt = toIsoString(nowMs + resetAfter * 1_000);
	}

	return normalizeCodexWindow(utilization, windowSeconds, resetsAt);
}

/**
 * Map the top-level `credits` (`CreditStatusDetails`) + `plan_type` + the weekly
 * (secondary) window's utilization onto our existing `CodexCreditsInfo` shape.
 * Returns `null` when `credits` is absent, matching the header parser (which
 * treats a missing `x-codex-credits-has-credits` as a non-credits response).
 */
function parseCredits(
	root: UnknownRecord,
	weeklyUsedPct: number | null,
): CodexCreditsInfo | null {
	const credits = asRecord(root.credits);
	if (!credits) return null;

	const balanceRaw =
		typeof credits.balance === "string"
			? Number.parseFloat(credits.balance)
			: finiteNumber(credits.balance);
	const balance =
		balanceRaw === null || !Number.isFinite(balanceRaw)
			? null
			: Math.round(balanceRaw * 100) / 100;

	return {
		hasCredits: credits.has_credits === true,
		balance,
		unlimited: credits.unlimited === true,
		planType: nullableString(root.plan_type),
		weeklyUsedPct,
	};
}

/**
 * Pure parser for a `/wham/usage` JSON body. `ok` is `true` only when `body` is
 * a usable JSON object; on a parse-shape failure it returns `failedStatus`.
 * Never throws.
 */
export function parseCodexUsageStatus(
	body: unknown,
	status: number,
	nowMs: number,
): CodexUsageStatus {
	const root = asRecord(body);
	if (!root) return failedStatus(status);

	const rateLimit = asRecord(root.rate_limit);
	const allowed =
		typeof rateLimit?.allowed === "boolean" ? rateLimit.allowed : null;
	const limitReached =
		typeof rateLimit?.limit_reached === "boolean"
			? rateLimit.limit_reached
			: null;

	const reachedType = asRecord(root.rate_limit_reached_type);
	const rateLimitReachedType = nullableString(reachedType?.type);

	const summary = asRecord(root.rate_limit_reset_credits);
	const resetCreditsAvailableCount = finiteInteger(summary?.available_count);

	// Root `rate_limit` IS the Codex limit; its primary/secondary windows map to
	// five_hour/seven_day by duration. `additional_rate_limits[]` (keyed by
	// `metered_feature`/`limit_name`) is intentionally ignored — the root limit
	// already carries the Codex windows. Reading it is a no-op so a present array
	// cannot crash the parser.
	const primary = parseWindow(rateLimit?.primary_window, nowMs);
	const secondary = parseWindow(rateLimit?.secondary_window, nowMs);

	const fiveHour =
		(primary.slot === "five_hour" ? primary.data : null) ??
		(secondary.slot === "five_hour" ? secondary.data : null);
	const sevenDay =
		(primary.slot === "seven_day" ? primary.data : null) ??
		(secondary.slot === "seven_day" ? secondary.data : null);

	let usage: UsageData | null = null;
	if (fiveHour || sevenDay) {
		const weeklyUsedPct = sevenDay ? sevenDay.utilization : null;
		const codexCredits = parseCredits(root, weeklyUsedPct);
		usage = {
			// Codex retired its rolling 5-hour window. Emit `fiveHour` verbatim
			// (`null` when absent) rather than a fabricated `{0, null}` placeholder,
			// which is byte-identical to Anthropic's genuine idle 5h window and would
			// resurrect the dead-card bug. The `if (fiveHour || sevenDay)` guard above
			// already ensures at least one window exists.
			five_hour: fiveHour,
			seven_day: sevenDay ?? { utilization: 0, resets_at: null },
			...(codexCredits ? { codexCredits } : {}),
		};
	}

	return {
		usage,
		allowed,
		limitReached,
		rateLimitReachedType,
		resetCreditsAvailableCount,
		ok: true,
		status,
	};
}

function createUsageStatusHeaders(
	accessToken: string,
	chatgptAccountId: string | null,
): Headers {
	const headers = new Headers({
		Authorization: `Bearer ${accessToken}`,
		Accept: "application/json",
		Version: CODEX_VERSION,
		"User-Agent": CODEX_USER_AGENT,
		originator: "codex_cli_rs",
	});
	const accountId = chatgptAccountId?.trim();
	if (accountId) headers.set("ChatGPT-Account-ID", accountId);
	return headers;
}

/**
 * Read Codex free usage/rate-limit status via `GET /backend-api/wham/usage`.
 * Zero quota cost. Fail-clean: any non-200, parse error, or network throw
 * returns `ok: false` (never throws) so the caller can keep its prior cache.
 */
export async function fetchCodexUsageStatus(
	args: FetchCodexUsageStatusArgs,
): Promise<CodexUsageStatus> {
	const {
		accessToken,
		chatgptAccountId,
		fetchImpl = fetch,
		now = Date.now,
	} = args;

	if (!accessToken || accessToken.trim() === "") {
		throw new Error("fetchCodexUsageStatus requires a non-empty access token");
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetchImpl(CODEX_USAGE_STATUS_ENDPOINT, {
			method: "GET",
			signal: controller.signal,
			headers: createUsageStatusHeaders(accessToken, chatgptAccountId),
		});

		if (!response.ok) {
			log.warn(
				`Usage-status endpoint returned ${response.status} ${response.statusText}`,
			);
			return failedStatus(response.status);
		}

		let body: unknown;
		try {
			body = await response.json();
		} catch {
			log.warn("Usage-status endpoint returned a non-JSON body");
			return failedStatus(response.status);
		}

		return parseCodexUsageStatus(body, response.status, now());
	} catch (error) {
		log.warn(
			"Failed to fetch Codex usage status:",
			error instanceof Error ? error.message : String(error),
		);
		return failedStatus(null);
	} finally {
		clearTimeout(timeoutId);
	}
}
