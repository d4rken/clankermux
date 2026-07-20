import { describe, expect, it, mock } from "bun:test";
import type { DatabaseOperations } from "@clankermux/database";
import type {
	Account,
	CodexRateLimitResetCreditConsumeRequest,
} from "@clankermux/types";
import { createAccountConsumeRateLimitResetCreditHandler } from "../accounts";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "account-1",
		name: "Codex One",
		provider: "codex",
		access_token: "access-token",
		refresh_token: "refresh-token",
		...overrides,
	} as Account;
}

function makeDbOps(account: Account | null): DatabaseOperations {
	return {
		getAccount: async (accountId: string) =>
			account?.id === accountId ? account : null,
	} as unknown as DatabaseOperations;
}

function request(body: unknown): Request {
	return new Request(
		"http://localhost/api/accounts/account-1/rate-limit-reset-credits/consume",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
	);
}

describe("createAccountConsumeRateLimitResetCreditHandler", () => {
	it("forwards the caller's idempotency key and selected credit", async () => {
		const consume = mock(
			async (
				_accountId: string,
				_request: CodexRateLimitResetCreditConsumeRequest,
			) => ({
				status: "completed" as const,
				accountName: "Codex One",
				result: { outcome: "reset" as const, windowsReset: 2 },
				resetMetadataRefreshed: true,
				availableResetCount: 2,
				localRateLimitStateCleared: true,
			}),
		);
		const handler = createAccountConsumeRateLimitResetCreditHandler(
			makeDbOps(makeAccount()),
			consume,
		);

		const response = await handler(
			request({
				idempotencyKey: "redeem-123",
				creditId: "credit-456",
			}),
			"account-1",
		);

		expect(response.status).toBe(200);
		expect(consume).toHaveBeenCalledWith("account-1", {
			idempotencyKey: "redeem-123",
			creditId: "credit-456",
		});
		expect(await response.json()).toEqual({
			success: true,
			message: "Usage limits reset for account 'Codex One'.",
			outcome: "reset",
			windowsReset: 2,
			resetMetadataRefreshed: true,
			availableResetCount: 2,
			localRateLimitStateCleared: true,
		});
	});

	it("returns noCredit as a successful HTTP dispatch but unsuccessful reset", async () => {
		const consume = mock(async () => ({
			status: "completed" as const,
			accountName: "Codex One",
			result: { outcome: "noCredit" as const, windowsReset: 0 },
			resetMetadataRefreshed: true,
			availableResetCount: 0,
			localRateLimitStateCleared: false,
		}));
		const handler = createAccountConsumeRateLimitResetCreditHandler(
			makeDbOps(makeAccount()),
			consume,
		);

		const response = await handler(
			request({ idempotencyKey: "redeem-none" }),
			"account-1",
		);
		const body = (await response.json()) as Record<string, unknown>;

		expect(response.status).toBe(200);
		expect(body.success).toBe(false);
		expect(body.outcome).toBe("noCredit");
		expect(body.availableResetCount).toBe(0);
	});

	it("treats alreadyRedeemed as an idempotent success", async () => {
		const consume = mock(async () => ({
			status: "completed" as const,
			accountName: "Codex One",
			result: { outcome: "alreadyRedeemed" as const, windowsReset: 0 },
			resetMetadataRefreshed: true,
			availableResetCount: 1,
			localRateLimitStateCleared: true,
		}));
		const handler = createAccountConsumeRateLimitResetCreditHandler(
			makeDbOps(makeAccount()),
			consume,
		);

		const response = await handler(
			request({ idempotencyKey: "redeem-retry" }),
			"account-1",
		);
		const body = (await response.json()) as Record<string, unknown>;

		expect(response.status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.outcome).toBe("alreadyRedeemed");
	});

	it("rejects missing idempotency and invalid account types before dispatch", async () => {
		const consume = mock(async () => ({
			status: "failed" as const,
			message: "must not run",
		}));
		const codexHandler = createAccountConsumeRateLimitResetCreditHandler(
			makeDbOps(makeAccount()),
			consume,
		);

		const missingKey = await codexHandler(request({}), "account-1");
		expect(missingKey.status).toBe(400);

		const anthropicHandler = createAccountConsumeRateLimitResetCreditHandler(
			makeDbOps(makeAccount({ provider: "anthropic" })),
			consume,
		);
		const wrongProvider = await anthropicHandler(
			request({ idempotencyKey: "redeem-123" }),
			"account-1",
		);
		expect(wrongProvider.status).toBe(400);
		expect(consume).not.toHaveBeenCalled();
	});

	it("surfaces ambiguous dispatch failures without claiming a reset outcome", async () => {
		const consume = mock(async () => ({
			status: "failed" as const,
			message: "upstream response was lost",
		}));
		const handler = createAccountConsumeRateLimitResetCreditHandler(
			makeDbOps(makeAccount()),
			consume,
		);

		const response = await handler(
			request({ idempotencyKey: "redeem-retry-me" }),
			"account-1",
		);

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: "upstream response was lost",
		});
	});
});
