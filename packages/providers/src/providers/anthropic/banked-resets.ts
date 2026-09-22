import { Logger } from "@clankermux/logger";
import {
	ANTHROPIC_BANKED_RESET_CLAIM_REASONS,
	ANTHROPIC_BANKED_RESET_INELIGIBLE_REASONS,
	ANTHROPIC_BANKED_RESET_WINDOWS,
	type AnthropicBankedResetClaimReason,
	type AnthropicBankedResetClaimResult,
	type AnthropicBankedResetClaimServerResult,
	type AnthropicBankedResetGrant,
	type AnthropicBankedResetIneligibleReason,
	type AnthropicBankedResetStatus,
	type AnthropicBankedResetWindow,
} from "@clankermux/types";
import {
	anthropicOAuthUsageHeaders,
	parseRetryAfterMs,
} from "../../usage-fetcher";

const log = new Logger("AnthropicBankedResets");

/**
 * The OAuth usage endpoint with Claude Code's banked-reset (`cedar_ember`)
 * block requested and the spend block skipped. It shares its rate-limit bucket
 * with the usage poll.
 */
export const ANTHROPIC_BANKED_RESET_STATUS_ENDPOINT =
	"https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1";

export function anthropicBankedResetClaimEndpoint(orgUuid: string): string {
	return `https://api.anthropic.com/api/organizations/${encodeURIComponent(orgUuid)}/reset_rate_limits`;
}

const STATUS_TIMEOUT_MS = 5_000;
const CLAIM_TIMEOUT_MS = 25_000;
export const ANTHROPIC_BANKED_RESET_REFRESH_MS = 15 * 60 * 1_000;
export const ANTHROPIC_BANKED_RESET_RETRY_MS = 5 * 60 * 1_000;
export const ANTHROPIC_BANKED_RESET_INELIGIBLE_REFRESH_MS = 6 * 60 * 60 * 1_000;

/** Ineligibility that does not change from one read to the next. */
const STABLE_INELIGIBLE_REASONS: ReadonlySet<AnthropicBankedResetIneligibleReason> =
	new Set(["tier", "seat", "surface", "tenure", "config_off", "no_grant"]);

// Claude Code's own validation of the ids it sends.
const GRANT_ID_PATTERN = /^[a-z0-9_-]{1,40}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// Only has to keep the value a single path segment.
const ORG_UUID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const WINDOWS: ReadonlySet<string> = new Set(ANTHROPIC_BANKED_RESET_WINDOWS);
const INELIGIBLE_REASONS: ReadonlySet<string> = new Set(
	ANTHROPIC_BANKED_RESET_INELIGIBLE_REASONS,
);
const CLAIM_REASONS: ReadonlySet<string> = new Set(
	ANTHROPIC_BANKED_RESET_CLAIM_REASONS,
);
const CLAIM_SERVER_RESULTS: ReadonlySet<string> =
	new Set<AnthropicBankedResetClaimServerResult>([
		"reset",
		"already_used",
		"not_limited",
		"cooldown",
		"ineligible",
		"unavailable",
	]);

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as UnknownRecord)
		: null;
}

function nonNegativeInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0
		? value
		: null;
}

/**
 * An instant as ms epoch. The wire format is unobserved, so ISO strings and
 * epoch numbers are both accepted; a number below 1e12 is read as seconds.
 */
function instantMs(value: unknown): number | null {
	let ms: number | null = null;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		ms = Number.isFinite(parsed) ? parsed : null;
	} else if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		ms = value < 1e12 ? value * 1_000 : value;
	}
	return ms !== null && Number.isFinite(new Date(ms).getTime()) ? ms : null;
}

function windows(value: unknown): AnthropicBankedResetWindow[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(entry): entry is AnthropicBankedResetWindow =>
			typeof entry === "string" && WINDOWS.has(entry),
	);
}

function percentUsed(
	value: unknown,
): Partial<Record<AnthropicBankedResetWindow, number>> {
	const record = asRecord(value);
	const result: Partial<Record<AnthropicBankedResetWindow, number>> = {};
	if (!record) return result;
	for (const window of ANTHROPIC_BANKED_RESET_WINDOWS) {
		const percent = nonNegativeInteger(record[window]);
		if (percent !== null && percent <= 100) result[window] = percent;
	}
	return result;
}

function parseGrant(value: unknown): AnthropicBankedResetGrant | null {
	const row = asRecord(value);
	if (!row) return null;
	const id = typeof row.id === "string" ? row.id : null;
	const resetsTotal = nonNegativeInteger(row.resets_total);
	const resetsLeft = nonNegativeInteger(row.resets_left);
	if (
		id === null ||
		!GRANT_ID_PATTERN.test(id) ||
		resetsTotal === null ||
		resetsLeft === null ||
		!Array.isArray(row.clears)
	) {
		return null;
	}
	return {
		id,
		label: typeof row.label === "string" ? row.label : null,
		resetsTotal,
		resetsLeft,
		startsAt: instantMs(row.starts_at),
		endsAt: instantMs(row.ends_at),
		clears: windows(row.clears),
		paused: row.paused === true,
		usableNow: row.usable_now === true,
		useRequiresLimit: row.use_requires_limit !== false,
		percentUsed: percentUsed(row.percent_used),
		blocking: windows(row.blocking),
	};
}

/**
 * Parse the top-level `cedar_ember` block of the usage response, as leniently
 * as Claude Code does: unknown enum values fall back, malformed grants are
 * dropped, unknown window names are filtered. Null only when the block itself
 * is missing or not an object.
 */
export function parseCedarEmberBlock(
	value: unknown,
): AnthropicBankedResetStatus | null {
	const block = asRecord(value);
	if (!block) return null;

	const grants = Array.isArray(block.grants)
		? block.grants
				.map(parseGrant)
				.filter((grant): grant is AnthropicBankedResetGrant => grant !== null)
		: [];
	const nextGrantId =
		typeof block.next_grant_id === "string" &&
		grants.some((grant) => grant.id === block.next_grant_id)
			? block.next_grant_id
			: null;

	let ineligibleReason: AnthropicBankedResetIneligibleReason | null = null;
	if (typeof block.ineligible_reason === "string") {
		ineligibleReason = INELIGIBLE_REASONS.has(block.ineligible_reason)
			? (block.ineligible_reason as AnthropicBankedResetIneligibleReason)
			: "unknown";
	}

	return {
		eligible: block.eligible === true,
		ineligibleReason,
		atLimit: typeof block.at_limit === "boolean" ? block.at_limit : null,
		exhausted: windows(block.exhausted),
		grants,
		nextGrantId,
		weeklyResetsAt: instantMs(block.weekly_resets_at),
		cooldownUntil: instantMs(block.cooldown_until),
	};
}

/** The server's part of a 2xx claim response, parsed leniently. */
export function parseAnthropicBankedResetClaimResponse(
	value: unknown,
): Pick<
	AnthropicBankedResetClaimResult,
	| "result"
	| "reason"
	| "resetsLeft"
	| "cleared"
	| "weeklyResetsAt"
	| "cooldownUntil"
> {
	const body = asRecord(value) ?? {};
	let reason: AnthropicBankedResetClaimReason | null = null;
	if (typeof body.reason === "string") {
		reason = CLAIM_REASONS.has(body.reason)
			? (body.reason as AnthropicBankedResetClaimReason)
			: "unknown";
	}
	return {
		result:
			typeof body.result === "string" && CLAIM_SERVER_RESULTS.has(body.result)
				? (body.result as AnthropicBankedResetClaimServerResult)
				: "unavailable",
		reason,
		resetsLeft: nonNegativeInteger(body.resets_left),
		cleared: windows(body.cleared),
		weeklyResetsAt: instantMs(body.weekly_resets_at),
		cooldownUntil: instantMs(body.cooldown_until),
	};
}

export interface AnthropicBankedResetStatusFetchResult {
	/** Null when the read failed, or succeeded without a `cedar_ember` block. */
	status: AnthropicBankedResetStatus | null;
	/** HTTP status received; null when no response arrived. */
	httpStatus: number | null;
	/** From `Retry-After` on a 429; null otherwise. */
	retryAfterMs: number | null;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Read the account's banked-reset status. Never throws. */
export async function fetchAnthropicBankedResetStatus(
	accessToken: string,
): Promise<AnthropicBankedResetStatusFetchResult> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
	let httpStatus: number | null = null;
	try {
		const response = await fetch(ANTHROPIC_BANKED_RESET_STATUS_ENDPOINT, {
			method: "GET",
			headers: anthropicOAuthUsageHeaders(accessToken),
			signal: controller.signal,
		});
		httpStatus = response.status;
		if (!response.ok) {
			log.warn(
				`Banked-reset status read returned ${response.status} ${response.statusText}`,
			);
			return {
				status: null,
				httpStatus,
				retryAfterMs:
					response.status === 429
						? parseRetryAfterMs(response.headers.get("retry-after"))
						: null,
			};
		}
		const body = asRecord(await response.json());
		return {
			status: parseCedarEmberBlock(body?.cedar_ember),
			httpStatus,
			retryAfterMs: null,
		};
	} catch (error) {
		log.warn(`Banked-reset status read failed: ${errorMessage(error)}`);
		return { status: null, httpStatus, retryAfterMs: null };
	} finally {
		clearTimeout(timeoutId);
	}
}

function transportFailure(
	result: AnthropicBankedResetClaimResult["result"],
	message: string,
	httpStatus: number | null = null,
	retryAfterMs: number | null = null,
): AnthropicBankedResetClaimResult {
	return {
		result,
		reason: null,
		resetsLeft: null,
		cleared: [],
		weeklyResetsAt: null,
		cooldownUntil: null,
		httpStatus,
		retryAfterMs,
		errorMessage: message,
	};
}

/**
 * Claim one banked reset from `grantId`. Reuse `requestId` while a claim is
 * unconfirmed, as Claude Code does, so a replay cannot spend a second reset.
 * Never throws: invalid ids make no request and report `error`.
 */
export async function claimAnthropicBankedReset(
	accessToken: string,
	orgUuid: string,
	request: { grantId: string; requestId: string },
): Promise<AnthropicBankedResetClaimResult> {
	if (!ORG_UUID_PATTERN.test(orgUuid)) {
		return transportFailure("error", "Invalid organization uuid");
	}
	if (!GRANT_ID_PATTERN.test(request.grantId)) {
		return transportFailure("error", "Invalid grant id");
	}
	if (!REQUEST_ID_PATTERN.test(request.requestId)) {
		return transportFailure("error", "Invalid request id");
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), CLAIM_TIMEOUT_MS);
	let httpStatus: number | null = null;
	try {
		const response = await fetch(anthropicBankedResetClaimEndpoint(orgUuid), {
			method: "POST",
			headers: anthropicOAuthUsageHeaders(accessToken),
			body: JSON.stringify({
				program: "cedar_ember",
				grant_id: request.grantId,
				request_id: request.requestId,
			}),
			signal: controller.signal,
		});
		httpStatus = response.status;
		if (response.status === 429) {
			return transportFailure(
				"rate_limited",
				"Banked-reset claim was rate-limited",
				httpStatus,
				parseRetryAfterMs(response.headers.get("retry-after")),
			);
		}
		if (response.status === 401 || response.status === 403) {
			return transportFailure(
				"auth_error",
				`Banked-reset claim was refused with ${response.status}`,
				httpStatus,
			);
		}
		if (!response.ok) {
			return transportFailure(
				"error",
				`Banked-reset claim returned ${response.status} ${response.statusText}`,
				httpStatus,
			);
		}
		return {
			...parseAnthropicBankedResetClaimResponse(await response.json()),
			httpStatus,
			retryAfterMs: null,
			errorMessage: null,
		};
	} catch (error) {
		return transportFailure(
			"error",
			`Banked-reset claim failed: ${errorMessage(error)}`,
			httpStatus,
		);
	} finally {
		clearTimeout(timeoutId);
	}
}

export interface AnthropicBankedResetCacheEntry {
	status: AnthropicBankedResetStatus;
	fetchedAt: number;
}

class AnthropicBankedResetCache {
	private readonly entries = new Map<string, AnthropicBankedResetCacheEntry>();
	private readonly lastAttemptAt = new Map<string, number>();

	get(accountId: string): AnthropicBankedResetCacheEntry | null {
		return this.entries.get(accountId) ?? null;
	}

	set(
		accountId: string,
		status: AnthropicBankedResetStatus,
		now = Date.now(),
	): void {
		this.entries.set(accountId, { status, fetchedAt: now });
		this.lastAttemptAt.set(accountId, now);
	}

	/** Record a read that produced no status. */
	markAttempt(accountId: string, now = Date.now()): void {
		this.lastAttemptAt.set(accountId, now);
	}

	needsRefresh(accountId: string, now = Date.now()): boolean {
		const entry = this.entries.get(accountId);
		const attemptedAt = this.lastAttemptAt.get(accountId);
		if (
			attemptedAt !== undefined &&
			attemptedAt > (entry?.fetchedAt ?? Number.NEGATIVE_INFINITY) &&
			now - attemptedAt < ANTHROPIC_BANKED_RESET_RETRY_MS
		) {
			return false;
		}
		if (!entry) return true;

		const { status, fetchedAt } = entry;
		const ttl =
			!status.eligible &&
			status.ineligibleReason !== null &&
			STABLE_INELIGIBLE_REASONS.has(status.ineligibleReason)
				? ANTHROPIC_BANKED_RESET_INELIGIBLE_REFRESH_MS
				: ANTHROPIC_BANKED_RESET_REFRESH_MS;
		if (now - fetchedAt >= ttl) return true;

		// Only an instant that was still ahead when the status was read can have
		// changed it by passing.
		const passedSinceRead = (instant: number | null) =>
			instant !== null && instant > fetchedAt && instant <= now;
		return (
			passedSinceRead(status.cooldownUntil) ||
			status.grants.some((grant) => passedSinceRead(grant.endsAt))
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

export const anthropicBankedResetCache = new AnthropicBankedResetCache();
