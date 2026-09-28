import { describe, expect, it } from "bun:test";
import { TurnRecorder } from "../recorder";
import { capturingLog, memoryTurnRepo } from "./fixtures/fake-sdk";

function recorder(turnId = "turn-1") {
	const repo = memoryTurnRepo();
	const log = capturingLog();
	return { repo, log, rec: new TurnRecorder(repo, log, turnId) };
}

/** An open row inserted elsewhere: this recorder never sees its insert. */
async function seedOpenTurn(
	repo: ReturnType<typeof memoryTurnRepo>,
	id = "turn-1",
) {
	await repo.insertTurn({
		id,
		startedAt: 1,
		historyMode: "fresh",
		systemPromptPolicy: "drop",
	});
}

const PARK_IDENTITY = {
	kind: "turn",
	model: "claude-opus-5-5",
	accountId: "acct-a",
	clientHarness: "pi",
	historyMode: "resume",
	rebuildReason: null,
	systemPromptPolicy: null,
} as const;

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
		rec.noteModelCall("msg_1", {
			input_tokens: 3,
			cache_read_input_tokens: 90_000,
			cache_creation_input_tokens: 400,
			output_tokens: 1,
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
			source: "live",
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

	it("logs a pre-query rejection with its one leg", async () => {
		const { log, rec } = recorder();
		void rec.insertTurn({
			startedAt: 1,
			status: "rejected",
			historyMode: "fresh",
			systemPromptPolicy: "pi-head-v1",
		});
		void rec.insertLeg("leg-1", "start", 1);
		void rec.finishLeg("leg-1", { finishedAt: 2, httpStatus: 400 });
		await rec.finishTurn({
			finishedAt: 2,
			status: "rejected",
			httpStatus: 400,
			errorType: "invalid_request_error",
		});
		expect(log.turns()[0]?.data).toMatchObject({
			source: "live",
			status: "rejected",
			httpStatus: 400,
			legs: 1,
			toolRounds: 0,
		});
	});

	it("is logged once, at warn for a failure, however often finish is called", async () => {
		const { log, rec } = recorder();
		void rec.insertTurn({
			startedAt: 1,
			historyMode: "fresh",
			systemPromptPolicy: "drop",
		});
		void rec.finishTurn({ finishedAt: 2, status: "failed", httpStatus: 502 });
		await rec.finishTurn({ finishedAt: 3, status: "completed" });
		const lines = log.turns();
		expect(lines).toHaveLength(1);
		expect(lines[0]?.level).toBe("warn");
		expect(lines[0]?.data).toMatchObject({
			status: "failed",
			httpStatus: 502,
			legs: 0,
		});
		// A turn whose Claude Code query never reported numbers has none to log.
		expect(lines[0]?.data).not.toHaveProperty("tokens");
		expect(lines[0]?.data).not.toHaveProperty("firstCall");
	});

	it("logs a distinct warning, and no turn line, when the finish write fails", async () => {
		const { repo, log, rec } = recorder();
		await seedOpenTurn(repo);
		repo.finishTurn = async () => {
			throw new Error("disk I/O error");
		};
		await rec.finishTurn({ finishedAt: 2, status: "timed_out" });
		expect(log.turns()).toEqual([]);
		expect(log.entries).toEqual([
			{
				level: "warn",
				message: "SDK bridge turn turn-1: finish write failed",
				data: {
					event: "sdk_bridge_turn_finish_failed",
					turnId: "turn-1",
					status: "timed_out",
					error: "disk I/O error",
				},
			},
		]);
	});

	it("logs no turn line when the finish applied nothing", async () => {
		const { repo, log, rec } = recorder();
		await seedOpenTurn(repo);
		// Finished first by another path (a park close): its facts stand.
		await repo.finishTurn("turn-1", { finishedAt: 0, status: "expired" });
		await rec.finishTurn({ finishedAt: 5, status: "failed" });
		expect(log.turns()).toEqual([]);
		expect(repo.turns.get("turn-1")?.status).toBe("expired");
		expect(log.entries.map((e) => e.level)).toEqual(["debug"]);

		// Fenced out: the lease is not this token's.
		const other = recorder("turn-2");
		await seedOpenTurn(other.repo, "turn-2");
		other.rec.setFence("token-not-held");
		await other.rec.finishTurn({ finishedAt: 5, status: "failed" });
		expect(other.log.turns()).toEqual([]);
		expect(other.repo.turns.get("turn-2")?.status).toBe("running");
	});

	it("counts the writes queued before the finish that landed, and none queued after", async () => {
		const { repo, log, rec } = recorder();
		void rec.insertTurn({
			startedAt: 1,
			historyMode: "fresh",
			systemPromptPolicy: "drop",
		});
		let letGo!: () => void;
		repo.legInsertHold.next = new Promise((resolve) => {
			letGo = resolve;
		});
		void rec.insertLeg("leg-1", "start", 1);
		rec.noteModelCall("msg_1", { input_tokens: 5 });
		const finished = rec.finishTurn({ finishedAt: 2, status: "completed" });
		void rec.bump({ toolRounds: 1 });
		// The same call reporting more after the finish does not reach the line.
		rec.noteModelCall("msg_1", { cache_read_input_tokens: 99 });
		letGo();
		await finished;
		await rec.flushed();
		expect(log.turns()[0]?.data).toMatchObject({
			legs: 1,
			toolRounds: 0,
			firstCall: { input: 5, cacheRead: null, cacheCreation: null },
		});
		expect(repo.turns.get("turn-1")?.counters.toolRounds).toBe(1);
	});

	it("reports a resumed park's adopted identity without counters", async () => {
		const { repo, log, rec } = recorder();
		await seedOpenTurn(repo);
		rec.adoptIdentity(PARK_IDENTITY);
		void rec.insertLeg("leg-2", "continue", 2_000);
		void rec.bump({ toolRounds: 1, innerCalls: 1 });
		rec.noteModelCall("msg_1", {
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
			source: "resumed_park",
			kind: "turn",
			status: "aborted",
			httpStatus: 499,
			errorType: "client_gone",
			errorMessage: "the client disconnected",
			model: "claude-opus-5-5",
			accountId: "acct-a",
			clientHarness: "pi",
			historyMode: "resume",
			rebuildReason: null,
			systemPromptPolicy: null,
			durationMs: 4_000,
			firstCall: { input: 2, cacheRead: 50_000, cacheCreation: 10 },
		});
	});

	it("still logs a resumed park whose identity could not be recovered", async () => {
		const { repo, log, rec } = recorder();
		await seedOpenTurn(repo);
		rec.adoptIdentity(null);
		await rec.finishTurn({ finishedAt: 5, status: "completed" });
		expect(log.turns()[0]?.data).toEqual({
			event: "sdk_bridge_turn",
			turnId: "turn-1",
			source: "resumed_park",
			status: "completed",
			httpStatus: null,
			errorType: null,
			errorMessage: null,
		});
	});
});

describe("the first model call", () => {
	async function firstCallOf(calls: (rec: TurnRecorder) => void) {
		const { repo, log, rec } = recorder();
		await seedOpenTurn(repo);
		calls(rec);
		await rec.finishTurn({ finishedAt: 1, status: "completed" });
		return log.turns()[0]?.data.firstCall;
	}

	it("is the first message_start, even one reporting no usage yet", async () => {
		expect(
			await firstCallOf((rec) => {
				rec.noteModelCall("msg_1", {});
				rec.noteModelCall("msg_2", {
					input_tokens: 9,
					cache_read_input_tokens: 9,
				});
			}),
		).toEqual({ input: null, cacheRead: null, cacheCreation: null });
	});

	it("is filled in from its message_delta and its envelope", async () => {
		expect(
			await firstCallOf((rec) => {
				rec.noteModelCall("msg_1", { input_tokens: 4, output_tokens: 1 });
				rec.noteModelCall("msg_1", {
					output_tokens: 30,
					cache_read_input_tokens: 700,
				});
				rec.noteModelCall("msg_1", {
					input_tokens: 4,
					cache_creation_input_tokens: 12,
				});
				rec.noteModelCall("msg_2", { cache_creation_input_tokens: 5_000 });
			}),
		).toEqual({ input: 4, cacheRead: 700, cacheCreation: 12 });
	});

	it("takes zero as a reading, and null or a missing value as none", async () => {
		expect(
			await firstCallOf((rec) => {
				rec.noteModelCall("msg_1", {
					input_tokens: 4,
					cache_read_input_tokens: 800,
					cache_creation_input_tokens: 3,
				});
				rec.noteModelCall("msg_1", {
					cache_read_input_tokens: null,
					cache_creation_input_tokens: 0,
				});
			}),
		).toEqual({ input: 4, cacheRead: 800, cacheCreation: 0 });
	});

	it("is a call fetched without streaming when no message_start came first", async () => {
		expect(
			await firstCallOf((rec) => {
				rec.noteModelCall("msg_plain", {
					input_tokens: 2,
					cache_read_input_tokens: 1_000,
					cache_creation_input_tokens: 0,
				});
				rec.noteModelCall("msg_next", { input_tokens: 99 });
			}),
		).toEqual({ input: 2, cacheRead: 1_000, cacheCreation: 0 });
	});
});
