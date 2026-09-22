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
import type {
	Account,
	AccountIdentity,
	AnthropicBankedResetClaimResult,
	AnthropicBankedResetStatus,
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
	fenceAndRefetch: mock(async (_id: string) => true),
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
	dbOverrides = {};
	for (const fn of [
		fetchStatus,
		claim,
		fetchProfile,
		getValidAccessToken,
		refreshAccessTokenSafe,
		usage.fenceAndRefetch,
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
		expect(dbCalls).toContain("resumeAccountIfOveragePaused");
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

		claimImpl = async () => claimResult({ result: "already_used" });
		const second = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-replay",
		});
		expect(second.status === "completed" && second.windowsRestored).toBe(true);
		expect(usage.fenceAndRefetch).toHaveBeenCalledTimes(1);
		expect(dbCalls).not.toContain("resumeAccountIfOveragePaused");
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

	it("sends no POST when the account is disabled during the reads before it", async () => {
		accountReads = [{}, { disabled: true }];
		const outcome = await coordinator().claim(ACCOUNT_ID, {
			grantId: "g1",
			requestId: "req-disabled",
		});
		expect(outcome.status === "failed" && outcome.code).toBe("account_state");
		expect(claim).not.toHaveBeenCalled();
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
