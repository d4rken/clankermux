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
	/** Unconfirmed: retry with the same request id. */
	| { kind: "retry"; message: string };

export function unconfirmedBankedResetMessage(
	nextAttemptAt: string | null,
): string {
	return nextAttemptAt
		? `Couldn't confirm — retry after ${formatResetTime(nextAttemptAt)}`
		: "Couldn't confirm — retry";
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
				message: "Unconfirmed for an hour — gave up",
			};
		default:
			return {
				kind: "retry",
				message: unconfirmedBankedResetMessage(response.nextAttemptAt),
			};
	}
}

/**
 * A manual claim of `grantId` whose outcome was never confirmed, recovered
 * from the ledger so a reloaded page retries it with its own request id.
 * Only the newest manual claim of that grant counts: a later one supersedes it.
 */
export function findResumableBankedResetClaim(
	events: ReadonlyArray<AnthropicBankedResetEventResponse>,
	grantId: string,
): (AnthropicBankedResetEventResponse & { requestId: string }) | null {
	const newest = events.find(
		(event) => event.trigger === "manual" && event.grantId === grantId,
	);
	if (!newest || newest.status !== "pending" || !newest.requestId) return null;
	return { ...newest, requestId: newest.requestId };
}
