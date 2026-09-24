import { describe, expect, it, mock } from "bun:test";
import type {
	AnthropicBankedResetEventRow,
	DatabaseOperations,
} from "@clankermux/database";
import type { AnthropicBankedResetClaimDispatchOutcome } from "@clankermux/proxy";
import { makeAccount } from "@clankermux/test-support";
import type { Account } from "@clankermux/types";
import {
	createAnthropicBankedResetAutoApplyHandler,
	createAnthropicBankedResetAutoApplyOnWeeklyLimitHandler,
	createAnthropicBankedResetClaimHandler,
	createAnthropicBankedResetEventsHandler,
	createAnthropicBankedResetRefreshHandler,
	toAnthropicBankedResetsInfo,
} from "../anthropic-banked-resets";

const NOW = Date.parse("2026-09-22T12:00:00Z");

function dbOps(
	account: Partial<Account> | null,
	extra: Record<string, unknown> = {},
): DatabaseOperations {
	return {
		getAccount: async (id: string) =>
			account
				? makeAccount({
						id,
						name: "claude-one",
						provider: "anthropic",
						refresh_token: "rt",
						...account,
					})
				: null,
		...extra,
	} as unknown as DatabaseOperations;
}

function post(body: unknown): Request {
	return new Request(
		"http://localhost/api/accounts/acct-1/banked-resets/claim",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: typeof body === "string" ? body : JSON.stringify(body),
		},
	);
}

function completed(
	overrides: Partial<
		Extract<AnthropicBankedResetClaimDispatchOutcome, { status: "completed" }>
	> = {},
): AnthropicBankedResetClaimDispatchOutcome {
	return {
		status: "completed",
		accountName: "claude-one",
		eventId: "row-1",
		ledgerStatus: "reset",
		result: {
			result: "reset",
			reason: null,
			resetsLeft: 1,
			cleared: ["seven_day"],
			weeklyResetsAt: null,
			cooldownUntil: null,
			httpStatus: 200,
			retryAfterMs: null,
			errorMessage: null,
		},
		reason: null,
		resetsLeft: 1,
		cleared: ["seven_day"],
		nextAttemptAt: null,
		replayUntil: null,
		windowsRestored: true,
		statusRefreshed: true,
		...overrides,
	};
}

describe("POST /api/accounts/:id/banked-resets/claim", () => {
	it.each([
		[{ grantId: "G1", requestId: "r1" }, "grantId"],
		[{ grantId: "g1", requestId: "bad id" }, "requestId"],
		[{ grantId: "g1" }, "requestId"],
	])("rejects malformed ids %j", async (body, field) => {
		const claim = mock(async () => completed());
		const res = await createAnthropicBankedResetClaimHandler(dbOps({}), claim)(
			post(body),
			"acct-1",
		);
		expect(res.status).toBe(400);
		expect(JSON.stringify(await res.json())).toContain(field);
		expect(claim).not.toHaveBeenCalled();
	});

	it("rejects invalid JSON", async () => {
		const res = await createAnthropicBankedResetClaimHandler(dbOps({}))(
			post("{"),
			"acct-1",
		);
		expect(res.status).toBe(400);
	});

	it("answers 404, 400 for non-Anthropic-OAuth and 409 for disabled accounts", async () => {
		const claim = mock(async () => completed());
		const body = { grantId: "g1", requestId: "r1" };
		const handler = (account: Partial<Account> | null) =>
			createAnthropicBankedResetClaimHandler(dbOps(account), claim)(
				post(body),
				"acct-1",
			);
		expect((await handler(null)).status).toBe(404);
		expect((await handler({ provider: "codex" })).status).toBe(400);
		expect((await handler({ refresh_token: "" })).status).toBe(400);
		expect((await handler({ disabled: true })).status).toBe(409);
		expect(claim).not.toHaveBeenCalled();
	});

	it("returns the ledger outcome of a reset", async () => {
		const claim = mock(async () => completed());
		const res = await createAnthropicBankedResetClaimHandler(dbOps({}), claim)(
			post({ grantId: "g1", requestId: "r1" }),
			"acct-1",
		);
		expect(res.status).toBe(200);
		expect(claim).toHaveBeenCalledWith("acct-1", {
			grantId: "g1",
			requestId: "r1",
		});
		expect(await res.json()).toMatchObject({
			success: true,
			eventId: "row-1",
			status: "reset",
			result: "reset",
			resetsLeft: 1,
			cleared: ["seven_day"],
			nextAttemptAt: null,
			statusRefreshed: true,
		});
	});

	it("reports already_used as success only when this request's earlier POST restored the limits", async () => {
		const alreadyUsed = (windowsRestored: boolean) =>
			mock(async () =>
				completed({
					ledgerStatus: "already_used",
					result: {
						result: "already_used",
						reason: "already_used",
						resetsLeft: 0,
						cleared: [],
						weeklyResetsAt: null,
						cooldownUntil: null,
						httpStatus: 200,
						retryAfterMs: null,
						errorMessage: null,
					},
					reason: "already_used",
					cleared: [],
					windowsRestored,
					statusRefreshed: windowsRestored,
				}),
			);
		const respond = async (windowsRestored: boolean) =>
			(
				await createAnthropicBankedResetClaimHandler(
					dbOps({}),
					alreadyUsed(windowsRestored),
				)(post({ grantId: "g1", requestId: "r1" }), "acct-1")
			).json();

		const fresh = await respond(false);
		expect(fresh).toMatchObject({ success: false, status: "already_used" });
		expect(fresh.message).toContain("nothing was restored");

		const landed = await respond(true);
		expect(landed).toMatchObject({ success: true, status: "already_used" });
		expect(landed.message).not.toContain("nothing was restored");
	});

	it("does not report an already_used row answered from the ledger as restored", async () => {
		const claim = mock(async () =>
			completed({
				ledgerStatus: "already_used",
				result: null,
				reason: "already_used",
				cleared: [],
				windowsRestored: false,
				statusRefreshed: false,
			}),
		);
		const body = await (
			await createAnthropicBankedResetClaimHandler(dbOps({}), claim)(
				post({ grantId: "g1", requestId: "r1" }),
				"acct-1",
			)
		).json();
		expect(body).toMatchObject({ success: false, status: "already_used" });
		expect(body.message).toContain("already completed");
	});

	it("reports a pending claim with its retry time", async () => {
		const claim = mock(async () =>
			completed({
				ledgerStatus: "pending",
				result: {
					result: "rate_limited",
					reason: null,
					resetsLeft: null,
					cleared: [],
					weeklyResetsAt: null,
					cooldownUntil: null,
					httpStatus: 429,
					retryAfterMs: 60_000,
					errorMessage: "Banked-reset request was rate-limited",
				},
				nextAttemptAt: NOW + 60_000,
				replayUntil: NOW + 10 * 60_000,
				windowsRestored: false,
				statusRefreshed: false,
			}),
		);
		const res = await createAnthropicBankedResetClaimHandler(dbOps({}), claim)(
			post({ grantId: "g1", requestId: "r1" }),
			"acct-1",
		);
		expect(await res.json()).toMatchObject({
			success: false,
			status: "pending",
			result: "rate_limited",
			nextAttemptAt: new Date(NOW + 60_000).toISOString(),
			replayUntil: new Date(NOW + 10 * 60_000).toISOString(),
		});
	});

	it("reports a claim given up when its replay window closed", async () => {
		const claim = mock(async () =>
			completed({
				ledgerStatus: "failed",
				result: null,
				reason: "unconfirmed",
				cleared: [],
				windowsRestored: false,
				statusRefreshed: false,
			}),
		);
		const res = await createAnthropicBankedResetClaimHandler(dbOps({}), claim)(
			post({ grantId: "g1", requestId: "r1" }),
			"acct-1",
		);
		const body = await res.json();
		expect(body).toMatchObject({
			status: "failed",
			reason: "unconfirmed",
			replayUntil: null,
		});
		expect(body.message).toContain("start a new one");
	});

	it("reports a never-sent claim with its recorded refusal, not as given up", async () => {
		const claim = mock(async () =>
			completed({
				ledgerStatus: "failed",
				result: null,
				reason: "not_sent",
				errorMessage: "Not sent: Account 'claude-one' is disabled",
				cleared: [],
				windowsRestored: false,
				statusRefreshed: false,
			}),
		);
		const res = await createAnthropicBankedResetClaimHandler(dbOps({}), claim)(
			post({ grantId: "g1", requestId: "r1" }),
			"acct-1",
		);
		const body = await res.json();
		expect(body.status).toBe("failed");
		expect(body.reason).toBe("not_sent");
		expect(body.errorMessage).toBe(
			"Not sent: Account 'claude-one' is disabled",
		);
		expect(body.message).toContain("Account 'claude-one' is disabled");
		expect(body.message).not.toContain("hour");
	});

	it("maps a refused claim to 409 and a failure to 500", async () => {
		const refused = mock(async () => ({
			status: "failed" as const,
			code: "grant_mismatch" as const,
			message: "bound to g2",
		}));
		const failed = mock(async () => ({
			status: "failed" as const,
			code: "error" as const,
			message: "no org uuid",
		}));
		const body = { grantId: "g1", requestId: "r1" };
		expect(
			(
				await createAnthropicBankedResetClaimHandler(dbOps({}), refused)(
					post(body),
					"acct-1",
				)
			).status,
		).toBe(409);
		expect(
			(
				await createAnthropicBankedResetClaimHandler(dbOps({}), failed)(
					post(body),
					"acct-1",
				)
			).status,
		).toBe(500);
	});
});

describe("POST /api/accounts/:id/banked-resets/claim — pending claim", () => {
	it("answers 409 with the pending claim's request and grant ids", async () => {
		const pending = mock(async () => ({
			status: "failed" as const,
			code: "pending_claim" as const,
			message: "An earlier attempt is unconfirmed",
			pendingRequestId: "req-pending",
			pendingGrantId: "g0",
			pendingReplayUntil: NOW + 10 * 60_000,
		}));
		const res = await createAnthropicBankedResetClaimHandler(
			dbOps({}),
			pending,
		)(post({ grantId: "g1", requestId: "r1" }), "acct-1");
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({
			message: "An earlier attempt is unconfirmed",
			pendingRequestId: "req-pending",
			pendingGrantId: "g0",
			pendingReplayUntil: new Date(NOW + 10 * 60_000).toISOString(),
		});
	});
});

describe("POST /api/accounts/:id/banked-resets/refresh", () => {
	it("forces a status read", async () => {
		const refresh = mock(async () => ({ success: true, message: "ok" }));
		const res = await createAnthropicBankedResetRefreshHandler(
			dbOps({}),
			refresh,
		)(new Request("http://localhost", { method: "POST" }), "acct-1");
		expect(res.status).toBe(200);
		expect(refresh).toHaveBeenCalledWith("acct-1", true);
	});
});

describe("auto-apply toggles", () => {
	function toggle(body: unknown): Request {
		return new Request("http://localhost", {
			method: "POST",
			body: JSON.stringify(body),
		});
	}

	it("sets the expiry toggle", async () => {
		const set = mock(async () => {});
		const res = await createAnthropicBankedResetAutoApplyHandler(
			dbOps({}, { setAnthropicAutoApplyBankedResetsEnabled: set }),
		)(toggle({ enabled: 1 }), "acct-1");
		expect(res.status).toBe(200);
		expect(set).toHaveBeenCalledWith("acct-1", true);
		expect((await res.json()).autoApplyBankedResetsEnabled).toBe(true);
	});

	it("sets the weekly toggle and refuses non-Anthropic accounts", async () => {
		const set = mock(async () => {});
		const ok = await createAnthropicBankedResetAutoApplyOnWeeklyLimitHandler(
			dbOps({}, { setAnthropicAutoApplyBankedResetOnWeeklyLimitEnabled: set }),
		)(toggle({ enabled: 0 }), "acct-1");
		expect((await ok.json()).autoApplyBankedResetOnWeeklyLimitEnabled).toBe(
			false,
		);
		const refused =
			await createAnthropicBankedResetAutoApplyOnWeeklyLimitHandler(
				dbOps(
					{ provider: "codex" },
					{ setAnthropicAutoApplyBankedResetOnWeeklyLimitEnabled: set },
				),
			)(toggle({ enabled: 1 }), "acct-1");
		expect(refused.status).toBe(400);
		expect(set).toHaveBeenCalledTimes(1);
	});

	it("requires enabled to be 0 or 1", async () => {
		const res = await createAnthropicBankedResetAutoApplyHandler(dbOps({}))(
			toggle({ enabled: 2 }),
			"acct-1",
		);
		expect(res.status).toBe(400);
	});
});

describe("GET /api/accounts/:id/banked-resets/events", () => {
	it("maps rows to the API shape without request ids and clamps the limit", async () => {
		const row: AnthropicBankedResetEventRow = {
			id: "acct-1:g1:1",
			account_id: "acct-1",
			account_name: "claude-one",
			grant_id: "g1",
			trigger: "auto",
			cause: "weekly-limit",
			attempt_seq: 1,
			request_id: "secret-request",
			status: "reset",
			reason: null,
			cleared: '["seven_day"]',
			resets_left: 1,
			error_message: null,
			grant_ends_at: NOW + 86_400_000,
			next_attempt_at: null,
			rearm_at: null,
			recovery_pending_until: null,
			recovery_pause_epoch: null,
			recovery_pause_changed_at: null,
			created_at: NOW,
			resolved_at: NOW + 1_000,
		};
		const getEvents = mock(async () => [row]);
		const res = await createAnthropicBankedResetEventsHandler(
			dbOps({}, { getRecentAnthropicBankedResetEvents: getEvents }),
		)(new URL("http://localhost/x?limit=500"), "acct-1");
		const body = await res.json();
		expect(getEvents).toHaveBeenCalledWith("acct-1", 100);
		expect(JSON.stringify(body)).not.toContain("secret-request");
		expect(body.events[0]).toEqual({
			id: "acct-1:g1:1",
			grantId: "g1",
			trigger: "auto",
			cause: "weekly-limit",
			attemptSeq: 1,
			status: "reset",
			reason: null,
			cleared: ["seven_day"],
			resetsLeft: 1,
			errorMessage: null,
			grantEndsAt: new Date(NOW + 86_400_000).toISOString(),
			nextAttemptAt: null,
			createdAt: new Date(NOW).toISOString(),
			resolvedAt: new Date(NOW + 1_000).toISOString(),
		});
	});

	it("serves the request id of a pending manual claim, and only that one", async () => {
		const base: AnthropicBankedResetEventRow = {
			id: "row",
			account_id: "acct-1",
			account_name: "claude-one",
			grant_id: "g1",
			trigger: "manual",
			cause: null,
			attempt_seq: null,
			request_id: "req",
			status: "pending",
			reason: null,
			cleared: null,
			resets_left: null,
			error_message: "Anthropic answered unavailable",
			grant_ends_at: null,
			next_attempt_at: NOW + 60_000,
			rearm_at: null,
			recovery_pending_until: null,
			recovery_pause_epoch: null,
			recovery_pause_changed_at: null,
			created_at: NOW,
			resolved_at: null,
		};
		const rows: AnthropicBankedResetEventRow[] = [
			{ ...base, id: "manual-pending", request_id: "manual-pending-req" },
			{
				...base,
				id: "manual-reset",
				request_id: "manual-reset-req",
				status: "reset",
				next_attempt_at: null,
				resolved_at: NOW,
			},
			{
				...base,
				id: "auto-pending",
				request_id: "auto-pending-req",
				trigger: "auto",
				cause: "expiry",
				attempt_seq: 1,
			},
		];
		const res = await createAnthropicBankedResetEventsHandler(
			dbOps({}, { getRecentAnthropicBankedResetEvents: async () => rows }),
		)(new URL("http://localhost/x"), "acct-1");
		const body = await res.json();
		expect(
			body.events.map((event: { requestId?: string }) => event.requestId),
		).toEqual(["manual-pending-req", undefined, undefined]);
		expect(JSON.stringify(body)).not.toContain("manual-reset-req");
		expect(JSON.stringify(body)).not.toContain("auto-pending-req");
	});
});

describe("toAnthropicBankedResetsInfo", () => {
	it("projects the cached status with ISO instants and the next-grant flag", () => {
		const info = toAnthropicBankedResetsInfo({
			fetchedAt: NOW,
			status: {
				eligible: true,
				ineligibleReason: null,
				atLimit: false,
				exhausted: [],
				grants: [
					{
						id: "g1",
						label: "Bonus",
						resetsTotal: 3,
						resetsLeft: 2,
						startsAt: null,
						endsAt: NOW + 1_000,
						clears: ["seven_day", "five_hour"],
						paused: false,
						usableNow: true,
						useRequiresLimit: false,
						percentUsed: {},
						blocking: [],
					},
					{
						id: "g2",
						label: null,
						resetsTotal: 1,
						resetsLeft: 1,
						startsAt: NOW,
						endsAt: null,
						clears: ["five_hour"],
						paused: true,
						usableNow: false,
						useRequiresLimit: true,
						percentUsed: {},
						blocking: [],
					},
				],
				nextGrantId: "g1",
				weeklyResetsAt: NOW + 5_000,
				cooldownUntil: null,
			},
		});
		expect(info.resetsLeftTotal).toBe(3);
		expect(info.fetchedAt).toBe(new Date(NOW).toISOString());
		expect(info.weeklyResetsAt).toBe(new Date(NOW + 5_000).toISOString());
		expect(info.grants.map((g) => [g.id, g.isNext, g.endsAt])).toEqual([
			["g1", true, new Date(NOW + 1_000).toISOString()],
			["g2", false, null],
		]);
	});
});
