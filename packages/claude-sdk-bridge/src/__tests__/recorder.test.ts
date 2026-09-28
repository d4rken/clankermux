import { describe, expect, it } from "bun:test";
import { TurnRecorder } from "../recorder";
import { capturingLog, memoryTurnRepo } from "./fixtures/fake-sdk";

function recorder(turnId = "turn-1") {
	const repo = memoryTurnRepo();
	const log = capturingLog();
	return { repo, log, rec: new TurnRecorder(repo, log, turnId) };
}

describe("the turn's journal line", () => {
	it("carries what the recorder saw: identity, counters and the first model call", async () => {
		const { log, rec } = recorder();
		void rec.insertTurn({
			kind: "turn",
			startedAt: 1_000,
			historyMode: "resume",
			rebuildReason: "account_change",
			systemPromptPolicy: "pi-head-v1",
			model: "claude-sonnet-5",
			accountId: "acct-a",
			clientHarness: "pi",
			clientUserAgent: "pi (linux)",
			project: "proj",
		});
		void rec.insertLeg("leg-1", "start", 1_000);
		void rec.insertLeg("leg-2", "continue", 2_000);
		void rec.bump({ toolRounds: 1 });
		void rec.bump({ innerCalls: 1 });
		void rec.bump({ innerCalls: 1 });
		void rec.bump({ innerErrors: 1 });
		rec.noteModelCall({
			input_tokens: 3,
			cache_read_input_tokens: 90_000,
			cache_creation_input_tokens: 400,
			output_tokens: 1,
		});
		// Only the first call is the one reported.
		rec.noteModelCall({
			input_tokens: 5,
			cache_read_input_tokens: 1,
			cache_creation_input_tokens: 2,
		});
		await rec.finishTurn({
			finishedAt: 5_000,
			status: "completed",
			httpStatus: 200,
			errorType: null,
			errorMessage: null,
			stopReason: "end_turn",
			spawnMs: 300,
			firstEventMs: 900,
			durationMs: 4_000,
			sdkNumTurns: 2,
			sdkInputTokens: 8,
			sdkOutputTokens: 120,
			sdkCacheReadInputTokens: 180_000,
			sdkCacheCreationInputTokens: 700,
		});

		const lines = log.turns("turn-1");
		expect(lines).toHaveLength(1);
		expect(lines[0]?.level).toBe("info");
		expect(lines[0]?.message).toBe("SDK bridge turn turn-1 completed");
		expect(lines[0]?.data).toEqual({
			event: "sdk_bridge_turn",
			turnId: "turn-1",
			kind: "turn",
			status: "completed",
			httpStatus: 200,
			errorType: null,
			errorMessage: null,
			stopReason: "end_turn",
			model: "claude-sonnet-5",
			accountId: "acct-a",
			clientHarness: "pi",
			historyMode: "resume",
			rebuildReason: "account_change",
			systemPromptPolicy: "pi-head-v1",
			legs: 2,
			toolRounds: 1,
			innerCalls: 2,
			innerErrors: 1,
			spawnMs: 300,
			firstEventMs: 900,
			durationMs: 4_000,
			sdkNumTurns: 2,
			tokens: {
				input: 8,
				output: 120,
				cacheRead: 180_000,
				cacheCreation: 700,
			},
			firstCall: { input: 3, cacheRead: 90_000, cacheCreation: 400 },
		});
	});

	it("is written after the finish write, once, however often finish is called", async () => {
		const { repo, log, rec } = recorder();
		let rowAtLine: string | undefined;
		const warn = log.warn;
		log.warn = (message, data) => {
			rowAtLine = repo.turns.get("turn-1")?.status;
			warn(message, data);
		};
		void rec.insertTurn({
			startedAt: 1,
			historyMode: "fresh",
			systemPromptPolicy: "drop",
		});
		void rec.finishTurn({ finishedAt: 2, status: "failed", httpStatus: 502 });
		await rec.finishTurn({ finishedAt: 3, status: "completed" });
		expect(rowAtLine).toBe("failed");
		const lines = log.turns();
		expect(lines).toHaveLength(1);
		expect(lines[0]?.level).toBe("warn");
		expect(lines[0]?.data).toMatchObject({
			status: "failed",
			httpStatus: 502,
			kind: "turn",
			legs: 0,
		});
		// A turn whose Claude Code query never reported numbers has none to log.
		expect(lines[0]?.data).not.toHaveProperty("tokens");
		expect(lines[0]?.data).not.toHaveProperty("firstCall");
	});

	it("still logs the turn when its finish write fails", async () => {
		const { repo, log, rec } = recorder();
		repo.finishTurn = async () => {
			throw new Error("disk I/O error");
		};
		await rec.finishTurn({ finishedAt: 2, status: "timed_out" });
		expect(log.entries.map((e) => e.message)).toEqual([
			"SDK bridge turn turn-1: finishTurn failed",
			"SDK bridge turn turn-1 timed_out",
		]);
		expect(log.turns()[0]?.level).toBe("warn");
	});

	it("marks a turn it never saw inserted as resumed from a release, without identity or counters", async () => {
		const { log, rec } = recorder();
		void rec.insertLeg("leg-2", "continue", 2_000);
		void rec.bump({ toolRounds: 1, innerCalls: 1 });
		rec.noteModelCall({
			input_tokens: 2,
			cache_read_input_tokens: 50_000,
			cache_creation_input_tokens: 10,
		});
		await rec.finishTurn({
			finishedAt: 5_000,
			status: "aborted",
			httpStatus: 499,
			errorType: "client_gone",
			errorMessage: "the client disconnected",
			durationMs: 4_000,
		});
		const [line] = log.turns();
		expect(line?.level).toBe("info");
		expect(line?.data).toEqual({
			event: "sdk_bridge_turn",
			turnId: "turn-1",
			status: "aborted",
			httpStatus: 499,
			errorType: "client_gone",
			errorMessage: "the client disconnected",
			durationMs: 4_000,
			firstCall: { input: 2, cacheRead: 50_000, cacheCreation: 10 },
			resumedFromRelease: true,
		});
	});

	it("ignores a model call that reports no usage", async () => {
		const { log, rec } = recorder();
		rec.noteModelCall(undefined);
		rec.noteModelCall({ output_tokens: 4 });
		rec.noteModelCall({ input_tokens: 7, cache_read_input_tokens: 0 });
		await rec.finishTurn({ finishedAt: 1, status: "completed" });
		expect(log.turns()[0]?.data.firstCall).toEqual({
			input: 7,
			cacheRead: 0,
			cacheCreation: null,
		});
	});
});
