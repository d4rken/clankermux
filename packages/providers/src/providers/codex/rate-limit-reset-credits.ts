import { Logger } from "@clankermux/logger";
import { CODEX_USER_AGENT, CODEX_VERSION } from "./provider";

const log = new Logger("CodexRateLimitResetCredits");

export const CODEX_RATE_LIMIT_RESET_CREDITS_ENDPOINT =
	"https://chatgpt.com/backend-api/codex/rate-limit-reset-credits";

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
	const seconds = finiteInteger(value);
	if (seconds === null || seconds < 0) return null;
	return Number.isFinite(new Date(seconds * 1_000).getTime()) ? seconds : null;
}

function nullableString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function readChatgptAccountId(accessToken: string): string | null {
	try {
		const payload = accessToken.split(".")[1];
		if (!payload) return null;
		const claims = asRecord(
			JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
		);
		const auth = asRecord(claims?.["https://api.openai.com/auth"]);
		return nullableString(auth?.chatgpt_account_id);
	} catch {
		return null;
	}
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

/**
 * Read earned reset metadata. This function intentionally exposes no consume
 * operation: it only performs the backend's GET request.
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
		const headers = new Headers({
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
			Version: CODEX_VERSION,
			"User-Agent": CODEX_USER_AGENT,
			originator: "codex_cli_rs",
		});
		const accountId = readChatgptAccountId(accessToken);
		if (accountId) headers.set("ChatGPT-Account-ID", accountId);

		const response = await fetch(CODEX_RATE_LIMIT_RESET_CREDITS_ENDPOINT, {
			method: "GET",
			signal: controller.signal,
			headers,
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
