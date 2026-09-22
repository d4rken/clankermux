import { describe, expect, it } from "bun:test";
import { HttpError } from "@clankermux/http-common";
import type {
	AccountResponse,
	AnthropicBankedResetClaimResponse,
	AnthropicBankedResetEventResponse,
	AnthropicBankedResetsInfo,
} from "@clankermux/types";
import {
	type AnthropicBankedResetGrantInfo,
	bankedResetClearsLabels,
	bankedResetEventDetail,
	bankedResetEventStatusLabel,
	claimableBankedResetGrant,
	describeBankedResetClaim,
	findResumableBankedResetClaim,
	formatBankedResetReason,
	pendingBankedResetClaimOf,
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

	it("shows a never-sent claim's recorded refusal instead of 'gave up'", () => {
		expect(
			describeBankedResetClaim(
				response({
					status: "failed",
					reason: "not_sent",
					errorMessage: "Not sent: Account 'claude-one' is disabled",
				}),
			),
		).toEqual({
			kind: "done",
			success: false,
			message: "Not sent: Account 'claude-one' is disabled",
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
		expect(timed.kind === "retry" && timed.retryAt).toBe(
			Date.parse("2030-01-05T10:00:00.000Z"),
		);
		expect(
			describeBankedResetClaim(response({ status: "unavailable" })),
		).toEqual({ kind: "retry", message: "Couldn't confirm — retry" });
	});
});

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

describe("findResumableBankedResetClaim", () => {
	it("returns a pending manual claim whose grant the status still lists, next or not", () => {
		const events = [
			event({ id: "a", trigger: "auto" }),
			event({ id: "done", grantId: "g2", status: "reset" }),
			event({ id: "p", grantId: "g2", requestId: "req-1" }),
		];
		expect(findResumableBankedResetClaim(events, ["g1", "g2"])?.requestId).toBe(
			"req-1",
		);
	});

	it("ignores a claim whose grant is gone, and one without a request id", () => {
		expect(
			findResumableBankedResetClaim([event({ requestId: "req-1" })], ["g2"]),
		).toBeNull();
		expect(findResumableBankedResetClaim([event({})], ["g1"])).toBeNull();
	});
});

describe("bankedResetEventStatusLabel", () => {
	it("calls a pending claim for a grant no longer listed unconfirmed", () => {
		expect(bankedResetEventStatusLabel(event({}), ["g1"])).toBe("Pending");
		expect(bankedResetEventStatusLabel(event({}), ["g2"])).toBe("Unconfirmed");
		expect(
			bankedResetEventStatusLabel(event({ status: "reset" }), ["g2"]),
		).toBe("Reset applied");
	});
});

describe("bankedResetEventDetail", () => {
	it("shows a never-sent claim's refusal and nothing for one given up", () => {
		expect(
			bankedResetEventDetail(
				event({
					status: "failed",
					reason: "not_sent",
					errorMessage: "Not sent: Account 'claude-one' is disabled",
				}),
			),
		).toBe("Not sent: Account 'claude-one' is disabled");
		expect(
			bankedResetEventDetail(
				event({
					status: "failed",
					errorMessage: "Claim unconfirmed for an hour",
				}),
			),
		).toBeNull();
	});

	it("names cleared windows and an ineligible reason", () => {
		expect(
			bankedResetEventDetail(
				event({ status: "reset", cleared: ["seven_day"] }),
			),
		).toBe("cleared weekly");
		expect(
			bankedResetEventDetail(event({ status: "ineligible", reason: "tier" })),
		).toBe("plan tier");
	});
});

describe("pendingBankedResetClaimOf", () => {
	it("reads the pending claim out of a 409 refusal and nothing else", () => {
		expect(
			pendingBankedResetClaimOf(
				new HttpError(409, "An earlier claim is unconfirmed", {
					message: "An earlier claim is unconfirmed",
					pendingRequestId: "req-pending",
					pendingGrantId: "g0",
				}),
			),
		).toEqual({ requestId: "req-pending", grantId: "g0" });
		expect(
			pendingBankedResetClaimOf(new HttpError(409, "busy", "busy")),
		).toBeNull();
		expect(
			pendingBankedResetClaimOf(
				new HttpError(500, "x", { pendingRequestId: "r", pendingGrantId: "g" }),
			),
		).toBeNull();
		expect(pendingBankedResetClaimOf(new Error("x"))).toBeNull();
	});
});
