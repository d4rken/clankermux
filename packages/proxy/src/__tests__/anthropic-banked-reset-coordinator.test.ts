/**
 * AnthropicBankedResetCoordinator: status read, claim, ledger and the
 * post-claim sequence. Transports, token helpers and the usage cache are
 * injected; the ledger runs on a real database.
 */
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
} from "bun:test";
import { DatabaseOperations } from "@clankermux/database";
import {
	type AnthropicBankedResetStatusFetchResult,
	anthropicBankedResetCache,
	USAGE_RATE_LIMITED_DEFAULT_MS,
} from "@clankermux/providers";
import { makeAccount, tempDbTracker } from "@clankermux/test-support";
import {
	type Account,
	type AccountIdentity,
	ANTHROPIC_BANKED_RESET_REPLAY_WINDOW_MS,
	type AnthropicBankedResetClaimResult,
	type AnthropicBankedResetStatus,
} from "@clankermux/types";
import {
	AnthropicBankedResetCoordinator,
	BANKED_RESET_CLAIM_RETRY_MIN_MS,
	bankedResetClaimRetryDelayMs,
} from "../anthropic-banked-reset-coordinator";
import {
	getFamilyWeeklyExhaustedUntil,
	recordFamilyWeeklyExhausted,
	resetFamilyWeeklyMemoForTests,
} from "../family-weekly-memo";
import type { ProxyContext } from "../handlers/proxy-types";

const tmpDb = tempDbTracker("banked-reset-coordinator");
const NOW = Date.parse("2026-09-22T12:00:00Z");
const ACCOUNT_ID = "acct-1";
const PAUSE_EPOCH = 7;
const OVERAGE_PAUSED = {
	paused: true,
	pause_reason: "overage",
	auto_pause_on_overage_enabled: true,
} as const;
const resumedAny = () => dbCalls.some((call) => call.startsWith("resume"));

let clock = NOW;
let realDbOps: DatabaseOperations;
let accountReads: Array<Partial<Account>>;
let baseAccount: Partial<Account>;
let dbCalls: string[];
let statusImpl: () => Promise<AnthropicBankedResetStatusFetchResult>;
let claimImpl: (
	token: string,
	orgUuid: string,
	ids: { grantId: string; requestId: string },
) => Promise<AnthropicBankedResetClaimResult>;
let profileImpl: () => Promise<AccountIdentity | null>;
let canFetchProfile = true;
let rateLimitedUntil: number | null = null;
/** What the usage cache holds after the post-claim refetch. */
let usageReading: unknown = null;
let refetchSucceeds = true;
/** Ledger methods replaced on the coordinator's dbOps, e.g. to make one throw. */
let dbOverrides: Partial<DatabaseOperations>;

const fetchStatus = mock(() => statusImpl());
const claim = mock(
	(
		token: string,
		orgUuid: string,
		ids: { grantId: string; requestId: string },
	) => claimImpl(token, orgUuid, ids),
);
const fetchProfile = mock(() => profileImpl());
const getValidAccessToken = mock(async () => "token");
const refreshAccessTokenSafe = mock(async () => "fresh-token");
const usage = {
	fenceAndRefetch: mock(async (_id: string) => refetchSucceeds),
	get: mock((_id: string) => usageReading as never),
	noteRateLimited: mock((_id: string, _until: number) => {}),
	getRateLimitedUntil: mock((_id: string) => rateLimitedUntil),
};

function status(
	overrides: Partial<AnthropicBankedResetStatus> = {},
): AnthropicBankedResetStatus {
	return {
		eligible: true,
		ineligibleReason: null,
		atLimit: true,
		exhausted: ["seven_day"],
		grants: [
			{
				id: "g1",
				label: "Weekly reset",
				resetsTotal: 2,
				resetsLeft: 2,
				startsAt: null,
				endsAt: NOW + 86_400_000,
				clears: ["seven_day"],
				paused: false,
				usableNow: true,
				useRequiresLimit: true,
				percentUsed: {},
				blocking: [],
			},
		],
		nextGrantId: "g1",
		weeklyResetsAt: null,
		cooldownUntil: null,
		...overrides,
	};
}

function reading(fiveHour: number, sevenDay: number) {
	const resetsAt = new Date(NOW + 86_400_000).toISOString();
	return {
		five_hour: { utilization: fiveHour, resets_at: resetsAt },
		seven_day: { utilization: sevenDay, resets_at: resetsAt },
	};
}

function claimResult(
	overrides: Partial<AnthropicBankedResetClaimResult> = {},
): AnthropicBankedResetClaimResult {
	return {
		result: "reset",
		reason: null,
		resetsLeft: 1,
		cleared: ["seven_day"],
		weeklyResetsAt: null,
		cooldownUntil: null,
		httpStatus: 200,
		retryAfterMs: null,
		errorMessage: null,
		...overrides,
	};
}

function coordinator(): AnthropicBankedResetCoordinator {
	const dbOps = Object.create(realDbOps) as DatabaseOperations;
	dbOps.getAccount = async (id: string) => {
		dbCalls.push("getAccount");
		const overrides = accountReads.shift() ?? {};
		return makeAccount({ id, ...baseAccount, ...overrides });
	};
	dbOps.resumeAccountIfOveragePaused = async () => {
		dbCalls.push("resumeAccountIfOveragePaused");
		return false;
	};
	dbOps.resumeAccountIfOveragePausedAt = async (_id, epoch) => {
		dbCalls.push(`resume@${epoch}`);
		return true;
	};
	dbOps.getAccountPauseMarker = async () => ({
		paused: Boolean(baseAccount.paused),
		pauseReason: baseAccount.pause_reason ?? null,
		autoPauseOnOverageEnabled: Boolean(
			baseAccount.auto_pause_on_overage_enabled,
		),
		pauseEpoch: PAUSE_EPOCH,
		pauseChangedAt: NOW - 600_000,
	});
	dbOps.setAccountIdentityFromProfile = async () => {
		dbCalls.push("setAccountIdentityFromProfile");
		return true;
	};
	dbOps.forceResetAccountRateLimit = async () => {
		dbCalls.push("forceResetAccountRateLimit");
		return true;
	};
	Object.assign(dbOps, dbOverrides);
	return new AnthropicBankedResetCoordinator(
		{ dbOps } as unknown as ProxyContext,
		{
			getValidAccessToken,
			refreshAccessTokenSafe,
			fetchStatus,
			claim,
			fetchProfile,
			canFetchProfile: () => canFetchProfile,
			usage,
			now: () => clock,
		},
	);
}

beforeEach(() => {
	clock = NOW;
	realDbOps = new DatabaseOperations(tmpDb.next());
	accountReads = [];
	baseAccount = {
		name: "claude-one",
		provider: "anthropic",
		refresh_token: "rt",
		access_token: "at",
		identity_organization_uuid: "org-uuid-1",
		anthropic_auto_apply_banked_resets_enabled: true,
		anthropic_auto_apply_banked_reset_on_weekly_limit_enabled: true,
	};
	dbCalls = [];
	statusImpl = async () => ({
		status: status(),
		httpStatus: 200,
		retryAfterMs: null,
	});
	claimImpl = async () => claimResult();
	profileImpl = async () => null;
	canFetchProfile = true;
	rateLimitedUntil = null;
	usageReading = reading(10, 10);
	refetchSucceeds = true;
	dbOverrides = {};
	for (const fn of [
		fetchStatus,
		claim,
		fetchProfile,
		getValidAccessToken,
		refreshAccessTokenSafe,
		usage.fenceAndRefetch,
		usage.get,
		usage.noteRateLimited,
		usage.getRateLimitedUntil,
	]) {
		fn.mockClear();
	}
	anthropicBankedResetCache.clear();
	resetFamilyWeeklyMemoForTests();
});

afterEach(async () => {
	await realDbOps.close();
});

afterAll(() => tmpDb.cleanup());

describe("refreshStatus", () => {
	it("stores the status and logs nothing to the shared backoff on success", async () => {
		const outcome = await coordinator().refreshStatus(ACCOUNT_ID, true);
		expect(outcome.success).toBe(true);
		expect(anthropicBankedResetCache.get(ACCOUNT_ID)?.status.nextGrantId).toBe(
			"g1",
		);
		expect(usage.noteRateLimited).not.toHaveBeenCalled();
	});

	it("skips the read while the shared usage bucket is rate-limited", async () => {
		rateLimitedUntil = NOW + 60_000;
		const outcome = await coordinator().refreshStatus(ACCOUNT_ID, true);
		expect(outcome.success).toBe(false);
		expect(fetchStatus).not.toHaveBeenCalled();
	});

	it("a 429 with Retry-After sets the shared backoff to that deadline", async () => {
		statusImpl = async () => ({
			status: null,
			httpStatus: 429,
			retryAfterMs: 90_000,
		});
		await coordinator().refreshStatus(ACCOUNT_ID, true);
		expect(usage.noteRateLimited).toHaveBeenCalledWith(
			ACCOUNT_ID,
			NOW + 90_000,
		);
	});

	it("a 429 without Retry-After uses the bounded default", async () => {
		statusImpl = async () => ({
			status: null,
			httpStatus: 429,
			retryAfterMs: null,
		});
		await coordinator().refreshStatus(ACCOUNT_ID, true);
		expect(usage.noteRateLimited).toHaveBeenCalledWith(
			ACCOUNT_ID,
			NOW + USAGE_RATE_LIMITED_DEFAULT_MS,
		);
	});

	it("refreshes the token once and retries after a 401", async () => {
		const tokens: string[] = [];
		fetchStatus.mockImplementation(async (...args: unknown[]) => {
			tokens.push(args[0] as string);
			return tokens.length === 1
				? { status: null, httpStatus: 401, retryAfterMs: null }
				: { status: status(), httpStatus: 200, retryAfterMs: null };
		});
		try {
			const outcome = await coordinator().refreshStatus(ACCOUNT_ID, true);
			expect(outcome.success).toBe(true);
			expect(tokens).toEqual(["token", "fresh-token"]);
		} finally {
			fetchStatus.mockImplementation(() => statusImpl());
		}
	});

	it("shares one in-flight read and honours the cache when not forced", async () => {
		const c = coordinator();
		await Promise.all([
			c.refreshStatus(ACCOUNT_ID, true),
			c.refreshStatus(ACCOUNT_ID, true),
		]);
		expect(fetchStatus).toHaveBeenCalledTimes(1);
		await c.refreshStatus(ACCOUNT_ID, false);
		expect(fetchStatus).toHaveBeenCalledTimes(1);
	});
});

describe("claim", () => {
	it("records the manual claim pending before the POST and resolves it", async () => {
		let pendingAtPost: string | undefined;
		claimImpl = async (_token, _org, ids) => {
			pendingAtPost = (
				await realDbOps.getAnthropicBankedResetEventByRequestId(
					ACCOUNT_ID,
					ids.requestId,
				)
			)?.status;
			return claimResult();
		};
		const outcome = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-1",
		});
		expect(pendingAtPost).toBe("pending");
		expect(outcome.status).toBe("completed");
		if (outcome.status !== "completed") return;
		expect(outcome.ledgerStatus).toBe("reset");
		const row = await realDbOps.getAnthropicBankedResetEventByRequestId(
			ACCOUNT_ID,
			"req-1",
		);
		expect(row?.status).toBe("reset");
		expect(row?.resets_left).toBe(1);
		expect(claim.mock.calls[0]?.[1]).toBe("org-uuid-1");
	});

	it("after a reset: fences usage, clears older memo entries, lifts an overage pause, re-reads status, and never touches rate_limit_reset", async () => {
		recordFamilyWeeklyExhausted(
			ACCOUNT_ID,
			"opus",
			NOW + 86_400_000,
			NOW - 1_000,
		);
		recordFamilyWeeklyExhausted(
			ACCOUNT_ID,
			"sonnet",
			NOW + 86_400_000,
			NOW - 1_000,
		);
		claimImpl = async () => {
			// A 429 observed after the claim started must survive the clear.
			recordFamilyWeeklyExhausted(
				ACCOUNT_ID,
				"sonnet",
				NOW + 86_400_000,
				NOW + 5,
			);
			return claimResult();
		};
		clock = NOW + 1;
		Object.assign(baseAccount, OVERAGE_PAUSED);
		const outcome = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-2",
		});
		expect(outcome.status).toBe("completed");
		if (outcome.status !== "completed") return;
		expect(outcome.windowsRestored).toBe(true);
		expect(outcome.statusRefreshed).toBe(true);
		expect(usage.fenceAndRefetch).toHaveBeenCalledWith(ACCOUNT_ID);
		expect(getFamilyWeeklyExhaustedUntil(ACCOUNT_ID, "opus", NOW)).toBeNull();
		expect(
			getFamilyWeeklyExhaustedUntil(ACCOUNT_ID, "sonnet", NOW),
		).not.toBeNull();
		expect(dbCalls).toContain(`resume@${PAUSE_EPOCH}`);
		expect(dbCalls).not.toContain("resumeAccountIfOveragePaused");
		expect(dbCalls).not.toContain("forceResetAccountRateLimit");
		expect(fetchStatus).toHaveBeenCalledTimes(1);
	});

	it("already_used on a fresh request id restores nothing", async () => {
		claimImpl = async () =>
			claimResult({ result: "already_used", cleared: [] });
		const outcome = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-fresh",
		});
		expect(outcome.status === "completed" && outcome.windowsRestored).toBe(
			false,
		);
		expect(usage.fenceAndRefetch).not.toHaveBeenCalled();
	});

	it("already_used on a replayed pending request id triggers the fence but not the overage resume", async () => {
		claimImpl = async () =>
			claimResult({
				result: "error",
				httpStatus: null,
				errorMessage: "timeout",
			});
		const first = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-replay",
		});
		expect(first.status === "completed" && first.ledgerStatus).toBe("pending");
		expect(usage.fenceAndRefetch).not.toHaveBeenCalled();

		clock = NOW + BANKED_RESET_CLAIM_RETRY_MIN_MS;
		claimImpl = async () => claimResult({ result: "already_used" });
		const second = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-replay",
		});
		expect(second.status === "completed" && second.windowsRestored).toBe(true);
		expect(usage.fenceAndRefetch).toHaveBeenCalledTimes(1);
		expect(resumedAny()).toBe(false);
		expect(claim.mock.calls.map((call) => call[2].requestId)).toEqual([
			"req-replay",
			"req-replay",
		]);
	});

	it("replays a claim left pending by a crash with the same request id", async () => {
		await realDbOps.beginManualAnthropicBankedResetAttempt({
			accountId: ACCOUNT_ID,
			accountName: "claude-one",
			grantId: "g1",
			requestId: "req-crash",
			grantEndsAt: null,
			now: NOW - 30_000,
		});
		claimImpl = async () => claimResult({ result: "already_used" });
		const outcome = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-crash",
		});
		expect(claim).toHaveBeenCalledTimes(1);
		expect(claim.mock.calls[0]?.[2].requestId).toBe("req-crash");
		expect(outcome.status === "completed" && outcome.windowsRestored).toBe(
			true,
		);
		expect(
			(
				await realDbOps.getAnthropicBankedResetEventByRequestId(
					ACCOUNT_ID,
					"req-crash",
				)
			)?.status,
		).toBe("already_used");
	});

	it("rejects a request id already bound to another grant without a POST", async () => {
		await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-bound",
		});
		claim.mockClear();
		const outcome = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g2",
			requestId: "req-bound",
		});
		expect(outcome.status === "failed" && outcome.code).toBe("grant_mismatch");
		expect(claim).not.toHaveBeenCalled();
	});

	it("refuses a manual claim under a new request id while a manual claim is pending, without a POST", async () => {
		await realDbOps.beginManualAnthropicBankedResetAttempt({
			accountId: ACCOUNT_ID,
			accountName: "claude-one",
			grantId: "g1",
			requestId: "req-unconfirmed",
			grantEndsAt: null,
			now: NOW - 30_000,
		});
		const outcome = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g2",
			requestId: "req-new",
		});
		expect(outcome).toMatchObject({
			status: "failed",
			code: "pending_claim",
			pendingRequestId: "req-unconfirmed",
			pendingGrantId: "g1",
		});
		expect(claim).not.toHaveBeenCalled();
		expect(
			await realDbOps.getAnthropicBankedResetEventByRequestId(
				ACCOUNT_ID,
				"req-new",
			),
		).toBeNull();
	});

	it("refuses a manual claim while an auto claim is pending, naming the auto row", async () => {
		const auto = await realDbOps.claimAnthropicBankedResetAutoAttempt({
			accountId: ACCOUNT_ID,
			accountName: "claude-one",
			grantId: "g1",
			grantEndsAt: null,
			cause: "expiry",
			now: NOW - 30_000,
		});
		if (!auto) throw new Error("expected an auto claim");
		const outcome = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-new",
		});
		expect(outcome).toMatchObject({
			status: "failed",
			code: "pending_claim",
			pendingRequestId: auto.requestId,
			pendingGrantId: "g1",
		});
		expect(claim).not.toHaveBeenCalled();

		// Retrying with the pending row's own id replays it.
		const replay = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: auto.requestId,
		});
		expect(replay.status === "completed" && replay.ledgerStatus).toBe("reset");
		expect(claim.mock.calls.map((call) => call[2].requestId)).toEqual([
			auto.requestId,
		]);
	});

	it("sends no manual POST when the pending ledger row cannot be written", async () => {
		dbOverrides.beginManualAnthropicBankedResetAttempt = async () => {
			throw new Error("database is locked");
		};
		const outcome = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-no-ledger",
		});
		expect(outcome).toMatchObject({ status: "failed", code: "error" });
		expect(outcome.status === "failed" && outcome.message).toContain(
			"database is locked",
		);
		expect(claim).not.toHaveBeenCalled();
	});

	it("sends no auto POST when its ledger row cannot be read back", async () => {
		const auto = await realDbOps.claimAnthropicBankedResetAutoAttempt({
			accountId: ACCOUNT_ID,
			accountName: "claude-one",
			grantId: "g1",
			grantEndsAt: null,
			cause: "expiry",
			now: NOW,
		});
		if (!auto) throw new Error("expected an auto claim");
		dbOverrides.getAnthropicBankedResetEventByRequestId = async () => {
			throw new Error("disk I/O error");
		};
		const outcome = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: auto.requestId,
			autoApply: { ledgerRowId: auto.id, cause: "expiry", replay: false },
		});
		expect(outcome).toMatchObject({ status: "failed", code: "error" });
		expect(claim).not.toHaveBeenCalled();
	});

	it("still returns the outcome when resolving the row after the POST fails", async () => {
		dbOverrides.resolveAnthropicBankedResetAttempt = async () => {
			throw new Error("database is locked");
		};
		const outcome = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-resolve-fails",
		});
		expect(claim).toHaveBeenCalledTimes(1);
		expect(outcome.status === "completed" && outcome.ledgerStatus).toBe(
			"reset",
		);
	});

	it("still returns a pending outcome when its retry time cannot be stored", async () => {
		dbOverrides.setAnthropicBankedResetNextAttemptAt = async () => {
			throw new Error("database is locked");
		};
		claimImpl = async () =>
			claimResult({ result: "unavailable", resetsLeft: null, cleared: [] });
		const outcome = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-schedule-fails",
		});
		expect(claim).toHaveBeenCalledTimes(1);
		expect(outcome.status === "completed" && outcome.ledgerStatus).toBe(
			"pending",
		);
	});

	it("answers a resolved request id from the ledger without a POST", async () => {
		await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-done",
		});
		claim.mockClear();
		const outcome = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-done",
		});
		expect(claim).not.toHaveBeenCalled();
		expect(outcome.status === "completed" && outcome.ledgerStatus).toBe(
			"reset",
		);
		expect(outcome.status === "completed" && outcome.result).toBeNull();
	});

	it("a claim 429 leaves the row pending until Retry-After", async () => {
		claimImpl = async () =>
			claimResult({
				result: "rate_limited",
				httpStatus: 429,
				retryAfterMs: 120_000,
			});
		const outcome = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-429",
		});
		const row = await realDbOps.getAnthropicBankedResetEventByRequestId(
			ACCOUNT_ID,
			"req-429",
		);
		expect(row?.status).toBe("pending");
		expect(row?.next_attempt_at).toBe(NOW + 120_000);
		expect(outcome.status === "completed" && outcome.nextAttemptAt).toBe(
			NOW + 120_000,
		);
	});

	it("an unanswered claim without Retry-After backs off exponentially from a minute", async () => {
		claimImpl = async () =>
			claimResult({ result: "unavailable", reason: "unavailable" });
		await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-503",
		});
		const row = await realDbOps.getAnthropicBankedResetEventByRequestId(
			ACCOUNT_ID,
			"req-503",
		);
		expect(row?.next_attempt_at).toBe(NOW + BANKED_RESET_CLAIM_RETRY_MIN_MS);
		expect(bankedResetClaimRetryDelayMs(NOW, NOW + 4 * 60_000, null)).toBe(
			4 * 60_000,
		);
		expect(bankedResetClaimRetryDelayMs(NOW, NOW + 60 * 60_000, null)).toBe(
			15 * 60_000,
		);
	});

	it("retries once with a fresh token after an auth error", async () => {
		const tokens: string[] = [];
		claimImpl = async (token) => {
			tokens.push(token);
			return tokens.length === 1
				? claimResult({
						result: "auth_error",
						httpStatus: 401,
						errorMessage: "401",
					})
				: claimResult();
		};
		const outcome = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-401",
		});
		expect(tokens).toEqual(["token", "fresh-token"]);
		expect(outcome.status === "completed" && outcome.ledgerStatus).toBe(
			"reset",
		);
	});

	it("sends no POST when the account is disabled while its ledger row is written, and releases the row", async () => {
		dbOverrides = {
			beginManualAnthropicBankedResetAttempt: async (input) => {
				const begun =
					await realDbOps.beginManualAnthropicBankedResetAttempt(input);
				baseAccount.disabled = true;
				return begun;
			},
		};
		const outcome = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-disabled",
		});
		expect(outcome.status === "failed" && outcome.code).toBe("account_state");
		expect(claim).not.toHaveBeenCalled();
		// Never sent, so it must not hold off the next claim for an hour.
		const row = await realDbOps.getAnthropicBankedResetEventByRequestId(
			ACCOUNT_ID,
			"req-disabled",
		);
		expect(row?.status).toBe("failed");
		expect(
			await realDbOps.getPendingAnthropicBankedResetAttempts(ACCOUNT_ID),
		).toEqual([]);
	});

	it("answers a retry of a never-sent claim with the recorded refusal", async () => {
		dbOverrides = {
			beginManualAnthropicBankedResetAttempt: async (input) => {
				const begun =
					await realDbOps.beginManualAnthropicBankedResetAttempt(input);
				baseAccount.disabled = true;
				return begun;
			},
		};
		await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-not-sent",
		});
		baseAccount.disabled = false;
		dbOverrides = {};
		const retry = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-not-sent",
		});
		expect(claim).not.toHaveBeenCalled();
		if (retry.status !== "completed") throw new Error("expected completed");
		expect(retry.ledgerStatus).toBe("failed");
		expect(retry.reason).toBe("not_sent");
		expect(retry.errorMessage).toBe(
			"Not sent: Account 'claude-one' is disabled",
		);
	});

	it("keeps a replayed manual row pending when the account is disabled before its POST", async () => {
		await realDbOps.beginManualAnthropicBankedResetAttempt({
			accountId: ACCOUNT_ID,
			accountName: "claude-one",
			grantId: "g1",
			requestId: "req-replay-disabled",
			grantEndsAt: null,
			now: NOW - 60_000,
		});
		accountReads = [{}, { disabled: true }];
		const outcome = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-replay-disabled",
		});
		expect(outcome.status).toBe("failed");
		expect(claim).not.toHaveBeenCalled();
		expect(
			(
				await realDbOps.getAnthropicBankedResetEventByRequestId(
					ACCOUNT_ID,
					"req-replay-disabled",
				)
			)?.status,
		).toBe("pending");
	});

	it("re-checks the account before the retry after an auth error", async () => {
		claimImpl = async () => {
			baseAccount.pause_reason = "oauth_invalid_grant";
			baseAccount.paused = true;
			return claimResult({
				result: "auth_error",
				httpStatus: 401,
				errorMessage: "401",
			});
		};
		const outcome = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-401-reauth",
		});
		expect(claim).toHaveBeenCalledTimes(1);
		expect(outcome.status === "completed" && outcome.ledgerStatus).toBe(
			"pending",
		);
		const row = await realDbOps.getAnthropicBankedResetEventByRequestId(
			ACCOUNT_ID,
			"req-401-reauth",
		);
		expect(row?.status).toBe("pending");
		expect(row?.next_attempt_at).not.toBeNull();
	});

	it("answers a manual retry before its next attempt time from the ledger, without a POST", async () => {
		claimImpl = async () =>
			claimResult({
				result: "rate_limited",
				httpStatus: 429,
				retryAfterMs: 120_000,
			});
		await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-early",
		});
		expect(claim).toHaveBeenCalledTimes(1);

		clock = NOW + 60_000;
		const early = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-early",
		});
		expect(claim).toHaveBeenCalledTimes(1);
		expect(early.status === "completed" && early.ledgerStatus).toBe("pending");
		expect(early.status === "completed" && early.nextAttemptAt).toBe(
			NOW + 120_000,
		);
		expect(early.status === "completed" && early.result).toBeNull();

		clock = NOW + 120_000;
		claimImpl = async () => claimResult();
		const due = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-early",
		});
		expect(claim).toHaveBeenCalledTimes(2);
		expect(due.status === "completed" && due.ledgerStatus).toBe("reset");
	});

	it("persists the server's cooldown as the re-arm deadline when it is later than an hour", async () => {
		claimImpl = async () =>
			claimResult({
				result: "cooldown",
				cleared: [],
				cooldownUntil: NOW + 3 * 60 * 60_000,
			});
		await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-cooldown",
		});
		expect(await realDbOps.getAnthropicBankedResetRearmAt(ACCOUNT_ID)).toBe(
			NOW + 3 * 60 * 60_000,
		);
	});

	it("sends no auto POST when its toggle was turned off meanwhile", async () => {
		const auto = await realDbOps.claimAnthropicBankedResetAutoAttempt({
			accountId: ACCOUNT_ID,
			accountName: "claude-one",
			grantId: "g1",
			grantEndsAt: null,
			cause: "weekly-limit",
			now: NOW,
		});
		if (!auto) throw new Error("expected an auto claim");
		accountReads = [
			{},
			{ anthropic_auto_apply_banked_reset_on_weekly_limit_enabled: false },
		];
		const outcome = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: auto.requestId,
			autoApply: { ledgerRowId: auto.id, cause: "weekly-limit", replay: false },
		});
		expect(outcome.status).toBe("failed");
		expect(claim).not.toHaveBeenCalled();
		expect(
			(
				await realDbOps.getAnthropicBankedResetEventByRequestId(
					ACCOUNT_ID,
					auto.requestId,
				)
			)?.status,
		).toBe("pending");
	});

	it("resolves an auto row through the ledger row id it was given", async () => {
		const auto = await realDbOps.claimAnthropicBankedResetAutoAttempt({
			accountId: ACCOUNT_ID,
			accountName: "claude-one",
			grantId: "g1",
			grantEndsAt: null,
			cause: "expiry",
			now: NOW,
		});
		if (!auto) throw new Error("expected an auto claim");
		claimImpl = async () => claimResult({ result: "not_limited", cleared: [] });
		const outcome = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: auto.requestId,
			autoApply: { ledgerRowId: auto.id, cause: "expiry", replay: false },
		});
		expect(outcome.status === "completed" && outcome.ledgerStatus).toBe(
			"not_limited",
		);
		expect(await realDbOps.getAnthropicBankedResetRearmAt(ACCOUNT_ID)).toBe(
			NOW + 60 * 60_000,
		);
	});

	it("reads the profile once for a missing org uuid and stores the identity", async () => {
		baseAccount.identity_organization_uuid = null;
		profileImpl = async () => ({
			externalAccountId: null,
			email: null,
			organizationName: null,
			organizationUuid: "org-from-profile",
			planTier: null,
			rateLimitTier: null,
		});
		await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-org",
		});
		expect(fetchProfile).toHaveBeenCalledTimes(1);
		expect(dbCalls).toContain("setAccountIdentityFromProfile");
		expect(claim.mock.calls[0]?.[1]).toBe("org-from-profile");
	});

	it("sends no POST when the org uuid is missing and the profile lacks it", async () => {
		baseAccount.identity_organization_uuid = null;
		profileImpl = async () => ({
			externalAccountId: null,
			email: null,
			organizationName: null,
			planTier: null,
			rateLimitTier: null,
		});
		const outcome = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-noorg",
		});
		expect(outcome.status).toBe("failed");
		expect(claim).not.toHaveBeenCalled();
		expect(
			await realDbOps.getAnthropicBankedResetEventByRequestId(
				ACCOUNT_ID,
				"req-noorg",
			),
		).toBeNull();
	});

	it("does not read the profile while it is rate-limited", async () => {
		baseAccount.identity_organization_uuid = null;
		canFetchProfile = false;
		const outcome = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-profile-429",
		});
		expect(outcome.status).toBe("failed");
		expect(fetchProfile).not.toHaveBeenCalled();
		expect(claim).not.toHaveBeenCalled();
	});
});

describe("the overage pause a reset owes a verdict", () => {
	const HOUR = 60 * 60_000;
	async function claimOnce(requestId: string) {
		await coordinator().claim(ACCOUNT_ID, { grantId: "g1", requestId });
		return realDbOps.getAnthropicBankedResetEventByRequestId(
			ACCOUNT_ID,
			requestId,
		);
	}
	beforeEach(() => {
		Object.assign(baseAccount, OVERAGE_PAUSED);
	});

	it("lifts exactly the claim-time pause and clears the obligation when the reading has headroom", async () => {
		const row = await claimOnce("req-lift");
		expect(dbCalls).toContain(`resume@${PAUSE_EPOCH}`);
		expect(row?.recovery_pending_until).toBeNull();
	});

	it("does the same for a cleared seven_day_overage_included window", async () => {
		claimImpl = async () =>
			claimResult({ cleared: ["seven_day_overage_included"] });
		await claimOnce("req-overage-window");
		expect(dbCalls).toContain(`resume@${PAUSE_EPOCH}`);
	});

	it("keeps the pause and records the obligation when the post-claim read failed", async () => {
		refetchSucceeds = false;
		const row = await claimOnce("req-owed-fail");
		expect(resumedAny()).toBe(false);
		expect(row?.recovery_pending_until).toBe(NOW + HOUR);
		expect(row?.recovery_pause_epoch).toBe(PAUSE_EPOCH);
		expect(row?.recovery_pause_changed_at).toBe(NOW - 600_000);
	});

	it("keeps the obligation when the post-claim reading lacks a window", async () => {
		usageReading = { five_hour: { utilization: 10, resets_at: null } };
		const row = await claimOnce("req-owed-partial-reading");
		expect(resumedAny()).toBe(false);
		expect(row?.recovery_pending_until).toBe(NOW + HOUR);
	});

	it("keeps the pause and clears the obligation when the reading is at a limit", async () => {
		usageReading = reading(100, 20);
		const five = await claimOnce("req-5h-full");
		usageReading = reading(20, 100);
		const seven = await claimOnce("req-7d-full");
		expect(resumedAny()).toBe(false);
		expect(five?.recovery_pending_until).toBeNull();
		expect(seven?.recovery_pending_until).toBeNull();
	});

	it("owes nothing for a partial reset, an unpaused account or another kind of pause", async () => {
		claimImpl = async () => claimResult({ cleared: ["five_hour"] });
		expect((await claimOnce("req-5h"))?.recovery_pending_until).toBeNull();

		claimImpl = async () => claimResult();
		refetchSucceeds = false;
		baseAccount.pause_reason = "manual";
		expect((await claimOnce("req-manual"))?.recovery_pending_until).toBeNull();
		baseAccount.paused = false;
		baseAccount.pause_reason = null;
		expect(
			(await claimOnce("req-unpaused"))?.recovery_pending_until,
		).toBeNull();
		expect(resumedAny()).toBe(false);
	});

	it("records the obligation with the resolution, before verification: a crash while verifying leaves it for recovery", async () => {
		let releaseRefetch: ((ok: boolean) => void) | undefined;
		usage.fenceAndRefetch.mockImplementationOnce(
			() =>
				new Promise<boolean>((resolve) => {
					releaseRefetch = resolve;
				}),
		);
		const pending = coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-crash-verify",
		});
		// The process "dies" here: the claim is still awaiting verification.
		for (let i = 0; i < 100; i++) {
			const row = await realDbOps.getAnthropicBankedResetEventByRequestId(
				ACCOUNT_ID,
				"req-crash-verify",
			);
			if (row?.status === "reset") break;
			await new Promise((r) => setTimeout(r, 1));
		}
		const owed = await realDbOps.getAnthropicBankedResetRecoveryPending();
		expect(
			owed.map((row) => [row.request_id, row.recovery_pause_epoch]),
		).toEqual([["req-crash-verify", PAUSE_EPOCH]]);
		expect(resumedAny()).toBe(false);
		releaseRefetch?.(false);
		await pending;
	});
});

describe("a pause that cannot be read before the POST", () => {
	const unreadable = {
		getAccountPauseMarker: async () => {
			throw new Error("database is locked");
		},
	} as Partial<DatabaseOperations>;

	it("sends no new manual claim and releases its row as not sent", async () => {
		dbOverrides = unreadable;
		const outcome = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-marker-new",
		});
		expect(claim).not.toHaveBeenCalled();
		expect(outcome.status === "failed" && outcome.code).toBe("error");
		const row = await realDbOps.getAnthropicBankedResetEventByRequestId(
			ACCOUNT_ID,
			"req-marker-new",
		);
		expect(row?.status).toBe("failed");
		expect(row?.reason).toBe("not_sent");
		expect(row?.error_message).toContain("database is locked");
	});

	it("keeps a replayed manual claim pending with a short retry time, unsent", async () => {
		await realDbOps.beginManualAnthropicBankedResetAttempt({
			accountId: ACCOUNT_ID,
			accountName: "claude-one",
			grantId: "g1",
			requestId: "req-marker-replay",
			grantEndsAt: null,
			now: NOW - 60_000,
		});
		dbOverrides = unreadable;
		await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-marker-replay",
		});
		expect(claim).not.toHaveBeenCalled();
		const row = await realDbOps.getAnthropicBankedResetEventByRequestId(
			ACCOUNT_ID,
			"req-marker-replay",
		);
		expect(row?.status).toBe("pending");
		expect(row?.next_attempt_at).toBe(NOW + BANKED_RESET_CLAIM_RETRY_MIN_MS);
	});

	it("keeps an auto claim pending with a short retry time, unsent", async () => {
		const auto = await realDbOps.claimAnthropicBankedResetAutoAttempt({
			accountId: ACCOUNT_ID,
			accountName: "claude-one",
			grantId: "g1",
			grantEndsAt: null,
			cause: "weekly-limit",
			now: NOW,
		});
		if (!auto) throw new Error("expected an auto claim");
		dbOverrides = unreadable;
		await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: auto.requestId,
			autoApply: { ledgerRowId: auto.id, cause: "weekly-limit", replay: false },
		});
		expect(claim).not.toHaveBeenCalled();
		const row = await realDbOps.getAnthropicBankedResetEventByRequestId(
			ACCOUNT_ID,
			auto.requestId,
		);
		expect(row?.status).toBe("pending");
		expect(row?.next_attempt_at).toBe(NOW + BANKED_RESET_CLAIM_RETRY_MIN_MS);
	});
});

describe("the replay window", () => {
	const WINDOW = ANTHROPIC_BANKED_RESET_REPLAY_WINDOW_MS;
	const unanswered = async () =>
		claimResult({ result: "error", httpStatus: null, errorMessage: "timeout" });

	async function openUnconfirmed(requestId: string): Promise<void> {
		claimImpl = unanswered;
		const first = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId,
		});
		expect(first.status === "completed" && first.ledgerStatus).toBe("pending");
		expect(first.status === "completed" && first.replayUntil).toBe(
			NOW + WINDOW,
		);
		claim.mockClear();
	}

	it("replays a manual claim with its request id at 9m59s", async () => {
		await openUnconfirmed("req-window");
		clock = NOW + 9 * 60_000 + 59_000;
		claimImpl = async () => claimResult({ result: "already_used" });
		const replay = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-window",
		});
		expect(claim.mock.calls.map((call) => call[2].requestId)).toEqual([
			"req-window",
		]);
		expect(replay.status === "completed" && replay.ledgerStatus).toBe(
			"already_used",
		);
	});

	it("resolves a manual claim failed/unconfirmed at 10 minutes, without a POST", async () => {
		await openUnconfirmed("req-window");
		clock = NOW + WINDOW;
		const late = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-window",
		});
		expect(claim).not.toHaveBeenCalled();
		expect(late).toMatchObject({
			status: "completed",
			ledgerStatus: "failed",
			reason: "unconfirmed",
			result: null,
			replayUntil: null,
		});
		const row = await realDbOps.getAnthropicBankedResetEventByRequestId(
			ACCOUNT_ID,
			"req-window",
		);
		expect(row?.status).toBe("failed");
		expect(row?.reason).toBe("unconfirmed");
		expect(row?.error_message).toContain("timeout");
	});

	it("records the answer to a claim given up while its POST was in flight", async () => {
		claimImpl = async () => {
			clock = NOW + WINDOW;
			await realDbOps.expireStaleAnthropicBankedResetAttempts(clock);
			return claimResult();
		};
		const outcome = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-in-flight",
		});
		expect(outcome.status === "completed" && outcome.ledgerStatus).toBe(
			"reset",
		);
		expect(
			(
				await realDbOps.getAnthropicBankedResetEventByRequestId(
					ACCOUNT_ID,
					"req-in-flight",
				)
			)?.status,
		).toBe("reset");
	});

	it("does not replay an auto claim at 10 minutes", async () => {
		const auto = await realDbOps.claimAnthropicBankedResetAutoAttempt({
			accountId: ACCOUNT_ID,
			accountName: "claude-one",
			grantId: "g1",
			grantEndsAt: null,
			cause: "weekly-limit",
			now: NOW - WINDOW,
		});
		if (!auto) throw new Error("expected an auto claim");
		const outcome = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: auto.requestId,
			autoApply: { ledgerRowId: auto.id, cause: "weekly-limit", replay: true },
		});
		expect(claim).not.toHaveBeenCalled();
		expect(outcome.status === "completed" && outcome.ledgerStatus).toBe(
			"failed",
		);
	});

	it("holds the account's claim guard until the window closes, then lets a new claim through", async () => {
		await openUnconfirmed("req-old");
		clock = NOW + WINDOW - 1;
		const blocked = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-new",
		});
		expect(blocked).toMatchObject({
			status: "failed",
			code: "pending_claim",
			pendingRequestId: "req-old",
			pendingReplayUntil: NOW + WINDOW,
		});
		expect(claim).not.toHaveBeenCalled();

		clock = NOW + WINDOW;
		claimImpl = async () => claimResult();
		const fresh = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-new",
		});
		expect(claim.mock.calls.map((call) => call[2].requestId)).toEqual([
			"req-new",
		]);
		expect(fresh.status === "completed" && fresh.ledgerStatus).toBe("reset");
		expect(
			(
				await realDbOps.getAnthropicBankedResetEventByRequestId(
					ACCOUNT_ID,
					"req-old",
				)
			)?.reason,
		).toBe("unconfirmed");
	});

	it("sends nothing when the window closes between the ledger sweep and the POST", async () => {
		await openUnconfirmed("req-slow");
		clock = NOW + WINDOW - 1;
		dbOverrides = {
			getAccountPauseMarker: async () => {
				clock = NOW + WINDOW;
				return {
					paused: false,
					pauseReason: null,
					autoPauseOnOverageEnabled: false,
					pauseEpoch: PAUSE_EPOCH,
					pauseChangedAt: null,
				};
			},
		};
		const outcome = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-slow",
		});
		expect(claim).not.toHaveBeenCalled();
		expect(outcome).toMatchObject({
			status: "completed",
			ledgerStatus: "failed",
			reason: "unconfirmed",
		});
	});

	it("does not retry after an auth error once the window has closed", async () => {
		await openUnconfirmed("req-401-late");
		clock = NOW + WINDOW - 1;
		claimImpl = async () => {
			clock = NOW + WINDOW;
			return claimResult({
				result: "auth_error",
				httpStatus: 401,
				errorMessage: "401",
			});
		};
		const outcome = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-401-late",
		});
		expect(claim).toHaveBeenCalledTimes(1);
		expect(outcome).toMatchObject({
			status: "completed",
			ledgerStatus: "failed",
			reason: "unconfirmed",
		});
	});

	it("records a new manual claim whose window closes before its POST as not sent", async () => {
		dbOverrides = {
			getAccountPauseMarker: async () => {
				clock = NOW + WINDOW;
				return {
					paused: false,
					pauseReason: null,
					autoPauseOnOverageEnabled: false,
					pauseEpoch: PAUSE_EPOCH,
					pauseChangedAt: null,
				};
			},
		};
		const outcome = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-never-left",
		});
		expect(claim).not.toHaveBeenCalled();
		expect(outcome).toMatchObject({
			status: "completed",
			ledgerStatus: "failed",
			reason: "not_sent",
		});
	});
});
