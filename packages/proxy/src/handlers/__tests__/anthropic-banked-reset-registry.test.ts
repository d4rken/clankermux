import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	type AnthropicBankedResetClaimDispatchOutcome,
	claimAnthropicBankedResetForAccount,
	refreshAnthropicBankedResetsForAccount,
	registerAnthropicBankedResetClaimer,
	registerAnthropicBankedResetRefresher,
	unregisterAnthropicBankedResetClaimer,
	unregisterAnthropicBankedResetRefresher,
} from "../token-manager";

const SERVER_A = "banked-reset-registry-test-a";
const SERVER_B = "banked-reset-registry-test-b";

afterEach(() => {
	unregisterAnthropicBankedResetClaimer(SERVER_A);
	unregisterAnthropicBankedResetClaimer(SERVER_B);
	unregisterAnthropicBankedResetRefresher(SERVER_A);
	unregisterAnthropicBankedResetRefresher(SERVER_B);
});

function completed(): AnthropicBankedResetClaimDispatchOutcome {
	return {
		status: "completed",
		accountName: "Claude One",
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
	};
}

describe("claimAnthropicBankedResetForAccount", () => {
	it("fails when no server is registered", async () => {
		const outcome = await claimAnthropicBankedResetForAccount("acct", {
			grantId: "g1",
			requestId: "r1",
		});
		expect(outcome.status).toBe("failed");
	});

	it("fails over sequentially with the same request id", async () => {
		const seen: string[] = [];
		registerAnthropicBankedResetClaimer(SERVER_A, async (_id, request) => {
			seen.push(request.requestId);
			return { status: "failed", code: "error", message: "lost" };
		});
		registerAnthropicBankedResetClaimer(SERVER_B, async (_id, request) => {
			seen.push(request.requestId);
			return completed();
		});

		const outcome = await claimAnthropicBankedResetForAccount("acct-fo", {
			grantId: "g1",
			requestId: "stable",
		});
		expect(seen).toEqual(["stable", "stable"]);
		expect(outcome.status).toBe("completed");
	});

	it("collapses concurrent dispatches of the same request id and refuses a different one", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const claimer = mock(async () => {
			await gate;
			return completed();
		});
		registerAnthropicBankedResetClaimer(SERVER_A, claimer);

		const first = claimAnthropicBankedResetForAccount("acct-shared", {
			grantId: "g1",
			requestId: "same",
		});
		const second = claimAnthropicBankedResetForAccount("acct-shared", {
			grantId: "g1",
			requestId: "same",
		});
		const other = await claimAnthropicBankedResetForAccount("acct-shared", {
			grantId: "g1",
			requestId: "different",
		});
		expect(other.status).toBe("failed");
		if (other.status === "failed") expect(other.code).toBe("busy");
		release?.();
		const [a, b] = await Promise.all([first, second]);
		expect(a).toEqual(b);
		expect(claimer).toHaveBeenCalledTimes(1);
	});
});

describe("refreshAnthropicBankedResetsForAccount", () => {
	it("passes force through and shares one in-flight read per account and mode", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const refresher = mock(async (_id: string, _force: boolean) => {
			await gate;
			return { success: true, message: "ok" };
		});
		registerAnthropicBankedResetRefresher(SERVER_A, refresher);

		const a = refreshAnthropicBankedResetsForAccount("acct-r", true);
		const b = refreshAnthropicBankedResetsForAccount("acct-r", true);
		release?.();
		await Promise.all([a, b]);
		expect(refresher).toHaveBeenCalledTimes(1);
		expect(refresher.mock.calls[0]?.[1]).toBe(true);
	});

	it("reports failure when no server is registered", async () => {
		const outcome = await refreshAnthropicBankedResetsForAccount("acct-none");
		expect(outcome.success).toBe(false);
	});
});
