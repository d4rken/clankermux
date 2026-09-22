import { validateNumber } from "@clankermux/core";
import type {
	AnthropicBankedResetEventRow,
	DatabaseOperations,
} from "@clankermux/database";
import {
	BadRequest,
	errorResponse,
	InternalServerError,
	jsonResponse,
	NotFound,
} from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import {
	ANTHROPIC_BANKED_RESET_GRANT_ID_PATTERN,
	ANTHROPIC_BANKED_RESET_REQUEST_ID_PATTERN,
	type AnthropicBankedResetCacheEntry,
} from "@clankermux/providers";
import {
	claimAnthropicBankedResetForAccount,
	refreshAnthropicBankedResetsForAccount,
} from "@clankermux/proxy";
import type {
	Account,
	AnthropicBankedResetClaimResponse,
	AnthropicBankedResetEventResponse,
	AnthropicBankedResetsInfo,
	AnthropicBankedResetWindow,
} from "@clankermux/types";

const log = new Logger("AnthropicBankedResetsHandler");

function iso(ms: number | null): string | null {
	return ms === null ? null : new Date(ms).toISOString();
}

/** Accounts that can hold banked resets: Anthropic with an OAuth refresh token. */
export function isAnthropicOAuthAccount(account: {
	provider: string | null;
	refresh_token: string | null;
}): boolean {
	return account.provider === "anthropic" && Boolean(account.refresh_token);
}

/** The accounts-list projection of a cached banked-reset status. */
export function toAnthropicBankedResetsInfo(
	entry: AnthropicBankedResetCacheEntry,
): AnthropicBankedResetsInfo {
	const { status } = entry;
	return {
		eligible: status.eligible,
		ineligibleReason: status.ineligibleReason,
		exhausted: status.exhausted,
		cooldownUntil: iso(status.cooldownUntil),
		weeklyResetsAt: iso(status.weeklyResetsAt),
		nextGrantId: status.nextGrantId,
		grants: status.grants.map((grant) => ({
			id: grant.id,
			label: grant.label,
			resetsLeft: grant.resetsLeft,
			resetsTotal: grant.resetsTotal,
			endsAt: iso(grant.endsAt),
			startsAt: iso(grant.startsAt),
			clears: grant.clears,
			paused: grant.paused,
			usableNow: grant.usableNow,
			useRequiresLimit: grant.useRequiresLimit,
			isNext: grant.id === status.nextGrantId,
		})),
		resetsLeftTotal: status.grants.reduce(
			(sum, grant) => sum + grant.resetsLeft,
			0,
		),
		fetchedAt: new Date(entry.fetchedAt).toISOString(),
	};
}

/** The account, or the error response for a missing or non-Anthropic-OAuth one. */
async function requireAnthropicOAuthAccount(
	dbOps: DatabaseOperations,
	accountId: string,
): Promise<Account | Response> {
	const account = await dbOps.getAccount(accountId);
	if (!account) return errorResponse(NotFound("Account not found"));
	if (!isAnthropicOAuthAccount(account)) {
		return errorResponse(
			BadRequest(
				"Banked resets are only available for Anthropic OAuth accounts",
			),
		);
	}
	return account;
}

function parseCleared(value: string | null): AnthropicBankedResetWindow[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter(
					(entry): entry is AnthropicBankedResetWindow =>
						typeof entry === "string",
				)
			: [];
	} catch {
		return [];
	}
}

function claimMessage(
	accountName: string,
	status: AnthropicBankedResetClaimResponse["status"],
	result: AnthropicBankedResetClaimResponse["result"],
	reason: string | null,
	errorMessage: string | null,
): string {
	if (status === "failed" && reason === "not_sent") {
		return `The banked-reset claim for account '${accountName}' was never sent (${errorMessage ?? "refused before sending"}); start a new one.`;
	}
	switch (status) {
		case "reset":
			return `Banked reset applied for account '${accountName}'.`;
		case "already_used":
			return `This banked-reset claim already completed for account '${accountName}'.`;
		case "not_limited":
			return `Account '${accountName}' is not at a limit this grant clears.`;
		case "cooldown":
			return `Account '${accountName}' is in a banked-reset cooldown.`;
		case "ineligible":
			return `Account '${accountName}' cannot use this banked reset.`;
		case "failed":
			return `This banked-reset claim was given up after an hour unconfirmed for account '${accountName}'.`;
		default:
			return `The banked-reset claim for account '${accountName}' is unconfirmed (${result ?? "pending"}); retry with the same request id.`;
	}
}

/**
 * Claim one banked reset. The caller owns the request id and must reuse it
 * when retrying the same claim.
 */
export function createAnthropicBankedResetClaimHandler(
	dbOps: DatabaseOperations,
	claim: typeof claimAnthropicBankedResetForAccount = claimAnthropicBankedResetForAccount,
) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body: unknown = await req.json();
			if (!body || typeof body !== "object" || Array.isArray(body)) {
				return errorResponse(BadRequest("Request body must be a JSON object"));
			}
			const input = body as Record<string, unknown>;
			const grantId = typeof input.grantId === "string" ? input.grantId : "";
			if (!ANTHROPIC_BANKED_RESET_GRANT_ID_PATTERN.test(grantId)) {
				return errorResponse(
					BadRequest("grantId must match ^[a-z0-9_-]{1,40}$"),
				);
			}
			const requestId =
				typeof input.requestId === "string" ? input.requestId : "";
			if (!ANTHROPIC_BANKED_RESET_REQUEST_ID_PATTERN.test(requestId)) {
				return errorResponse(
					BadRequest("requestId must match ^[A-Za-z0-9_-]{1,64}$"),
				);
			}

			const account = await requireAnthropicOAuthAccount(dbOps, accountId);
			if (account instanceof Response) return account;
			if (account.disabled) {
				return Response.json(
					{ error: "Enable this account before using it" },
					{ status: 409 },
				);
			}

			const dispatched = await claim(accountId, { grantId, requestId });
			if (
				dispatched.status === "failed" &&
				dispatched.code === "pending_claim"
			) {
				return Response.json(
					{
						message: dispatched.message,
						pendingRequestId: dispatched.pendingRequestId,
						pendingGrantId: dispatched.pendingGrantId,
					},
					{ status: 409 },
				);
			}
			if (dispatched.status === "failed") {
				return dispatched.code === "error"
					? errorResponse(InternalServerError(dispatched.message))
					: Response.json({ error: dispatched.message }, { status: 409 });
			}

			const response: AnthropicBankedResetClaimResponse = {
				success:
					dispatched.ledgerStatus === "reset" ||
					dispatched.ledgerStatus === "already_used",
				message: claimMessage(
					dispatched.accountName,
					dispatched.ledgerStatus,
					dispatched.result?.result ?? null,
					dispatched.reason,
					dispatched.errorMessage ?? null,
				),
				eventId: dispatched.eventId,
				status: dispatched.ledgerStatus,
				result: dispatched.result?.result ?? null,
				reason: dispatched.reason,
				errorMessage: dispatched.errorMessage ?? null,
				resetsLeft: dispatched.resetsLeft,
				cleared: dispatched.cleared,
				cooldownUntil: iso(dispatched.result?.cooldownUntil ?? null),
				nextAttemptAt: iso(dispatched.nextAttemptAt),
				statusRefreshed: dispatched.statusRefreshed,
			};
			return jsonResponse(response);
		} catch (error) {
			if (error instanceof SyntaxError) {
				return errorResponse(BadRequest("Request body must be valid JSON"));
			}
			log.error("Banked-reset claim error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to claim a banked reset"),
			);
		}
	};
}

/** Force a banked-reset status read (management only). */
export function createAnthropicBankedResetRefreshHandler(
	dbOps: DatabaseOperations,
	refresh: typeof refreshAnthropicBankedResetsForAccount = refreshAnthropicBankedResetsForAccount,
) {
	return async (_req: Request, accountId: string): Promise<Response> => {
		try {
			const account = await requireAnthropicOAuthAccount(dbOps, accountId);
			if (account instanceof Response) return account;
			if (account.disabled) {
				return Response.json(
					{ error: "Enable this account before using it" },
					{ status: 409 },
				);
			}
			const outcome = await refresh(accountId, true);
			return jsonResponse(outcome);
		} catch (error) {
			log.error("Banked-reset status refresh error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to read banked resets"),
			);
		}
	};
}

function createToggleHandler(
	dbOps: DatabaseOperations,
	options: {
		set: (accountId: string, enabled: boolean) => Promise<void>;
		field:
			| "autoApplyBankedResetsEnabled"
			| "autoApplyBankedResetOnWeeklyLimitEnabled";
		label: string;
	},
) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body = await req.json();
			const enabled = validateNumber(body?.enabled, "enabled", {
				required: true,
				allowedValues: [0, 1] as const,
			});
			if (enabled === undefined) {
				return errorResponse(BadRequest("Enabled field is required (0 or 1)"));
			}
			const account = await requireAnthropicOAuthAccount(dbOps, accountId);
			if (account instanceof Response) return account;

			await options.set(accountId, enabled === 1);
			return jsonResponse({
				success: true,
				message: `${options.label} ${enabled === 1 ? "enabled" : "disabled"} for account '${account.name}'`,
				[options.field]: enabled === 1,
			});
		} catch (error) {
			log.error(`${options.label} toggle error:`, error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error(`Failed to toggle ${options.label}`),
			);
		}
	};
}

/** Opt-in: claim the next grant before it expires unused. */
export function createAnthropicBankedResetAutoApplyHandler(
	dbOps: DatabaseOperations,
) {
	return createToggleHandler(dbOps, {
		set: (accountId, enabled) =>
			dbOps.setAnthropicAutoApplyBankedResetsEnabled(accountId, enabled),
		field: "autoApplyBankedResetsEnabled",
		label: "Auto-apply of banked resets",
	});
}

/** Opt-in: claim the next grant at a weekly limit it clears when no other account can serve. */
export function createAnthropicBankedResetAutoApplyOnWeeklyLimitHandler(
	dbOps: DatabaseOperations,
) {
	return createToggleHandler(dbOps, {
		set: (accountId, enabled) =>
			dbOps.setAnthropicAutoApplyBankedResetOnWeeklyLimitEnabled(
				accountId,
				enabled,
			),
		field: "autoApplyBankedResetOnWeeklyLimitEnabled",
		label: "Auto-apply of banked resets at the weekly limit",
	});
}

const EVENTS_DEFAULT_LIMIT = 20;
const EVENTS_MAX_LIMIT = 100;

export function toAnthropicBankedResetEventResponse(
	row: AnthropicBankedResetEventRow,
): AnthropicBankedResetEventResponse {
	return {
		id: row.id,
		grantId: row.grant_id,
		trigger: row.trigger === "auto" ? "auto" : "manual",
		cause:
			row.cause === "expiry" || row.cause === "weekly-limit" ? row.cause : null,
		attemptSeq: row.attempt_seq,
		status: row.status,
		reason: row.reason,
		cleared: parseCleared(row.cleared),
		resetsLeft: row.resets_left,
		errorMessage: row.error_message,
		grantEndsAt: iso(row.grant_ends_at),
		nextAttemptAt: iso(row.next_attempt_at),
		createdAt: new Date(row.created_at).toISOString(),
		resolvedAt: iso(row.resolved_at),
		...(row.trigger === "manual" && row.status === "pending"
			? { requestId: row.request_id }
			: {}),
	};
}

/**
 * Recent banked-reset ledger events, newest first. Request ids are withheld
 * except on pending manual claims, which only their request id can retry.
 */
export function createAnthropicBankedResetEventsHandler(
	dbOps: DatabaseOperations,
) {
	return async (url: URL, accountId: string): Promise<Response> => {
		try {
			const account = await requireAnthropicOAuthAccount(dbOps, accountId);
			if (account instanceof Response) return account;
			const limitParam = url.searchParams.get("limit");
			const parsedLimit = limitParam !== null ? Number(limitParam) : Number.NaN;
			const limit = Number.isFinite(parsedLimit)
				? Math.min(Math.max(Math.trunc(parsedLimit), 1), EVENTS_MAX_LIMIT)
				: EVENTS_DEFAULT_LIMIT;
			const rows = await dbOps.getRecentAnthropicBankedResetEvents(
				accountId,
				limit,
			);
			return jsonResponse({
				events: rows.map(toAnthropicBankedResetEventResponse),
			});
		} catch (error) {
			log.error("Banked-reset events error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to list banked-reset events"),
			);
		}
	};
}
