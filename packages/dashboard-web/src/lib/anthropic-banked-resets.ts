import { HttpError } from "@clankermux/http-common";
import type {
	AccountResponse,
	AnthropicBankedResetClaimResponse,
	AnthropicBankedResetEventResponse,
	AnthropicBankedResetsInfo,
	AnthropicBankedResetWindow,
} from "@clankermux/types";
import { formatResetTime } from "./account-status";

export type AnthropicBankedResetGrantInfo =
	AnthropicBankedResetsInfo["grants"][number];

/**
 * The banked-reset chip renders only where there is a grant to show. An
 * ineligible account with no grants, the common case, gets no chip at all.
 */
export function showsAnthropicBankedResetChip(
	account: AccountResponse,
): boolean {
	return (
		account.provider === "anthropic" &&
		account.hasRefreshToken &&
		(account.anthropicBankedResets?.grants.length ?? 0) > 0
	);
}

/** Display order of the windows a grant clears; other windows are not shown. */
const CLEARS_LABELS: ReadonlyArray<
	[string, ReadonlyArray<AnthropicBankedResetWindow>]
> = [
	["session", ["five_hour"]],
	["weekly", ["seven_day", "seven_day_overage_included"]],
	["Opus weekly", ["seven_day_opus"]],
	["Sonnet weekly", ["seven_day_sonnet"]],
];

/**
 * `["seven_day_sonnet", "five_hour", "seven_day"]` → `["session", "weekly",
 * "Sonnet weekly"]`.
 */
export function bankedResetClearsLabels(
	windows: ReadonlyArray<AnthropicBankedResetWindow>,
): string[] {
	return CLEARS_LABELS.filter(([, members]) =>
		members.some((window) => windows.includes(window)),
	).map(([label]) => label);
}

const INELIGIBLE_REASON_LABELS: Record<string, string> = {
	config_off: "program off",
	tier: "plan tier",
	seat: "seat type",
	mobile: "mobile",
	surface: "client surface",
	cli_version: "Claude Code version",
	no_grant: "no grant",
	tenure: "account age",
	other_experiment: "other experiment",
	unavailable: "unavailable",
	unknown: "unknown",
};

export function formatBankedResetReason(reason: string): string {
	return INELIGIBLE_REASON_LABELS[reason] ?? reason.replaceAll("_", " ");
}

/** The one grant Apply now may claim: the server's next grant, usable now. */
export function claimableBankedResetGrant(
	info: AnthropicBankedResetsInfo | null | undefined,
): AnthropicBankedResetGrantInfo | null {
	return (
		info?.grants.find(
			(grant) =>
				grant.isNext &&
				grant.usableNow &&
				!grant.paused &&
				grant.resetsLeft > 0,
		) ?? null
	);
}

/** What the Apply-now flow shows after the server answered a claim. */
export type BankedResetClaimView =
	| { kind: "done"; success: boolean; message: string }
	/** Unconfirmed: retry with the same request id, not before `retryAt` (ms epoch). */
	| { kind: "retry"; message: string; retryAt?: number };

export function unconfirmedBankedResetMessage(
	nextAttemptAt: string | null,
): string {
	return nextAttemptAt
		? `Couldn't confirm — retry after ${formatResetTime(nextAttemptAt)}`
		: "Couldn't confirm — retry";
}

/** `{retryAt}` for a parseable next attempt time, else nothing. */
export function retryAtOf(nextAttemptAt: string | null): { retryAt?: number } {
	const at = nextAttemptAt ? Date.parse(nextAttemptAt) : Number.NaN;
	return Number.isFinite(at) ? { retryAt: at } : {};
}

export function describeBankedResetClaim(
	response: AnthropicBankedResetClaimResponse,
): BankedResetClaimView {
	switch (response.status) {
		case "reset":
			return { kind: "done", success: true, message: "Limits reset" };
		case "already_used":
			return { kind: "done", success: false, message: "Already used" };
		case "not_limited":
			return {
				kind: "done",
				success: false,
				message: "Not at a limit — nothing used",
			};
		case "cooldown":
			return {
				kind: "done",
				success: false,
				message: response.cooldownUntil
					? `Cooling down until ${formatResetTime(response.cooldownUntil)}`
					: "Cooling down",
			};
		case "ineligible":
			return {
				kind: "done",
				success: false,
				message: response.reason
					? `Not eligible (${formatBankedResetReason(response.reason)})`
					: "Not eligible",
			};
		case "failed":
			return {
				kind: "done",
				success: false,
				message:
					response.reason === "not_sent"
						? (response.errorMessage ?? "Not sent")
						: "Unconfirmed for an hour — gave up",
			};
		default:
			return {
				kind: "retry",
				message: unconfirmedBankedResetMessage(response.nextAttemptAt),
				...retryAtOf(response.nextAttemptAt),
			};
	}
}

/**
 * A manual claim whose outcome was never confirmed, recovered from the ledger
 * so a reloaded page retries it with its own request id. The server refuses
 * every new claim on the account while it is pending, so it is offered for
 * any grant the status still lists; a claim for a grant that is gone has
 * nothing left to retry against.
 */
export function findResumableBankedResetClaim(
	events: ReadonlyArray<AnthropicBankedResetEventResponse>,
	grantIds: ReadonlyArray<string>,
): (AnthropicBankedResetEventResponse & { requestId: string }) | null {
	for (const event of events) {
		if (
			event.trigger === "manual" &&
			event.status === "pending" &&
			event.requestId &&
			grantIds.includes(event.grantId)
		) {
			return { ...event, requestId: event.requestId };
		}
	}
	return null;
}

const EVENT_STATUS_LABELS: Record<
	AnthropicBankedResetEventResponse["status"],
	string
> = {
	pending: "Pending",
	reset: "Reset applied",
	already_used: "Already used",
	not_limited: "Not at a limit",
	cooldown: "Cooldown",
	ineligible: "Not eligible",
	unavailable: "Unavailable",
	failed: "Failed",
};

/** The history row's detail line: cleared windows, or why it did not apply. */
export function bankedResetEventDetail(
	event: AnthropicBankedResetEventResponse,
): string | null {
	const cleared = bankedResetClearsLabels(event.cleared);
	if (cleared.length > 0) return `cleared ${cleared.join(", ")}`;
	if (event.status === "ineligible" && event.reason) {
		return formatBankedResetReason(event.reason);
	}
	if (event.status === "failed" && event.reason === "not_sent") {
		return event.errorMessage ?? "Not sent";
	}
	return null;
}

/** History label; a pending claim whose grant the status no longer lists is "Unconfirmed". */
export function bankedResetEventStatusLabel(
	event: AnthropicBankedResetEventResponse,
	grantIds: ReadonlyArray<string>,
): string {
	if (event.status === "pending" && !grantIds.includes(event.grantId)) {
		return "Unconfirmed";
	}
	return EVENT_STATUS_LABELS[event.status];
}

/**
 * The unconfirmed claim a 409 names when the server refused a new claim
 * because of it; null for any other error.
 */
export function pendingBankedResetClaimOf(
	error: unknown,
): { requestId: string; grantId: string } | null {
	if (!(error instanceof HttpError) || error.status !== 409) return null;
	const details = error.details;
	if (!details || typeof details !== "object") return null;
	const { pendingRequestId, pendingGrantId } = details as Record<
		string,
		unknown
	>;
	return typeof pendingRequestId === "string" &&
		typeof pendingGrantId === "string"
		? { requestId: pendingRequestId, grantId: pendingGrantId }
		: null;
}
