import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	consumeCodexResetCreditForAccount,
	registerCodexResetCreditConsumer,
	unregisterCodexResetCreditConsumer,
} from "../token-manager";

const SERVER_A = "reset-consumer-test-a";
const SERVER_B = "reset-consumer-test-b";

afterEach(() => {
	unregisterCodexResetCreditConsumer(SERVER_A);
	unregisterCodexResetCreditConsumer(SERVER_B);
});

describe("consumeCodexResetCreditForAccount", () => {
	it("fails over sequentially with the same idempotency key", async () => {
		const seenKeys: string[] = [];
		registerCodexResetCreditConsumer(SERVER_A, async (_accountId, request) => {
			seenKeys.push(request.idempotencyKey);
			return { status: "failed", message: "response lost" };
		});
		registerCodexResetCreditConsumer(SERVER_B, async (_accountId, request) => {
			seenKeys.push(request.idempotencyKey);
			return {
				status: "completed",
				accountName: "Codex One",
				result: { outcome: "alreadyRedeemed", windowsReset: 0 },
				resetMetadataRefreshed: true,
				availableResetCount: 1,
				localRateLimitStateCleared: true,
			};
		});

		const outcome = await consumeCodexResetCreditForAccount(
			"account-failover",
			{
				idempotencyKey: "redeem-stable",
			},
		);

		expect(seenKeys).toEqual(["redeem-stable", "redeem-stable"]);
		expect(outcome.status).toBe("completed");
		if (outcome.status === "completed") {
			expect(outcome.result.outcome).toBe("alreadyRedeemed");
		}
	});

	it("collapses concurrent retries of the same logical attempt", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const consumer = mock(async () => {
			await gate;
			return {
				status: "completed" as const,
				accountName: "Codex One",
				result: { outcome: "reset" as const, windowsReset: 2 },
				resetMetadataRefreshed: true,
				availableResetCount: 1,
				localRateLimitStateCleared: true,
			};
		});
		registerCodexResetCreditConsumer(SERVER_A, consumer);

		const first = consumeCodexResetCreditForAccount("account-shared", {
			idempotencyKey: "redeem-shared",
		});
		const second = consumeCodexResetCreditForAccount("account-shared", {
			idempotencyKey: "redeem-shared",
		});
		expect(consumer).toHaveBeenCalledTimes(1);
		release?.();

		const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
		expect(firstOutcome).toEqual(secondOutcome);
		expect(consumer).toHaveBeenCalledTimes(1);
	});

	it("rejects a competing idempotency key instead of consuming a second credit", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const consumer = mock(async () => {
			await gate;
			return {
				status: "completed" as const,
				accountName: "Codex One",
				result: { outcome: "reset" as const, windowsReset: 2 },
				resetMetadataRefreshed: true,
				availableResetCount: 1,
				localRateLimitStateCleared: true,
			};
		});
		registerCodexResetCreditConsumer(SERVER_A, consumer);

		const first = consumeCodexResetCreditForAccount("account-exclusive", {
			idempotencyKey: "redeem-first",
		});
		const competing = await consumeCodexResetCreditForAccount(
			"account-exclusive",
			{ idempotencyKey: "redeem-second" },
		);

		expect(competing).toEqual({
			status: "failed",
			message:
				"Another banked-reset attempt is already in progress for this account; refresh its banked resets before retrying.",
			notSent: true,
		});
		expect(consumer).toHaveBeenCalledTimes(1);
		release?.();
		await first;
	});

	it("marks the outcome notSent when no server is registered", async () => {
		expect(
			await consumeCodexResetCreditForAccount("account-unserved", {
				idempotencyKey: "redeem-unserved",
			}),
		).toEqual({
			status: "failed",
			message: "No proxy server is registered to apply Codex banked resets.",
			notSent: true,
		});
	});

	it("leaves a failure reported by a server unmarked", async () => {
		registerCodexResetCreditConsumer(SERVER_A, async () => ({
			status: "failed",
			message: "response lost",
		}));
		const outcome = await consumeCodexResetCreditForAccount("account-lost", {
			idempotencyKey: "redeem-lost",
		});
		expect(outcome).toEqual({ status: "failed", message: "response lost" });
	});
});
