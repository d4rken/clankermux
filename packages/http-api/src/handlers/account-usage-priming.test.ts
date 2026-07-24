import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { registerPollingRestarter } from "@clankermux/proxy";
import { primeUsagePollingForNewAccount } from "./account-usage-priming";

// The polling-restarter registry has no unregister hook, so register a single
// restarter for the whole file that records calls into a resettable array and
// returns a controllable result. `restartUsagePollingForAccount` iterates every
// registered restarter; in a unit-test process this is the only one.
let restarterCalls: string[] = [];
let restarterResult = true;
let restarterThrows = false;

beforeAll(() => {
	registerPollingRestarter(
		"account-usage-priming-test",
		async (accountId: string) => {
			restarterCalls.push(accountId);
			if (restarterThrows) {
				throw new Error("simulated restarter failure");
			}
			return restarterResult;
		},
	);
});

beforeEach(() => {
	restarterCalls = [];
	restarterResult = true;
	restarterThrows = false;
});

describe("primeUsagePollingForNewAccount", () => {
	it("starts usage polling for a new Anthropic OAuth account", async () => {
		await primeUsagePollingForNewAccount({
			id: "acc-anthropic",
			provider: "anthropic",
			name: "New OAuth",
		});
		expect(restarterCalls).toEqual(["acc-anthropic"]);
	});

	it("does not start polling for Codex accounts (warmed separately)", async () => {
		await primeUsagePollingForNewAccount({
			id: "acc-codex",
			provider: "codex",
			name: "New Codex",
		});
		expect(restarterCalls).toEqual([]);
	});

	it("does not start polling for console API-key accounts", async () => {
		await primeUsagePollingForNewAccount({
			id: "acc-console",
			provider: "claude-console-api",
			name: "New Console",
		});
		expect(restarterCalls).toEqual([]);
	});

	it("does not start polling for Qwen accounts", async () => {
		await primeUsagePollingForNewAccount({
			id: "acc-qwen",
			provider: "qwen",
			name: "New Qwen",
		});
		expect(restarterCalls).toEqual([]);
	});

	it("resolves without throwing when polling could not be started", async () => {
		restarterResult = false;
		await primeUsagePollingForNewAccount({
			id: "acc-nostart",
			provider: "anthropic",
			name: "No Start",
		});
		expect(restarterCalls).toEqual(["acc-nostart"]);
	});

	it("never rejects so a priming failure cannot fail account creation", async () => {
		restarterThrows = true;
		// Must resolve, not reject — account creation must not depend on this.
		await primeUsagePollingForNewAccount({
			id: "acc-throw",
			provider: "anthropic",
			name: "Throwing",
		});
		expect(restarterCalls).toEqual(["acc-throw"]);
	});
});
