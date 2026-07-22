import { Logger } from "@clankermux/logger";
import type {
	CodexRateLimitResetCreditConsumeOutcome,
	CodexRateLimitResetCreditConsumeRequest,
	CodexRateLimitResetCreditConsumeResult,
} from "@clankermux/types";
import { decodeJwtPayloadSafe } from "../../oauth/jwt";
import { CODEX_USER_AGENT, CODEX_VERSION } from "./provider";

const log = new Logger("CodexRateLimitResetCredits");

export const CODEX_RATE_LIMIT_RESET_CREDITS_ENDPOINT =
	"https://chatgpt.com/backend-api/codex/rate-limit-reset-credits";
/**
 * Internal ChatGPT backend route used by Codex's app-server. This is not a
 * public OpenAI developer API and may change without notice.
 */
export const CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_ENDPOINT =
	"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";

const REQUEST_TIMEOUT_MS = 5_000;
export const CODEX_RESET_CREDITS_REFRESH_MS = 15 * 60 * 1_000;
export const CODEX_RESET_CREDITS_RETRY_MS = 5 * 60 * 1_000;

export type CodexRateLimitResetCreditStatus =
	| "available"
	| "redeeming"
	| "redeemed"
	| "unknown";

export type CodexRateLimitResetType = "codexRateLimits" | "unknown";

export interface CodexRateLimitResetCredit {
	id: string;
	resetType: CodexRateLimitResetType;
	status: CodexRateLimitResetCreditStatus;
	/** Unix timestamp in seconds. */
	grantedAt: number;
	/** Unix timestamp in seconds, or null when the credit does not expire. */
	expiresAt: number | null;
	title: string | null;
	description: string | null;
}

export interface CodexRateLimitResetCreditsSummary {
	/** Authoritative count; the backend may cap the optional detail list. */
	availableCount: number;
	credits: CodexRateLimitResetCredit[] | null;
}

export interface CodexRateLimitResetCreditsCacheEntry {
	summary: CodexRateLimitResetCreditsSummary;
	fetchedAt: number;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as UnknownRecord)
		: null;
}

function finiteInteger(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return Math.trunc(value);
}

function unixSeconds(value: unknown): number | null {
	let seconds: number | null;
	if (typeof value === "string") {
		const milliseconds = Date.parse(value);
		seconds = Number.isFinite(milliseconds)
			? Math.floor(milliseconds / 1_000)
			: null;
	} else {
		seconds = finiteInteger(value);
	}
	if (seconds === null || seconds < 0) return null;
	return Number.isFinite(new Date(seconds * 1_000).getTime()) ? seconds : null;
}

function nullableString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

export function readChatgptAccountId(accessToken: string): string | null {
	const claims = decodeJwtPayloadSafe(accessToken);
	const auth = asRecord(claims?.["https://api.openai.com/auth"]);
	return nullableString(auth?.chatgpt_account_id);
}

function normalizeResetType(value: unknown): CodexRateLimitResetType {
	return value === "codexRateLimits" || value === "codex_rate_limits"
		? "codexRateLimits"
		: "unknown";
}

function normalizeStatus(value: unknown): CodexRateLimitResetCreditStatus {
	switch (value) {
		case "available":
		case "redeeming":
		case "redeemed":
			return value;
		default:
			return "unknown";
	}
}

function normalizeConsumeOutcome(
	value: unknown,
): CodexRateLimitResetCreditConsumeOutcome | null {
	switch (value) {
		case "reset":
			return "reset";
		case "nothing_to_reset":
		case "nothingToReset":
			return "nothingToReset";
		case "no_credit":
		case "noCredit":
			return "noCredit";
		case "already_redeemed":
		case "alreadyRedeemed":
			return "alreadyRedeemed";
		default:
			return null;
	}
}

function parseCredit(value: unknown): CodexRateLimitResetCredit | null {
	const row = asRecord(value);
	if (!row) return null;
	const id = nullableString(row.id);
	const grantedAt = unixSeconds(row.grantedAt ?? row.granted_at);
	if (!id || grantedAt === null) return null;

	return {
		id,
		resetType: normalizeResetType(row.resetType ?? row.reset_type),
		status: normalizeStatus(row.status),
		grantedAt,
		expiresAt: unixSeconds(row.expiresAt ?? row.expires_at),
		title: nullableString(row.title),
		description: nullableString(row.description),
	};
}

/**
 * Parse either the backend's snake_case JSON or Codex app-server's normalized
 * camelCase shape. Unknown detail rows are dropped, while availableCount stays
 * authoritative because the backend is allowed to cap the detail list.
 */
export function parseCodexRateLimitResetCredits(
	value: unknown,
): CodexRateLimitResetCreditsSummary | null {
	const root = asRecord(value);
	if (!root) return null;
	const nested =
		asRecord(root.rateLimitResetCredits ?? root.rate_limit_reset_credits) ??
		root;
	const availableCount = finiteInteger(
		nested.availableCount ?? nested.available_count,
	);
	if (availableCount === null || availableCount < 0) return null;

	const rawCredits = nested.credits;
	let credits: CodexRateLimitResetCredit[] | null = null;
	if (Array.isArray(rawCredits)) {
		credits = rawCredits
			.map(parseCredit)
			.filter((credit): credit is CodexRateLimitResetCredit => credit !== null);
	}

	return { availableCount, credits };
}

/** Parse either the raw backend response or Codex app-server's normalized form. */
export function parseCodexRateLimitResetCreditConsumeResult(
	value: unknown,
): CodexRateLimitResetCreditConsumeResult | null {
	const root = asRecord(value);
	if (!root) return null;
	const outcome = normalizeConsumeOutcome(root.code ?? root.outcome);
	if (!outcome) return null;
	const rawWindowsReset = finiteInteger(
		root.windowsReset ?? root.windows_reset ?? 0,
	);
	if (rawWindowsReset === null || rawWindowsReset < 0) return null;
	return { outcome, windowsReset: rawWindowsReset };
}

function createResetCreditsHeaders(accessToken: string): Headers {
	const headers = new Headers({
		Authorization: `Bearer ${accessToken}`,
		Accept: "application/json",
		Version: CODEX_VERSION,
		"User-Agent": CODEX_USER_AGENT,
		originator: "codex_cli_rs",
	});
	const accountId = readChatgptAccountId(accessToken);
	if (accountId) headers.set("ChatGPT-Account-ID", accountId);
	return headers;
}

/**
 * Read earned reset metadata. This function is non-mutating and only performs
 * the backend's GET request.
 */
export async function fetchCodexRateLimitResetCredits(
	accessToken: string,
): Promise<CodexRateLimitResetCreditsSummary | null> {
	if (!accessToken || accessToken.trim() === "") {
		throw new Error(
			"fetchCodexRateLimitResetCredits requires a non-empty access token",
		);
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(CODEX_RATE_LIMIT_RESET_CREDITS_ENDPOINT, {
			method: "GET",
			signal: controller.signal,
			headers: createResetCreditsHeaders(accessToken),
		});

		if (!response.ok) {
			log.warn(
				`Reset-credit endpoint returned ${response.status} ${response.statusText}`,
			);
			return null;
		}

		const parsed = parseCodexRateLimitResetCredits(await response.json());
		if (!parsed) {
			log.warn("Reset-credit endpoint returned an unrecognized payload");
		}
		return parsed;
	} catch (error) {
		log.warn(
			"Failed to fetch Codex reset-credit metadata:",
			error instanceof Error ? error.message : String(error),
		);
		return null;
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Consume one earned reset credit through Codex's internal ChatGPT backend.
 *
 * This is intentionally a low-level action: callers provide the idempotency
 * key, and transport/contract failures throw so they cannot be confused with a
 * business outcome such as `noCredit`. Reuse the same key when retrying.
 */
export async function consumeCodexRateLimitResetCredit(
	accessToken: string,
	request: CodexRateLimitResetCreditConsumeRequest,
): Promise<CodexRateLimitResetCreditConsumeResult> {
	if (!accessToken || accessToken.trim() === "") {
		throw new Error(
			"consumeCodexRateLimitResetCredit requires a non-empty access token",
		);
	}
	const idempotencyKey = request.idempotencyKey?.trim();
	if (!idempotencyKey) {
		throw new Error("idempotencyKey must not be empty");
	}
	const creditId = request.creditId?.trim() || null;
	if (request.creditId != null && !creditId) {
		throw new Error("creditId must not be empty when provided");
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const headers = createResetCreditsHeaders(accessToken);
		headers.set("Content-Type", "application/json");
		const response = await fetch(
			CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_ENDPOINT,
			{
				method: "POST",
				signal: controller.signal,
				headers,
				body: JSON.stringify({
					redeem_request_id: idempotencyKey,
					...(creditId ? { credit_id: creditId } : {}),
				}),
			},
		);

		if (!response.ok) {
			throw new Error(
				`Codex reset-credit consume endpoint returned ${response.status} ${response.statusText}`,
			);
		}

		const parsed = parseCodexRateLimitResetCreditConsumeResult(
			await response.json(),
		);
		if (!parsed) {
			throw new Error(
				"Codex reset-credit consume endpoint returned an unrecognized payload",
			);
		}
		return parsed;
	} catch (error) {
		if (error instanceof Error) throw error;
		throw new Error(String(error));
	} finally {
		clearTimeout(timeoutId);
	}
}

class CodexRateLimitResetCreditsCache {
	private readonly entries = new Map<
		string,
		CodexRateLimitResetCreditsCacheEntry
	>();
	private readonly lastAttemptAt = new Map<string, number>();

	get(accountId: string): CodexRateLimitResetCreditsCacheEntry | null {
		return this.entries.get(accountId) ?? null;
	}

	set(
		accountId: string,
		summary: CodexRateLimitResetCreditsSummary,
		now = Date.now(),
	): void {
		this.entries.set(accountId, { summary, fetchedAt: now });
		this.lastAttemptAt.set(accountId, now);
	}

	markAttempt(accountId: string, now = Date.now()): void {
		this.lastAttemptAt.set(accountId, now);
	}

	needsRefresh(accountId: string, now = Date.now()): boolean {
		const entry = this.entries.get(accountId);
		if (entry) {
			if (now - entry.fetchedAt >= CODEX_RESET_CREDITS_REFRESH_MS) return true;
			const nextExpiryMs = entry.summary.credits
				?.flatMap((credit) =>
					credit.status === "available" && credit.expiresAt !== null
						? [credit.expiresAt * 1_000]
						: [],
				)
				.sort((a, b) => a - b)[0];
			if (nextExpiryMs !== undefined && nextExpiryMs <= now) return true;
			return false;
		}

		const attemptedAt = this.lastAttemptAt.get(accountId);
		return (
			attemptedAt === undefined ||
			now - attemptedAt >= CODEX_RESET_CREDITS_RETRY_MS
		);
	}

	delete(accountId: string): void {
		this.entries.delete(accountId);
		this.lastAttemptAt.delete(accountId);
	}

	clear(): void {
		this.entries.clear();
		this.lastAttemptAt.clear();
	}
}

export const codexRateLimitResetCreditsCache =
	new CodexRateLimitResetCreditsCache();
