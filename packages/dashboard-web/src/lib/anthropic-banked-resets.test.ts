import { describe, expect, it } from "bun:test";
import type {
	AccountResponse,
	AnthropicBankedResetClaimResponse,
	AnthropicBankedResetEventResponse,
	AnthropicBankedResetsInfo,
} from "@clankermux/types";
import {
	type AnthropicBankedResetGrantInfo,
	bankedResetClearsLabels,
	claimableBankedResetGrant,
	describeBankedResetClaim,
	findResumableBankedResetClaim,
	formatBankedResetReason,
	showsAnthropicBankedResetChip,
} from "./anthropic-banked-resets";

function grant(
	overrides: Partial<AnthropicBankedResetGrantInfo> = {},
): AnthropicBankedResetGrantInfo {
	return {
		id: "g1",
		label: "Welcome reset",
		resetsLeft: 1,
		resetsTotal: 2,
		endsAt: "2030-01-05T00:00:00.000Z",
		startsAt: null,
		clears: ["seven_day"],
		paused: false,
		usableNow: true,
		useRequiresLimit: true,
		isNext: true,
		...overrides,
	};
}

function info(
	overrides: Partial<AnthropicBankedResetsInfo> = {},
): AnthropicBankedResetsInfo {
	return {
		eligible: true,
		ineligibleReason: null,
		exhausted: [],
		cooldownUntil: null,
		weeklyResetsAt: null,
		nextGrantId: "g1",
		grants: [grant()],
		resetsLeftTotal: 1,
		fetchedAt: "2030-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("showsAnthropicBankedResetChip", () => {
	const account = (overrides: Partial<AccountResponse>) =>
		({
			provider: "anthropic",
			hasRefreshToken: true,
			anthropicBankedResets: info(),
			...overrides,
		}) as AccountResponse;

	it("shows for an Anthropic OAuth account with grants, even an ineligible one", () => {
		expect(showsAnthropicBankedResetChip(account({}))).toBe(true);
		expect(
			showsAnthropicBankedResetChip(
				account({
					anthropicBankedResets: info({
						eligible: false,
						ineligibleReason: "tier",
					}),
				}),
			),
		).toBe(true);
	});

	it("hides without a status, without grants, on API-key and non-Anthropic accounts", () => {
		expect(
			showsAnthropicBankedResetChip(account({ anthropicBankedResets: null })),
		).toBe(false);
		expect(
			showsAnthropicBankedResetChip(
				account({
					anthropicBankedResets: info({
						eligible: false,
						ineligibleReason: "no_grant",
						grants: [],
						resetsLeftTotal: 0,
					}),
				}),
			),
		).toBe(false);
		expect(
			showsAnthropicBankedResetChip(account({ hasRefreshToken: false })),
		).toBe(false);
		expect(showsAnthropicBankedResetChip(account({ provider: "codex" }))).toBe(
			false,
		);
	});
});

describe("bankedResetClearsLabels", () => {
	it("names each window once, in a fixed order, and drops other windows", () => {
		expect(
			bankedResetClearsLabels([
				"seven_day_sonnet",
				"seven_day_cowork",
				"seven_day_overage_included",
				"five_hour",
				"seven_day",
				"seven_day_opus",
			]),
		).toEqual(["session", "weekly", "Opus weekly", "Sonnet weekly"]);
		expect(bankedResetClearsLabels(["seven_day_oauth_apps"])).toEqual([]);
	});
});

describe("formatBankedResetReason", () => {
	it("labels known reasons and de-underscores unknown ones", () => {
		expect(formatBankedResetReason("cli_version")).toBe("Claude Code version");
		expect(formatBankedResetReason("not_next_grant")).toBe("not next grant");
	});
});

describe("claimableBankedResetGrant", () => {
	it("returns the next grant only while it is usable, unpaused and not spent", () => {
		expect(claimableBankedResetGrant(info())?.id).toBe("g1");
		for (const blocked of [
			grant({ usableNow: false }),
			grant({ paused: true }),
			grant({ resetsLeft: 0 }),
			grant({ isNext: false }),
		]) {
			expect(claimableBankedResetGrant(info({ grants: [blocked] }))).toBeNull();
		}
		expect(claimableBankedResetGrant(null)).toBeNull();
	});
});

describe("describeBankedResetClaim", () => {
	function response(
		overrides: Partial<AnthropicBankedResetClaimResponse>,
	): AnthropicBankedResetClaimResponse {
		return {
			success: false,
			message: "server message",
			eventId: "row-1",
			status: "reset",
			result: "reset",
			reason: null,
			resetsLeft: null,
			cleared: [],
			cooldownUntil: null,
			nextAttemptAt: null,
			statusRefreshed: false,
			...overrides,
		};
	}

	it.each([
		["reset", "Limits reset", true],
		["already_used", "Already used", false],
		["not_limited", "Not at a limit — nothing used", false],
		["cooldown", "Cooling down", false],
		["ineligible", "Not eligible", false],
		["failed", "Unconfirmed for an hour — gave up", false],
	] as const)("settles '%s' as '%s'", (status, message, success) => {
		expect(describeBankedResetClaim(response({ status }))).toEqual({
			kind: "done",
			success,
			message,
		});
	});

	it("names the cooldown end and the ineligible reason", () => {
		const cooldown = describeBankedResetClaim(
			response({
				status: "cooldown",
				cooldownUntil: "2030-01-05T10:00:00.000Z",
			}),
		);
		expect(cooldown.message).toStartWith("Cooling down until ");
		expect(cooldown.message).not.toBe("Cooling down until ");
		expect(
			describeBankedResetClaim(
				response({ status: "ineligible", reason: "tier" }),
			).message,
		).toBe("Not eligible (plan tier)");
	});

	it("asks for a retry while the claim is unconfirmed", () => {
		expect(
			describeBankedResetClaim(
				response({ status: "pending", result: "rate_limited" }),
			),
		).toEqual({ kind: "retry", message: "Couldn't confirm — retry" });
		const timed = describeBankedResetClaim(
			response({
				status: "pending",
				result: "unavailable",
				nextAttemptAt: "2030-01-05T10:00:00.000Z",
			}),
		);
		expect(timed.kind).toBe("retry");
		expect(timed.message).toStartWith("Couldn't confirm — retry after ");
		expect(
			describeBankedResetClaim(response({ status: "unavailable" })),
		).toEqual({ kind: "retry", message: "Couldn't confirm — retry" });
	});
});

describe("findResumableBankedResetClaim", () => {
	function event(
		overrides: Partial<AnthropicBankedResetEventResponse>,
	): AnthropicBankedResetEventResponse {
		return {
			id: "e",
			grantId: "g1",
			trigger: "manual",
			cause: null,
			attemptSeq: null,
			status: "pending",
			reason: null,
			cleared: [],
			resetsLeft: null,
			errorMessage: null,
			grantEndsAt: null,
			nextAttemptAt: null,
			createdAt: "2030-01-01T00:00:00.000Z",
			resolvedAt: null,
			...overrides,
		};
	}

	it("returns the newest manual claim of the grant while it is pending", () => {
		const pending = event({ id: "p", requestId: "req-1" });
		expect(
			findResumableBankedResetClaim(
				[
					event({ id: "a", trigger: "auto", requestId: undefined }),
					event({ id: "other", grantId: "g2", requestId: "req-2" }),
					pending,
				],
				"g1",
			)?.requestId,
		).toBe("req-1");
	});

	it("ignores a pending claim superseded by a newer manual one, or without a request id", () => {
		expect(
			findResumableBankedResetClaim(
				[
					event({ id: "new", status: "reset" }),
					event({ id: "old", requestId: "req-1" }),
				],
				"g1",
			),
		).toBeNull();
		expect(findResumableBankedResetClaim([event({})], "g1")).toBeNull();
		expect(
			findResumableBankedResetClaim([event({ requestId: "req-1" })], "g2"),
		).toBeNull();
	});
});
