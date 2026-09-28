/**
 * Release-then-resume on the fake SDK: a parked query's process stops and
 * its session waits in the released-parks directory; the client's results
 * resume it at the parked calls, in this process or a later one.
 *
 * Each fake query gets a real child in its own process group (a sleep), so
 * SIGTERM and SIGKILL are real, and the fake mirrors transcript entries
 * into the session store the way the SDK does.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { SdkBridgeTurnMeta } from "@clankermux/types";
import {
	assistantMessage,
	capturingLog,
	type FakeQuery,
	foldReply,
	type Harness,
	initMessage,
	MODEL,
	makeHarness,
	makeMeta,
	makePlan,
	memoryParkRepo,
	memoryTurnRepo,
	messagesRequest,
	parseSse,
	READ_TOOL,
	resultMessage,
	streamedMessage,
	turnIdOf,
	waitFor,
} from "./fixtures/fake-sdk";

type Block = { type: string; [key: string]: unknown };
type Msg = { role: string; content: unknown };

interface ReleaseHarness extends Harness {
	parkRepo: ReturnType<typeof memoryParkRepo>;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "sdk-bridge-release-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

async function releaseHarness(
	opts: {
		limits?: Record<string, number>;
		timing?: Record<string, number>;
		process?: "normal" | "ignore-term";
		workRoot?: string;
		repo?: ReturnType<typeof memoryTurnRepo>;
		parkRepo?: ReturnType<typeof memoryParkRepo>;
		keep?: boolean;
		log?: ReturnType<typeof capturingLog>;
	} = {},
): Promise<ReleaseHarness> {
	const repo = opts.repo ?? memoryTurnRepo();
	const parkRepo = opts.parkRepo ?? memoryParkRepo(repo.turns);
	const h = makeHarness(
		{
			parkRepo,
			parkNamespace: parkRepo.namespace,
			...(opts.log ? { log: opts.log } : {}),
			limits: () => ({
				parkReleaseMs: 60,
				releasedParkTtlMs: 60_000,
				parkedTimeoutMs: 60_000,
				...opts.limits,
			}),
			timing: {
				headHoldMs: 1_000,
				pingIntervalMs: 100,
				settleWaitMs: 500,
				idleTimeoutMs: 5_000,
				exitGraceMs: 50,
				maintenanceIntervalMs: 60_000,
				releaseDrainMs: 8_000,
				...opts.timing,
			},
		},
		{
			process: opts.process ?? "normal",
			repo,
			workRoot: opts.workRoot ?? tempRoot(),
		},
	);
	if (!opts.keep) cleanups.push(() => h.bridge.dispose());
	await h.bridge.ready();
	return { ...h, parkRepo };
}

const first: Msg = { role: "user", content: "TOOL read" };

function alive(pid: number | null): boolean {
	if (pid === null) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function reply(response: Promise<Response>) {
	const res = await response;
	const text = await res.text();
	const events = res.headers.get("content-type")?.includes("event-stream")
		? parseSse(text)
		: [];
	return {
		status: res.status,
		body: events.length ? null : (JSON.parse(text || "null") as unknown),
		...foldReply(events),
	};
}

interface Parked {
	turnId: string;
	meta: SdkBridgeTurnMeta;
	query: FakeQuery;
	content: Block[];
	ids: string[];
	/** The MCP call Claude Code made for the first id; settles on cleanup only. */
	call: Promise<unknown>;
	answeredWhileAlive: () => boolean | null;
}

/**
 * A turn parked on `ids`: the streamed message ends the leg, and Claude
 * Code's envelopes (one per block) arrive after `message_stop`, as they do.
 */
async function parkTurn(
	h: Harness,
	opts: {
		ids?: string[];
		meta?: Partial<SdkBridgeTurnMeta>;
		/** false: none; "first": only the envelopes up to the first call. */
		envelopes?: boolean | "first";
	} = {},
): Promise<Parked> {
	const ids = opts.ids ?? [`toolu_${crypto.randomUUID().slice(0, 8)}`];
	const plan = makePlan();
	const meta = makeMeta(opts.meta);
	const response = h.bridge.startTurn({
		request: messagesRequest({ tools: [READ_TOOL], messages: [first] }),
		plan,
		meta,
		signal: new AbortController().signal,
	});
	const query = await h.sdk.next();
	const msgId = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
	const blocks: Block[] = [
		{ type: "thinking", text: "hm" },
		...ids.map((id) => ({
			type: "tool_use",
			id,
			name: "mcp__c__read",
			input: { path: id },
		})),
	];
	query.emit(initMessage(), ...streamedMessage(blocks as never, { id: msgId }));
	const r = await reply(response);
	expect(r.stop).toBe("tool_use");
	if (opts.envelopes !== false)
		for (const block of opts.envelopes === "first"
			? blocks.slice(0, 2)
			: blocks)
			query.emit(
				assistantMessage(
					[
						block.type === "thinking"
							? { type: "thinking", thinking: "hm", signature: "sig" }
							: block,
					],
					{ id: msgId, stopReason: "tool_use" },
				),
			);
	let answeredAlive: boolean | null = null;
	// Claude Code runs MCP calls one at a time: only the first one parks.
	const call = query.callTool(ids[0] as string, "read").then((result) => {
		answeredAlive = alive(query.pid);
		return result;
	});
	// This turn parked (others may be parked too).
	await waitFor(
		() =>
			turnIdOf(
				h.bridge.findContinuation(ids, {
					apiKeyId: meta.apiKeyId,
					model: MODEL,
				}),
			) === plan.turnId,
	);
	return {
		turnId: plan.turnId,
		meta,
		query,
		content: r.content,
		ids,
		call,
		answeredWhileAlive: () => answeredAlive,
	};
}

function results(p: Parked, ids: string[] = p.ids, extra: Block[] = []): Msg[] {
	return [
		first,
		{ role: "assistant", content: p.content },
		{
			role: "user",
			content: [
				...ids.map((id) => ({
					type: "tool_result",
					tool_use_id: id,
					content: `R-${id}`,
				})),
				...extra,
			],
		},
	];
}

function answer(
	h: Harness,
	p: Parked,
	messages: Msg[],
	meta: Partial<SdkBridgeTurnMeta> = {},
) {
	return h.bridge.continueTurn({
		turnId: p.turnId,
		request: messagesRequest({ tools: [READ_TOOL], messages }),
		meta: makeMeta(meta),
		signal: new AbortController().signal,
	});
}

async function released(h: ReleaseHarness, p: Parked) {
	await waitFor(() => h.repo.turns.get(p.turnId)?.status === "released", 8_000);
}

function parkDir(h: ReleaseHarness): string {
	return join(h.workRoot, "released-parks", h.parkRepo.namespace);
}

function parkFiles(h: ReleaseHarness): string[] {
	if (!existsSync(parkDir(h))) return [];
	return readdirSync(parkDir(h)).filter((n) => n.endsWith(".jsonl"));
}

/** Claude Code making a model call through the bridge's inner listener. */
function innerCall(query: FakeQuery): Promise<Response> {
	const env = query.options.env ?? {};
	return fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages?beta=true`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${env.ANTHROPIC_AUTH_TOKEN}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ model: MODEL, messages: [], stream: true }),
	});
}

/** A resumed query answering and finishing the turn. */
async function finishResumed(
	h: Harness,
	query: FakeQuery,
	response: Promise<Response>,
) {
	await innerCall(query);
	query.emit(
		initMessage(),
		...streamedMessage([{ type: "text", text: "done" }]),
		resultMessage(),
	);
	const r = await reply(response);
	await waitFor(() => h.bridge.status().live === 0);
	return r;
}

describe("releasing a parked query", () => {
	it("stops the process without answering the call, stores the session and keeps the turn open", async () => {
		const h = await releaseHarness();
		const p = await parkTurn(h);
		const pid = p.query.pid;
		expect(alive(pid)).toBe(true);
		const token = p.query.options.env?.ANTHROPIC_AUTH_TOKEN;
		await released(h, p);

		expect(alive(pid)).toBe(false);
		// Nothing was interrupted, and the parked call was answered only once
		// the process was gone: no synthetic result reached the transcript.
		expect(p.query.interrupted).toBe(false);
		await p.call;
		expect(p.answeredWhileAlive()).toBe(false);
		// The token went with it.
		const late = await fetch(
			`${p.query.options.env?.ANTHROPIC_BASE_URL}/v1/messages`,
			{
				method: "POST",
				headers: { authorization: `Bearer ${token}` },
				body: "{}",
			},
		);
		expect(late.status).toBe(401);

		const park = h.parkRepo.parks.get(p.turnId);
		expect(park).toMatchObject({
			state: "released",
			ownerApiKeyId: "key-1",
			awaitedToolUseIds: p.ids,
			requestedModel: MODEL,
		});
		const descriptor = JSON.parse(String(park?.descriptor));
		expect(descriptor).toMatchObject({
			v: 1,
			tools: [READ_TOOL],
			systemPrompt: { append: null, excludeDynamicSections: false },
			plan: { turnId: p.turnId, preferredAccountId: "acct-a" },
			clientHarness: "opencode",
			project: "proj",
		});
		// The file is in the released-parks directory, the generation's copy gone.
		expect(parkFiles(h)).toEqual([basename(String(park?.sessionPath))]);
		expect(readFileSync(String(park?.sessionPath), "utf8")).toContain(
			`"uuid":"${park?.resumeAt}"`,
		);
		expect(h.repo.turns.get(p.turnId)?.status).toBe("released");
		expect(h.repo.turns.get(p.turnId)?.finishedAt).toBeUndefined();
		expect(h.bridge.status()).toMatchObject({
			live: 0,
			parked: 0,
			releasedParks: 1,
			releaseBlocked: null,
		});
		expect(h.bridge.status().counters.released).toBe(1);
		expect(
			h.bridge.findContinuation(p.ids, { apiKeyId: "key-1", model: MODEL }),
		).toEqual({
			turnId: p.turnId,
			ownerApiKeyId: "key-1",
		});
	});

	it("resumes at the envelope that made the calls, even when it arrived after message_stop", async () => {
		const h = await releaseHarness();
		const p = await parkTurn(h, { ids: ["toolu_a", "toolu_b"] });
		await released(h, p);
		const park = h.parkRepo.parks.get(p.turnId);
		const file = readFileSync(String(park?.sessionPath), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		// The last envelope of the message, the one carrying toolu_b.
		const at = file.find((e) => e.uuid === park?.resumeAt);
		expect(at.message.content[0].id).toBe("toolu_b");
	});

	it("does not release a query with no envelope for its calls; the parked timeout ends it", async () => {
		const h = await releaseHarness({ limits: { parkedTimeoutMs: 300 } });
		const p = await parkTurn(h, { envelopes: false });
		await waitFor(
			() => h.repo.turns.get(p.turnId)?.status === "timed_out",
			3_000,
		);
		expect(h.parkRepo.parks.size).toBe(0);
		expect(h.bridge.status().counters.releasesRefused).toBe(1);
	});

	it("escalates to SIGKILL when the process ignores SIGTERM", async () => {
		const h = await releaseHarness({ process: "ignore-term" });
		const p = await parkTurn(h);
		const t0 = Date.now();
		await released(h, p);
		expect(Date.now() - t0).toBeGreaterThanOrEqual(1_900);
		expect(alive(p.query.pid)).toBe(false);
	});
});

describe("resuming a released park", () => {
	it("resumes the stored session at the calls, with the results and the text as one prompt", async () => {
		const h = await releaseHarness();
		const p = await parkTurn(h, { ids: ["toolu_a", "toolu_b"] });
		await released(h, p);
		const park = h.parkRepo.parks.get(p.turnId);
		let stateAtFirstCall: string | undefined;
		h.inner.respond = () => {
			stateAtFirstCall = h.parkRepo.parks.get(p.turnId)?.state;
			return new Response("ok");
		};

		const response = answer(
			h,
			p,
			results(p, ["toolu_a", "toolu_b"], [{ type: "text", text: "and also" }]),
		);
		const q2 = await h.sdk.next();
		expect(q2.options.resume).toBeString();
		expect(q2.options.resume).not.toBe(park?.sessionId);
		expect(q2.options.resumeSessionAt).toBe(park?.resumeAt);
		// The resume runs with the turn's own tools, from its descriptor.
		expect(q2.options.allowedTools).toEqual(["mcp__c__read"]);
		await waitFor(() => q2.prompts.length === 1);
		expect(q2.prompts[0]?.message.content).toEqual([
			{ type: "tool_result", tool_use_id: "toolu_a", content: "R-toolu_a" },
			{ type: "tool_result", tool_use_id: "toolu_b", content: "R-toolu_b" },
			{ type: "text", text: "and also" },
		]);
		expect(h.parkRepo.parks.get(p.turnId)?.state).toBe("claimed");
		expect(h.repo.turns.get(p.turnId)?.status).toBe("running");

		const r = await finishResumed(h, q2, response);
		expect(stateAtFirstCall).toBe("consumed");
		expect(r.content).toEqual([{ type: "text", text: "done" }]);
		const turn = h.repo.turns.get(p.turnId);
		expect(turn?.status).toBe("completed");
		expect(turn?.legs.map((l) => [l.kind, l.httpStatus])).toEqual([
			["start", 200],
			["continue", 200],
		]);
		expect(turn?.counters.toolRounds).toBe(1);
		await waitFor(() => !h.parkRepo.parks.has(p.turnId));
		expect(parkFiles(h)).toEqual([]);
		expect(h.bridge.status().counters.releasedResumes).toBe(1);
		// Replaying the answered results is stale now.
		expect(
			h.bridge.findContinuation(["toolu_a"], {
				apiKeyId: "key-1",
				model: MODEL,
			}),
		).toBeNull();
	});

	it("logs the resumed turn once, as resumed from a release, with its first call's cache use", async () => {
		const log = capturingLog();
		const h = await releaseHarness({ log });
		const p = await parkTurn(h);
		await released(h, p);
		const response = answer(h, p, results(p));
		const q2 = await h.sdk.next();
		await innerCall(q2);
		q2.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "done" }], {
				usage: {
					input_tokens: 2,
					cache_read_input_tokens: 30_000,
					cache_creation_input_tokens: 120,
					output_tokens: 1,
				},
			}),
			resultMessage(),
		);
		expect((await reply(response)).status).toBe(200);
		await waitFor(() => log.turns(p.turnId).length === 1);
		await Bun.sleep(20);
		// Parking and releasing did not finish the turn; only the resume did.
		const lines = log.turns(p.turnId);
		expect(lines).toHaveLength(1);
		expect(lines[0]?.level).toBe("info");
		expect(lines[0]?.data).toMatchObject({
			status: "completed",
			httpStatus: 200,
			resumedFromRelease: true,
			firstCall: { input: 2, cacheRead: 30_000, cacheCreation: 120 },
		});
		expect(lines[0]?.data).not.toHaveProperty("historyMode");
		expect(lines[0]?.data).not.toHaveProperty("legs");
	});

	it("holds results that arrive during the release until it is stored, then resumes", async () => {
		const h = await releaseHarness({ process: "ignore-term" });
		const p = await parkTurn(h);
		await waitFor(() => h.bridge.status().parked === 0, 2_000);
		// Mid release: the query is still found, and the results wait for it.
		expect(
			turnIdOf(
				h.bridge.findContinuation(p.ids, { apiKeyId: "key-1", model: MODEL }),
			),
		).toBe(p.turnId);
		const response = answer(h, p, results(p));
		const q2 = await h.sdk.next();
		await waitFor(() => h.repo.turns.get(p.turnId)?.legs.length === 2);
		expect(q2.options.resumeSessionAt).toBe(
			h.parkRepo.parks.get(p.turnId)?.resumeAt,
		);
		expect((await finishResumed(h, q2, response)).status).toBe(200);
	});

	it("gives a second claimant 409 stale while the first resumes", async () => {
		const h = await releaseHarness();
		const p = await parkTurn(h);
		await released(h, p);
		const one = answer(h, p, results(p));
		const two = answer(h, p, results(p));
		const q2 = await h.sdk.next();
		const second = await reply(two);
		expect(second.status).toBe(409);
		expect(JSON.stringify(second.body)).toContain("stale tool results");
		expect((await finishResumed(h, q2, one)).status).toBe(200);
		expect(h.sdk.queries.length).toBe(2);
	});

	it("refuses results that are partial, repeated or name another call with 409, and keeps the park", async () => {
		const h = await releaseHarness();
		const p = await parkTurn(h, { ids: ["toolu_a", "toolu_b"] });
		await released(h, p);
		for (const ids of [
			["toolu_a"],
			["toolu_a", "toolu_b", "toolu_b"],
			["toolu_a", "toolu_b", "toolu_c"],
		]) {
			const r = await reply(answer(h, p, results(p, ids)));
			expect(r.status).toBe(409);
		}
		expect(h.parkRepo.parks.get(p.turnId)?.state).toBe("released");
		expect(h.sdk.queries.length).toBe(1);
	});

	it("refuses another key's results and leaves the park", async () => {
		const h = await releaseHarness();
		const p = await parkTurn(h);
		await released(h, p);
		const r = await reply(answer(h, p, results(p), { apiKeyId: "key-2" }));
		expect(r.status).toBe(409);
		expect(JSON.stringify(r.body)).toContain("another API key");
		expect(h.parkRepo.parks.get(p.turnId)?.state).toBe("released");
	});

	it("ends the park when the caller's own results name another model, so they start a fresh turn", async () => {
		const h = await releaseHarness();
		const p = await parkTurn(h);
		await released(h, p);
		expect(
			h.bridge.findContinuation(p.ids, {
				apiKeyId: "key-1",
				model: "claude-opus-5-5",
			}),
		).toBeNull();
		await waitFor(() => h.repo.turns.get(p.turnId)?.status === "aborted");
		expect(h.parkRepo.parks.size).toBe(0);
		expect(parkFiles(h)).toEqual([]);
	});

	it("falls back to a flattened dead continuation when the stored session is gone", async () => {
		const h = await releaseHarness();
		const p = await parkTurn(h);
		await released(h, p);
		for (const name of parkFiles(h)) rmSync(join(parkDir(h), name));
		const response = answer(h, p, results(p));
		const q2 = await h.sdk.next();
		expect(q2.options.resume).toBeUndefined();
		await waitFor(() => q2.prompts.length === 1);
		expect(JSON.stringify(q2.prompts[0]?.message.content)).toContain(
			"earlier_conversation",
		);
		q2.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "rebuilt" }]),
			resultMessage(),
		);
		expect((await reply(response)).content).toEqual([
			{ type: "text", text: "rebuilt" },
		]);
		expect(h.repo.turns.get(p.turnId)?.status).toBe("failed");
		const fresh = [...h.repo.turns.values()].find((t) => t.id !== p.turnId);
		expect(fresh).toMatchObject({
			historyMode: "rebuild_flattened",
			rebuildReason: "dead_continuation",
		});
	});

	it("releases a resumed turn that parks again, replacing its spent park", async () => {
		const h = await releaseHarness();
		const p = await parkTurn(h);
		await released(h, p);
		const response = answer(h, p, results(p));
		const q2 = await h.sdk.next();
		await innerCall(q2);
		const msgId = "msg_again";
		const block = {
			type: "tool_use",
			id: "toolu_again",
			name: "mcp__c__read",
			input: {},
		};
		q2.emit(initMessage(), ...streamedMessage([block as never], { id: msgId }));
		expect((await reply(response)).stop).toBe("tool_use");
		q2.emit(assistantMessage([block], { id: msgId, stopReason: "tool_use" }));
		void q2.callTool("toolu_again", "read");
		await waitFor(
			() =>
				h.parkRepo.parks.get(p.turnId)?.awaitedToolUseIds[0] ===
					"toolu_again" && h.parkRepo.parks.get(p.turnId)?.state === "released",
			8_000,
		);
		expect(parkFiles(h).length).toBe(1);
		expect(h.repo.turns.get(p.turnId)?.status).toBe("released");
	});
});

describe("released parks and their conversation", () => {
	it("a new turn of the conversation supersedes its released park", async () => {
		const h = await releaseHarness();
		const header = {
			affinityScope: "client_session",
			affinityKey: "conv-sup",
		} as const;
		const p = await parkTurn(h, { meta: header });
		await released(h, p);
		const next = h.bridge.startTurn({
			request: messagesRequest({
				tools: [READ_TOOL],
				messages: [first, { role: "assistant", content: "never mind" }, first],
			}),
			plan: makePlan(),
			meta: makeMeta(header),
			signal: new AbortController().signal,
		});
		const q2 = await h.sdk.next();
		await waitFor(() => h.repo.turns.get(p.turnId)?.status === "aborted");
		expect(String(h.repo.turns.get(p.turnId)?.errorMessage)).toContain(
			"A new turn of this conversation",
		);
		expect(h.parkRepo.parks.size).toBe(0);
		expect(parkFiles(h)).toEqual([]);
		const late = await reply(answer(h, p, results(p)));
		expect(late.status).toBe(409);
		q2.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "ok" }]),
			resultMessage(),
		);
		expect((await reply(next)).status).toBe(200);
	});
});

describe("expiry", () => {
	it("ends a released park whose results never came, turn expired and file gone", async () => {
		const log = capturingLog();
		const h = await releaseHarness({
			limits: { releasedParkTtlMs: 200 },
			timing: { maintenanceIntervalMs: 50 },
			log,
		});
		const p = await parkTurn(h);
		await released(h, p);
		await waitFor(() => h.repo.turns.get(p.turnId)?.finishedAt != null, 3_000);
		await waitFor(() => log.turns(p.turnId).length === 1);
		expect(log.turns(p.turnId)[0]).toMatchObject({
			level: "warn",
			message: `SDK bridge turn ${p.turnId} expired`,
			data: {
				event: "sdk_bridge_turn",
				turnId: p.turnId,
				status: "expired",
				httpStatus: 504,
				errorType: "timeout_error",
				resumedFromRelease: true,
			},
		});
		expect(log.turns(p.turnId)[0]?.data.durationMs).toBeNumber();
		expect(h.repo.turns.get(p.turnId)).toMatchObject({
			status: "expired",
			httpStatus: 504,
			errorType: "timeout_error",
		});
		expect(h.parkRepo.parks.size).toBe(0);
		expect(parkFiles(h)).toEqual([]);
		expect(h.bridge.status().counters.releasedExpired).toBe(1);
		expect(
			h.bridge.findContinuation(p.ids, { apiKeyId: "key-1", model: MODEL }),
		).toBeNull();
	});
});

describe("expiry found at recovery", () => {
	it("ends a park that expired while no process held it as expired", async () => {
		const workRoot = tempRoot();
		const repo = memoryTurnRepo();
		const parkRepo = memoryParkRepo(repo.turns);
		const a = await releaseHarness({ workRoot, repo, parkRepo, keep: true });
		const p = await parkTurn(a);
		await released(a, p);
		await a.bridge.dispose();
		Object.assign(parkRepo.parks.get(p.turnId) ?? {}, { expiresAt: 1 });

		const log = capturingLog();
		const b = await releaseHarness({ workRoot, repo, parkRepo, log });

		expect(b.bridge.status().releasedParks).toBe(0);
		expect(log.turns(p.turnId)).toEqual([
			expect.objectContaining({
				level: "warn",
				data: expect.objectContaining({
					status: "expired",
					httpStatus: 504,
					resumedFromRelease: true,
				}),
			}),
		]);
		expect(repo.turns.get(p.turnId)).toMatchObject({
			status: "expired",
			httpStatus: 504,
			errorType: "timeout_error",
		});
	});
});

describe("the active-time budget", () => {
	it("does not count parked time, and moves the inner deadline on resume", async () => {
		const h = await releaseHarness({
			limits: { turnDeadlineMs: 400, parkReleaseMs: 60_000 },
		});
		const p = await parkTurn(h);
		// Parked for longer than the whole budget.
		await Bun.sleep(700);
		expect(h.repo.turns.get(p.turnId)?.status).toBe("running");
		let deadlineAt = 0;
		h.inner.respond = (_req, ctx) => {
			deadlineAt = ctx.deadlineAt;
			return new Response("ok");
		};
		const response = answer(h, p, results(p));
		const t0 = Date.now();
		await innerCall(p.query);
		const t1 = Date.now();
		// The budget left is at most what the turn had, counted from its resume.
		expect(deadlineAt).toBeGreaterThan(t0);
		expect(deadlineAt).toBeLessThanOrEqual(t1 + 400);
		p.query.emit(
			...streamedMessage([{ type: "text", text: "done" }]),
			resultMessage(),
		);
		expect((await reply(response)).status).toBe(200);
	});

	it("carries the budget across a release: a resume gets only what is left", async () => {
		const h = await releaseHarness({ limits: { turnDeadlineMs: 300 } });
		const p = await parkTurn(h);
		await released(h, p);
		const active = Number(h.parkRepo.parks.get(p.turnId)?.activeMs);
		expect(active).toBeGreaterThanOrEqual(0);
		expect(active).toBeLessThan(300);
		const response = answer(h, p, results(p));
		await h.sdk.next();
		// Nothing more happens: the rest of the budget runs out.
		const r = await reply(response);
		expect(r.status).toBe(504);
		await waitFor(() => h.repo.turns.get(p.turnId)?.status === "timed_out");
	});
});

describe("the session byte ceiling", () => {
	it("stops releasing when active sessions alone exceed it; the parked timeout applies", async () => {
		const h = await releaseHarness({
			limits: {
				sessionBytesCeiling: 1,
				parkReleaseMs: 150,
				parkedTimeoutMs: 600,
			},
			timing: { maintenanceIntervalMs: 40 },
		});
		const p = await parkTurn(h);
		await waitFor(() => h.bridge.status().releaseBlocked !== null);
		expect(h.bridge.status().releaseBlocked).toContain("ceiling");
		await waitFor(
			() => h.repo.turns.get(p.turnId)?.status === "timed_out",
			3_000,
		);
		expect(h.parkRepo.parks.size).toBe(0);
		expect(h.bridge.status().counters.releasesRefused).toBe(1);
		// New turns are never refused for it.
		const t = h.bridge.startTurn({
			request: messagesRequest({ messages: [{ role: "user", content: "hi" }] }),
			plan: makePlan(),
			meta: makeMeta(),
			signal: new AbortController().signal,
		});
		const q = await h.sdk.next();
		q.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "hi" }]),
			resultMessage(),
		);
		expect((await reply(t)).status).toBe(200);
	});

	it("evicts idle conversations, least recently used first, before refusing", async () => {
		const limits = { sessionBytesCeiling: 1024 * 1024 * 1024 };
		const h = await releaseHarness({
			limits,
			timing: { maintenanceIntervalMs: 40 },
		});
		const header = (key: string) =>
			({ affinityScope: "client_session", affinityKey: key }) as const;
		const sessionIds: string[] = [];
		for (const key of ["old", "new"]) {
			const t = h.bridge.startTurn({
				request: messagesRequest({
					messages: [{ role: "user", content: `hello ${key}` }],
				}),
				plan: makePlan(),
				meta: makeMeta(header(key)),
				signal: new AbortController().signal,
			});
			const q = await h.sdk.next();
			sessionIds.push(q.sessionId);
			const text = { type: "text", text: "x".repeat(4_000) };
			q.emit(
				initMessage(),
				...streamedMessage([text as never], { id: `msg_${key}` }),
				assistantMessage([text], { id: `msg_${key}`, stopReason: "end_turn" }),
				resultMessage(),
			);
			await reply(t);
			await waitFor(() => h.bridge.status().live === 0);
			await Bun.sleep(30);
		}
		const gen = readdirSync(h.workRoot).find((n) => n.startsWith("gen-"));
		const file = (id: string) =>
			join(h.workRoot, String(gen), "sessions", `${id}.jsonl`);
		const [oldId, newId] = sessionIds as [string, string];
		expect(existsSync(file(oldId))).toBe(true);
		// Room for one of the two.
		limits.sessionBytesCeiling = readFileSync(file(newId)).length + 100;
		await waitFor(() => !existsSync(file(oldId)), 2_000);
		expect(existsSync(file(newId))).toBe(true);
		expect(h.bridge.status().releaseBlocked).toBeNull();
	});
});

describe("shutdown", () => {
	it("releases parked turns at shutdown, and ones that park during the drain; dispose waits for them", async () => {
		const h = await releaseHarness({
			limits: { parkReleaseMs: 60_000 },
			keep: true,
		});
		const p = await parkTurn(h);
		const running = h.bridge.startTurn({
			request: messagesRequest({ tools: [READ_TOOL], messages: [first] }),
			plan: makePlan(),
			meta: makeMeta(),
			signal: new AbortController().signal,
		});
		const q = await h.sdk.next();
		q.emit(initMessage());
		h.bridge.beginShutdown();
		// It parks during the drain: its call reaches the client.
		const block = {
			type: "tool_use",
			id: "toolu_drain",
			name: "mcp__c__read",
			input: {},
		};
		q.emit(...streamedMessage([block as never], { id: "msg_drain" }));
		q.emit(
			assistantMessage([block], { id: "msg_drain", stopReason: "tool_use" }),
		);
		const r = await reply(running);
		expect(r.stop).toBe("tool_use");
		await h.bridge.dispose();
		expect(h.parkRepo.parks.size).toBe(2);
		expect([...h.parkRepo.parks.values()].map((park) => park.state)).toEqual([
			"released",
			"released",
		]);
		expect(parkFiles(h).length).toBe(2);
		expect(h.repo.turns.get(p.turnId)?.status).toBe("released");
		rmSync(h.workRoot, { recursive: true, force: true });
	});
});

describe("across a restart", () => {
	it("a new bridge on the same work root and database resumes the park", async () => {
		const workRoot = tempRoot();
		const repo = memoryTurnRepo();
		const parkRepo = memoryParkRepo(repo.turns);
		const a = await releaseHarness({ workRoot, repo, parkRepo, keep: true });
		const p = await parkTurn(a);
		await released(a, p);
		await a.bridge.dispose();

		const b = await releaseHarness({ workRoot, repo, parkRepo });
		expect(b.bridge.status().releasedParks).toBe(1);
		const found = b.bridge.findContinuation(p.ids, {
			apiKeyId: "key-1",
			model: MODEL,
		});
		expect(turnIdOf(found)).toBe(p.turnId);
		const response = answer(b, p, results(p));
		const q2 = await b.sdk.next();
		expect(q2.options.resumeSessionAt).toBe(
			parkRepo.parks.get(p.turnId)?.resumeAt,
		);
		expect((await finishResumed(b, q2, response)).status).toBe(200);
		expect(repo.turns.get(p.turnId)?.status).toBe("completed");
	});

	it("recovers every record state and leaves only resumable parks", async () => {
		const workRoot = tempRoot();
		const repo = memoryTurnRepo();
		const parkRepo = memoryParkRepo(repo.turns);
		const a = await releaseHarness({ workRoot, repo, parkRepo, keep: true });
		const kept = await parkTurn(a);
		await released(a, kept);
		const staleClaim = await parkTurn(a);
		await released(a, staleClaim);
		const missing = await parkTurn(a);
		await released(a, missing);
		await a.bridge.dispose();

		const dir = join(workRoot, "released-parks", parkRepo.namespace);
		const base = parkRepo.parks.get(kept.turnId);
		// A claim a dead process held, with no model call after it.
		Object.assign(parkRepo.parks.get(staleClaim.turnId) ?? {}, {
			state: "claimed",
			claimOwner: "dead-owner",
			claimedAt: 1,
		});
		// A record whose file is gone.
		rmSync(String(parkRepo.parks.get(missing.turnId)?.sessionPath));
		// A release and a resume the old process never finished.
		for (const [id, state] of [
			["preparing-turn", "preparing"],
			["consumed-turn", "consumed"],
		] as const) {
			const sid = crypto.randomUUID();
			writeFileSync(join(dir, `${sid}.jsonl`), "{}\n");
			await repo.insertTurn({
				id,
				startedAt: 1,
				historyMode: "fresh",
				systemPromptPolicy: "drop",
			});
			parkRepo.parks.set(id, {
				...(base as NonNullable<typeof base>),
				turnId: id,
				sessionId: sid,
				sessionPath: join(dir, `${sid}.jsonl`),
				state,
			});
		}
		// A file no record names, a temp file, and a turn left running.
		writeFileSync(join(dir, `${crypto.randomUUID()}.jsonl`), "{}\n");
		writeFileSync(join(dir, ".tmp-deadbeef"), "partial");
		await repo.insertTurn({
			id: "orphan-turn",
			startedAt: 1,
			historyMode: "fresh",
			systemPromptPolicy: "drop",
		});

		const b = await releaseHarness({ workRoot, repo, parkRepo });
		expect(b.bridge.status().releasedParks).toBe(2);
		expect([...parkRepo.parks.keys()].sort()).toEqual(
			[kept.turnId, staleClaim.turnId].sort(),
		);
		expect(parkRepo.parks.get(staleClaim.turnId)?.state).toBe("released");
		expect(repo.turns.get(missing.turnId)?.status).toBe("failed");
		expect(repo.turns.get("preparing-turn")?.status).toBe("failed");
		expect(repo.turns.get("consumed-turn")?.status).toBe("failed");
		expect(repo.turns.get("orphan-turn")?.status).toBe("failed");
		expect(readdirSync(dir).sort()).toEqual(
			[
				basename(String(parkRepo.parks.get(kept.turnId)?.sessionPath)),
				basename(String(parkRepo.parks.get(staleClaim.turnId)?.sessionPath)),
			].sort(),
		);
	});

	it("a second bridge on a work root and database another live one owns releases nothing", async () => {
		const workRoot = tempRoot();
		const repo = memoryTurnRepo();
		const parkRepo = memoryParkRepo(repo.turns);
		const a = await releaseHarness({ workRoot, repo, parkRepo });
		const b = await releaseHarness({
			workRoot,
			repo,
			parkRepo,
			limits: { parkedTimeoutMs: 300 },
		});
		expect(a.bridge.status().releaseBlocked).toBeNull();
		expect(b.bridge.status().releaseBlocked).toContain(
			"another running process",
		);
		const p = await parkTurn(b);
		await waitFor(
			() => b.repo.turns.get(p.turnId)?.status === "timed_out",
			3_000,
		);
		expect(parkRepo.parks.size).toBe(0);
	});
});

describe("faults", () => {
	it("a failed publish ends the turn and leaves no record or file behind", async () => {
		const h = await releaseHarness();
		h.parkRepo.failNext.markReleased = new Error("disk I/O error");
		const p = await parkTurn(h);
		await waitFor(() => h.repo.turns.get(p.turnId)?.status === "failed", 8_000);
		expect(String(h.repo.turns.get(p.turnId)?.errorMessage)).toContain(
			"could not be kept",
		);
		expect(h.parkRepo.parks.size).toBe(0);
		expect(parkFiles(h)).toEqual([]);
		expect(h.bridge.status().counters.releaseFailures).toBe(1);
	});

	it("a session file that cannot be published ends the turn and drops its record", async () => {
		const h = await releaseHarness();
		const p = await parkTurn(h);
		// A directory where the file should go.
		const sid = p.query.sessionId;
		mkdirSync(join(parkDir(h), `${sid}.jsonl`), { recursive: true });
		await waitFor(() => h.repo.turns.get(p.turnId)?.status === "failed", 8_000);
		expect(h.parkRepo.parks.size).toBe(0);
		expect(
			readdirSync(parkDir(h)).filter((n) => n.startsWith(".tmp-")),
		).toEqual([]);
	});

	it("a failed preparing insert ends the turn the same way", async () => {
		const h = await releaseHarness();
		h.parkRepo.failNext.insertPreparing = new Error("SQLITE_BUSY");
		const p = await parkTurn(h);
		await waitFor(() => h.repo.turns.get(p.turnId)?.status === "failed", 8_000);
		expect(h.parkRepo.parks.size).toBe(0);
		expect(parkFiles(h)).toEqual([]);
	});

	it("a failed claim answers 503; the park is claimable again once the database is read back", async () => {
		const h = await releaseHarness({ timing: { maintenanceIntervalMs: 50 } });
		const p = await parkTurn(h);
		await released(h, p);
		h.parkRepo.failNext.claim = new Error("SQLITE_BUSY");
		expect((await reply(answer(h, p, results(p)))).status).toBe(503);
		// Until the maintenance pass has read the record back, not claimable.
		await waitFor(() => h.bridge.status().releasedParks === 1, 3_000);
		expect(h.parkRepo.parks.get(p.turnId)?.state).toBe("released");
		const response = answer(h, p, results(p));
		const q2 = await h.sdk.next();
		expect((await finishResumed(h, q2, response)).status).toBe(200);
	});

	it("a consumed mark that fails holds the model call back", async () => {
		const h = await releaseHarness();
		const p = await parkTurn(h);
		await released(h, p);
		h.parkRepo.failNext.markConsumed = new Error("SQLITE_BUSY");
		const response = answer(h, p, results(p));
		const q2 = await h.sdk.next();
		const call = await innerCall(q2);
		expect(call.status).toBe(503);
		expect(h.inner.calls.length).toBe(0);
		// The failed mark is not cached: the next call tries again.
		expect((await innerCall(q2)).status).toBe(200);
		expect(h.parkRepo.parks.get(p.turnId)?.state).toBe("consumed");
		expect((await finishResumed(h, q2, response)).status).toBe(200);
	});

	it("a launch that throws answers 503 and gives the claim back", async () => {
		const h = await releaseHarness();
		const p = await parkTurn(h);
		await released(h, p);
		h.sdk.throwNext = new Error("spawn EAGAIN");
		const r = await reply(answer(h, p, results(p)));
		expect(r.status).toBe(503);
		expect(h.parkRepo.parks.get(p.turnId)?.state).toBe("released");
		expect(h.repo.turns.get(p.turnId)?.status).toBe("released");
		const response = answer(h, p, results(p));
		const q2 = await h.sdk.next();
		expect((await finishResumed(h, q2, response)).status).toBe(200);
	});
});

describe("disposing during a release", () => {
	it("waits for the release to finish before removing the generation", async () => {
		const h = await releaseHarness({ process: "ignore-term", keep: true });
		const p = await parkTurn(h);
		await waitFor(() => h.bridge.status().parked === 0, 2_000);
		await h.bridge.dispose();
		expect(h.parkRepo.parks.get(p.turnId)?.state).toBe("released");
		expect(parkFiles(h).length).toBe(1);
		rmSync(h.workRoot, { recursive: true, force: true });
	});
});

describe("the resume sequence", () => {
	it("a copy that cannot be written rolls the claim back: park, conversation and retry intact", async () => {
		const h = await releaseHarness();
		const header = {
			affinityScope: "client_session",
			affinityKey: "conv-fork-fail",
		} as const;
		const p = await parkTurn(h, { meta: header });
		await released(h, p);
		const gen = readdirSync(h.workRoot).find((n) => n.startsWith("gen-"));
		const sessions = join(h.workRoot, String(gen), "sessions");
		chmodSync(sessions, 0o500);
		let r: Awaited<ReturnType<typeof reply>>;
		try {
			r = await reply(answer(h, p, results(p), header));
		} finally {
			chmodSync(sessions, 0o700);
		}
		expect(r.status).toBe(503);
		expect(h.parkRepo.parks.get(p.turnId)?.state).toBe("released");
		expect(h.repo.turns.get(p.turnId)?.status).toBe("released");
		expect(h.sdk.queries.length).toBe(1);
		// The conversation is free and the park resumes on the retry.
		const response = answer(h, p, results(p), header);
		const q2 = await h.sdk.next();
		expect((await finishResumed(h, q2, response)).status).toBe(200);
	});

	it("rechecks the process cap right before the launch", async () => {
		const limits = { maxProcesses: 2 };
		const h = await releaseHarness({ limits });
		const one = await parkTurn(h);
		const two = await parkTurn(h);
		await released(h, one);
		await released(h, two);
		limits.maxProcesses = 1;
		// Both pass the early check; only one may launch.
		// Whichever claims first waits; both pass the early check.
		h.parkRepo.hold.claim = Bun.sleep(50);
		const r1 = reply(answer(h, one, results(one)));
		const r2 = reply(answer(h, two, results(two)));
		const q = await h.sdk.next();
		await innerCall(q);
		q.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "done" }]),
			resultMessage(),
		);
		const [a, b] = await Promise.all([r1, r2]);
		expect([a.status, b.status].sort()).toEqual([200, 529]);
		const refused = a.status === 529 ? one : two;
		expect(h.parkRepo.parks.get(refused.turnId)?.state).toBe("released");
		expect(h.repo.turns.get(refused.turnId)?.status).toBe("released");
		expect(h.sdk.queries.length).toBe(3);
	});

	it("launches nothing for a client that left or a bridge that began shutting down while it claimed", async () => {
		const h = await releaseHarness({ keep: true });
		const p = await parkTurn(h);
		await released(h, p);
		const abort = new AbortController();
		let letGo!: () => void;
		h.parkRepo.hold.claim = new Promise((resolve) => {
			letGo = resolve;
		});
		const gone = h.bridge.continueTurn({
			turnId: p.turnId,
			request: messagesRequest({ tools: [READ_TOOL], messages: results(p) }),
			meta: makeMeta(),
			signal: abort.signal,
		});
		await waitFor(() => h.parkRepo.calls.includes("claim"));
		abort.abort();
		letGo();
		expect((await gone).status).toBe(499);
		expect(h.parkRepo.parks.get(p.turnId)?.state).toBe("released");

		h.parkRepo.hold.claim = new Promise((resolve) => {
			letGo = resolve;
		});
		const late = answer(h, p, results(p));
		await waitFor(
			() => h.parkRepo.calls.filter((c) => c === "claim").length === 2,
		);
		h.bridge.beginShutdown();
		letGo();
		expect((await late).status).toBe(503);
		expect(h.sdk.queries.length).toBe(1);
		expect(h.parkRepo.parks.get(p.turnId)?.state).toBe("released");
		await h.bridge.dispose();
		expect(h.parkRepo.parks.get(p.turnId)?.state).toBe("released");
	});

	it("gives the park back when the resumed query ends before its first model call", async () => {
		const h = await releaseHarness();
		const p = await parkTurn(h);
		await released(h, p);
		const response = answer(h, p, results(p));
		const q2 = await h.sdk.next();
		q2.emit(
			initMessage(),
			resultMessage({ isError: true, subtype: "error_during_execution" }),
		);
		q2.end();
		expect((await reply(response)).status).toBe(502);
		await waitFor(() => h.parkRepo.parks.get(p.turnId)?.state === "released");
		expect(h.repo.turns.get(p.turnId)?.status).toBe("released");
		expect(h.repo.turns.get(p.turnId)?.finishedAt).toBeUndefined();
		expect(parkFiles(h).length).toBe(1);
		// The results resume it again.
		const retry = answer(h, p, results(p));
		const q3 = await h.sdk.next();
		expect((await finishResumed(h, q3, retry)).status).toBe(200);
		await waitFor(() => !h.parkRepo.parks.has(p.turnId));
	});
});

describe("results racing the release", () => {
	it("a continuation whose body arrives after the release resumes the stored park", async () => {
		const h = await releaseHarness({ limits: { parkReleaseMs: 150 } });
		const p = await parkTurn(h);
		const body = JSON.stringify({
			model: MODEL,
			max_tokens: 1024,
			stream: true,
			tools: [READ_TOOL],
			messages: results(p),
		});
		// The body is held back until the release has stored the park.
		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				await waitFor(
					() => h.repo.turns.get(p.turnId)?.status === "released",
					5_000,
				);
				controller.enqueue(new TextEncoder().encode(body));
				controller.close();
			},
		});
		const response = h.bridge.continueTurn({
			turnId: p.turnId,
			request: new Request("http://bridge.test/v1/messages", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: stream,
				duplex: "half",
			} as RequestInit),
			meta: makeMeta(),
			signal: new AbortController().signal,
		});
		const q2 = await h.sdk.next();
		expect(q2.options.resumeSessionAt).toBe(
			h.parkRepo.parks.get(p.turnId)?.resumeAt,
		);
		expect((await finishResumed(h, q2, response)).status).toBe(200);
	});
});

describe("supersession around a release", () => {
	const header = {
		affinityScope: "client_session",
		affinityKey: "conv-race",
	} as const;
	const next = (h: Harness) =>
		h.bridge.startTurn({
			request: messagesRequest({
				tools: [READ_TOOL],
				messages: [first, { role: "assistant", content: "no" }, first],
			}),
			plan: makePlan(),
			meta: makeMeta(header),
			signal: new AbortController().signal,
		});

	it("tears down a query whose release fell back to parked", async () => {
		const h = await releaseHarness({ limits: { parkReleaseMs: 30 } });
		// No envelopes: the release waits for them, then gives up.
		const p = await parkTurn(h, { meta: header, envelopes: false });
		await waitFor(() => h.bridge.status().parked === 0);
		const t = next(h);
		const q2 = await h.sdk.next();
		await waitFor(() => h.repo.turns.get(p.turnId)?.status === "aborted");
		expect(h.bridge.status().live).toBe(1);
		q2.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "ok" }]),
			resultMessage(),
		);
		expect((await reply(t)).status).toBe(200);
	});

	it("ends a park claimed mid-resume before the resume launches", async () => {
		const h = await releaseHarness();
		const p = await parkTurn(h, { meta: header });
		await released(h, p);
		let letGo!: () => void;
		h.parkRepo.hold.claim = new Promise((resolve) => {
			letGo = resolve;
		});
		const resume = answer(h, p, results(p), header);
		await waitFor(() => h.parkRepo.calls.includes("claim"));
		const t = next(h);
		const q2 = await h.sdk.next();
		letGo();
		const r = await reply(resume);
		expect(r.status).toBe(409);
		expect(JSON.stringify(r.body)).toContain("A new turn of this conversation");
		await waitFor(() => h.repo.turns.get(p.turnId)?.status === "aborted");
		expect(h.parkRepo.parks.size).toBe(0);
		expect(h.sdk.queries.length).toBe(2);
		q2.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "ok" }]),
			resultMessage(),
		);
		expect((await reply(t)).status).toBe(200);
	});
});

describe("release edges", () => {
	it("does not release before the envelopes cover every awaited call", async () => {
		const h = await releaseHarness({ limits: { parkedTimeoutMs: 60_000 } });
		const p = await parkTurn(h, {
			ids: ["toolu_x", "toolu_y"],
			envelopes: "first",
		});
		await waitFor(
			() => h.bridge.status().counters.releasesRefused === 1,
			5_000,
		);
		expect(h.parkRepo.parks.size).toBe(0);
		expect(h.bridge.status().parked).toBe(1);
		expect(h.repo.turns.get(p.turnId)?.status).toBe("running");
	});

	it("closes a query whose process died while the release waited, instead of parking it", async () => {
		const h = await releaseHarness();
		const p = await parkTurn(h, { envelopes: false });
		// Dies while the release waits for the envelopes.
		await waitFor(() => h.bridge.status().parked === 0);
		process.kill(Number(p.query.pid), "SIGKILL");
		await waitFor(() => h.repo.turns.get(p.turnId)?.status === "failed", 5_000);
		expect(h.bridge.status().live).toBe(0);
		expect(h.parkRepo.parks.size).toBe(0);
	});

	it("arms the parked timeout at park time when no release can happen", async () => {
		const workRoot = tempRoot();
		const repo = memoryTurnRepo();
		const parkRepo = memoryParkRepo(repo.turns);
		await releaseHarness({ workRoot, repo, parkRepo });
		// Another bridge owns the directory: this one never releases.
		const b = await releaseHarness({
			workRoot,
			repo,
			parkRepo,
			limits: { parkReleaseMs: 5_000, parkedTimeoutMs: 300 },
		});
		const t0 = Date.now();
		const p = await parkTurn(b);
		await waitFor(
			() => b.repo.turns.get(p.turnId)?.status === "timed_out",
			3_000,
		);
		expect(Date.now() - t0).toBeLessThan(2_000);
	});

	it("never lets the parked timeout run past its value when it is shorter than the release delay", async () => {
		const h = await releaseHarness({
			limits: { parkReleaseMs: 5_000, parkedTimeoutMs: 300 },
		});
		const t0 = Date.now();
		const p = await parkTurn(h);
		await waitFor(
			() => h.repo.turns.get(p.turnId)?.status === "timed_out",
			3_000,
		);
		expect(Date.now() - t0).toBeLessThan(2_000);
		expect(h.parkRepo.parks.size).toBe(0);
	});

	it("a release dispose gave up on stores nothing afterwards", async () => {
		const h = await releaseHarness({
			process: "ignore-term",
			timing: { releaseDrainMs: 100 },
			keep: true,
		});
		const p = await parkTurn(h);
		await waitFor(() => h.bridge.status().parked === 0, 2_000);
		await h.bridge.dispose();
		expect(h.repo.turns.get(p.turnId)?.status).toBe("failed");
		// The SIGKILL lands and the release would carry on; it must not.
		await Bun.sleep(3_000);
		expect(h.parkRepo.parks.size).toBe(0);
		expect(existsSync(parkDir(h)) ? parkFiles(h) : []).toEqual([]);
		expect(h.repo.turns.get(p.turnId)?.status).toBe("failed");
		rmSync(h.workRoot, { recursive: true, force: true });
	});
});

describe("recovery, row by row", () => {
	/** Two released parks from one bridge, then that bridge gone. */
	async function twoReleased() {
		const workRoot = tempRoot();
		const repo = memoryTurnRepo();
		const parkRepo = memoryParkRepo(repo.turns);
		const a = await releaseHarness({ workRoot, repo, parkRepo, keep: true });
		const one = await parkTurn(a);
		await released(a, one);
		const two = await parkTurn(a);
		await released(a, two);
		await a.bridge.dispose();
		const dir = join(workRoot, "released-parks", parkRepo.namespace);
		return { workRoot, repo, parkRepo, one, two, dir };
	}

	it("ends a park it cannot use and keeps recovering the rest", async () => {
		const { workRoot, repo, parkRepo, one, two } = await twoReleased();
		// Unreadable awaited ids read as none: unusable.
		(
			parkRepo.parks.get(one.turnId) as { awaitedToolUseIds: string[] }
		).awaitedToolUseIds = [];
		const b = await releaseHarness({ workRoot, repo, parkRepo });
		expect(b.bridge.availability()).toEqual({ state: "available" });
		expect(repo.turns.get(one.turnId)?.status).toBe("failed");
		expect(parkRepo.parks.has(two.turnId)).toBe(true);
		expect(b.bridge.status().releasedParks).toBe(1);
	});

	it("keeps a row whose transition fails, with its file, and retries it on the next attempt", async () => {
		const { workRoot, repo, parkRepo, one, two } = await twoReleased();
		Object.assign(parkRepo.parks.get(one.turnId) ?? {}, {
			state: "claimed",
			claimOwner: "dead-owner",
			claimedAt: 1,
		});
		const file = String(parkRepo.parks.get(one.turnId)?.sessionPath);
		parkRepo.failNext.unclaim = new Error("SQLITE_BUSY");
		const b = await releaseHarness({
			workRoot,
			repo,
			parkRepo,
			timing: { recoveryRetryMs: 100 },
		});
		expect(b.bridge.availability().state).toBe("unavailable");
		expect(existsSync(file)).toBe(true);
		await waitFor(() => b.bridge.availability().state === "available", 3_000);
		expect(parkRepo.parks.get(one.turnId)?.state).toBe("released");
		expect(parkRepo.parks.get(two.turnId)?.state).toBe("released");
		expect(b.bridge.status().releasedParks).toBe(2);
	});

	it("stays unavailable while recovery fails, and retries until it succeeds", async () => {
		const { workRoot, repo, parkRepo, one } = await twoReleased();
		parkRepo.failNext.list = new Error("database is locked");
		const b = await releaseHarness({
			workRoot,
			repo,
			parkRepo,
			timing: { recoveryRetryMs: 150 },
		});
		const state = b.bridge.availability();
		expect(state.state).toBe("unavailable");
		expect(state.state === "unavailable" ? state.reason : "").toContain(
			"recovering",
		);
		await waitFor(() => b.bridge.availability().state === "available", 3_000);
		expect(b.bridge.status().releasedParks).toBe(2);
		expect(
			turnIdOf(
				b.bridge.findContinuation(one.ids, { apiKeyId: "key-1", model: MODEL }),
			),
		).toBe(one.turnId);
	});

	it("checks only the file's size and resume point at startup; the chain at the resume", async () => {
		const { workRoot, repo, parkRepo, one, two } = await twoReleased();
		// One file shorter than recorded: unusable at startup.
		const shortFile = String(parkRepo.parks.get(one.turnId)?.sessionPath);
		writeFileSync(shortFile, readFileSync(shortFile).subarray(0, 10));
		// One with its calls blanked out, same size: kept until the resume.
		const blank = String(parkRepo.parks.get(two.turnId)?.sessionPath);
		const text = readFileSync(blank, "utf8");
		const id = two.ids[0] as string;
		writeFileSync(blank, text.replaceAll(id, "x".repeat(id.length)));
		const b = await releaseHarness({ workRoot, repo, parkRepo });
		expect(repo.turns.get(one.turnId)?.status).toBe("failed");
		expect(parkRepo.parks.get(two.turnId)?.state).toBe("released");
		const response = answer(b, two, results(two));
		const q = await b.sdk.next();
		// The chain check at the claim sends it to a flattened rebuild.
		expect(q.options.resume).toBeUndefined();
		q.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "rebuilt" }]),
			resultMessage(),
		);
		expect((await reply(response)).status).toBe(200);
		expect(repo.turns.get(two.turnId)?.status).toBe("failed");
	});

	it("deletes a consumed park whose turn already finished without touching the turn", async () => {
		const { workRoot, repo, parkRepo, one } = await twoReleased();
		const park = parkRepo.parks.get(one.turnId);
		if (park) park.state = "consumed";
		await repo.finishTurn(one.turnId, { finishedAt: 5, status: "completed" });
		const b = await releaseHarness({ workRoot, repo, parkRepo });
		expect(parkRepo.parks.has(one.turnId)).toBe(false);
		expect(repo.turns.get(one.turnId)?.status).toBe("completed");
		expect(b.bridge.status().releasedParks).toBe(1);
	});
});

describe("ownership of released parks", () => {
	it("an instance on another database, same work root, neither deletes nor touches the first's parks", async () => {
		const workRoot = tempRoot();
		const repoA = memoryTurnRepo();
		const parksA = memoryParkRepo(repoA.turns);
		const a = await releaseHarness({
			workRoot,
			repo: repoA,
			parkRepo: parksA,
			keep: true,
		});
		const p = await parkTurn(a);
		await released(a, p);
		const fileA = parkFiles(a);

		// A dev instance with its own database, on the same cache directory.
		const b = await releaseHarness({ workRoot });
		expect(b.bridge.status().releaseBlocked).toBeNull();
		expect(parkFiles(a)).toEqual(fileA);
		await b.bridge.dispose();
		await a.bridge.dispose();
		// Still there for A's next start.
		const c = await releaseHarness({ workRoot });
		await c.bridge.ready();
		expect(parkFiles(a)).toEqual(fileA);
		expect(parksA.parks.get(p.turnId)?.state).toBe("released");
		const a2 = await releaseHarness({
			workRoot,
			repo: repoA,
			parkRepo: parksA,
		});
		expect(a2.bridge.status().releasedParks).toBe(1);
	});

	it("two work roots on one database: only the lease holder recovers or closes turns", async () => {
		const repo = memoryTurnRepo();
		const parkRepo = memoryParkRepo(repo.turns);
		const a = await releaseHarness({ workRoot: tempRoot(), repo, parkRepo });
		const p = await parkTurn(a);
		await released(a, p);
		// A turn of A's still running.
		const running = a.bridge.startTurn({
			request: messagesRequest({ messages: [{ role: "user", content: "hi" }] }),
			plan: makePlan(),
			meta: makeMeta(),
			signal: new AbortController().signal,
		});
		const q = await a.sdk.next();
		await waitFor(() =>
			[...repo.turns.values()].some((t) => t.status === "running"),
		);
		const runningId = [...repo.turns.values()].find(
			(t) => t.status === "running",
		)?.id;

		const b = await releaseHarness({ workRoot: tempRoot(), repo, parkRepo });
		expect(b.bridge.status().releaseBlocked).toContain("database");
		expect(b.bridge.status().releasedParks).toBe(0);
		expect(parkRepo.parks.get(p.turnId)?.state).toBe("released");
		expect(repo.turns.get(String(runningId))?.status).toBe("running");
		expect(parkRepo.lease?.dir).toBe(parkDir(a));

		q.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "hi" }]),
			resultMessage(),
		);
		expect((await reply(running)).status).toBe(200);
	});
});

describe("timings of a resumed turn", () => {
	it("measures spawn and first event from the resume's own launch, duration from the turn's start", async () => {
		const h = await releaseHarness();
		const p = await parkTurn(h);
		await released(h, p);
		await Bun.sleep(600);
		const response = answer(h, p, results(p));
		const q2 = await h.sdk.next();
		expect((await finishResumed(h, q2, response)).status).toBe(200);
		await waitFor(() => h.repo.turns.get(p.turnId)?.status === "completed");
		const turn = h.repo.turns.get(p.turnId) as Record<string, number>;
		expect(turn.spawnMs).toBeLessThan(400);
		expect(turn.firstEventMs).toBeLessThan(400);
		expect(turn.durationMs).toBeGreaterThanOrEqual(600);
	});
});

describe("the lease as the only authority", () => {
	it("a new holder on another work root recovers and resumes a park through its recorded path", async () => {
		const repo = memoryTurnRepo();
		const parkRepo = memoryParkRepo(repo.turns);
		const rootA = tempRoot();
		const a = await releaseHarness({
			workRoot: rootA,
			repo,
			parkRepo,
			keep: true,
		});
		const p = await parkTurn(a);
		await released(a, p);
		const path = String(parkRepo.parks.get(p.turnId)?.sessionPath);
		expect(path.startsWith(rootA)).toBe(true);
		await a.bridge.dispose();

		const b = await releaseHarness({ workRoot: tempRoot(), repo, parkRepo });
		expect(b.bridge.status().releasedParks).toBe(1);
		// Not ended as unusable for living in another root.
		expect(existsSync(path)).toBe(true);
		const response = answer(b, p, results(p));
		const q2 = await b.sdk.next();
		expect(q2.options.resumeSessionAt).toBe(
			parkRepo.parks.get(p.turnId)?.resumeAt,
		);
		expect((await finishResumed(b, q2, response)).status).toBe(200);
		await waitFor(() => !parkRepo.parks.has(p.turnId));
		expect(existsSync(path)).toBe(false);
	});

	it("refuses a recorded path outside a released-parks directory of this database, or through a symlink", async () => {
		const repo = memoryTurnRepo();
		const parkRepo = memoryParkRepo(repo.turns);
		const root = tempRoot();
		const a = await releaseHarness({
			workRoot: root,
			repo,
			parkRepo,
			keep: true,
		});
		const one = await parkTurn(a);
		await released(a, one);
		const two = await parkTurn(a);
		await released(a, two);
		await a.bridge.dispose();
		const outside = join(tempRoot(), "elsewhere.jsonl");
		const oneFile = String(parkRepo.parks.get(one.turnId)?.sessionPath);
		writeFileSync(outside, readFileSync(oneFile));
		Object.assign(parkRepo.parks.get(one.turnId) ?? {}, {
			sessionPath: outside,
		});
		// The other's directory replaced by a symlink to a copy of it.
		const twoFile = String(parkRepo.parks.get(two.turnId)?.sessionPath);
		const nsDir = join(root, "released-parks", parkRepo.namespace);
		const copy = `${nsDir}-real`;
		mkdirSync(copy);
		writeFileSync(join(copy, basename(twoFile)), readFileSync(twoFile));
		rmSync(nsDir, { recursive: true });
		symlinkSync(copy, nsDir);
		const b = await releaseHarness({ workRoot: tempRoot(), repo, parkRepo });
		expect(b.bridge.status().releasedParks).toBe(0);
		expect(repo.turns.get(one.turnId)?.status).toBe("failed");
		expect(repo.turns.get(two.turnId)?.status).toBe("failed");
		// Never deleted through the symlink or outside the park directories.
		expect(existsSync(outside)).toBe(true);
		expect(existsSync(join(copy, basename(twoFile)))).toBe(true);
	});

	it("a new holder never closes the running turns of a live bridge that holds no lease", async () => {
		const repo = memoryTurnRepo();
		const parkRepo = memoryParkRepo(repo.turns);
		const holder = await releaseHarness({ repo, parkRepo, keep: true });
		// Another live bridge on the database, without the lease, running a turn.
		const other = await releaseHarness({ repo, parkRepo });
		expect(other.bridge.status().releaseBlocked).toContain("database");
		const running = other.bridge.startTurn({
			request: messagesRequest({ messages: [{ role: "user", content: "hi" }] }),
			plan: makePlan(),
			meta: makeMeta(),
			signal: new AbortController().signal,
		});
		const q = await other.sdk.next();
		await waitFor(() =>
			[...repo.turns.values()].some((t) => t.status === "running"),
		);
		const liveId = [...repo.turns.values()].find((t) => t.status === "running")
			?.id as string;
		// And a turn whose process is gone.
		await repo.insertTurn({
			id: "dead-turn",
			startedAt: 1,
			historyMode: "fresh",
			systemPromptPolicy: "drop",
			ownerPid: 2 ** 22 + 11,
			ownerStartTime: "1",
		} as never);
		await holder.bridge.dispose();

		const log = capturingLog();
		const next = await releaseHarness({ repo, parkRepo, log });
		expect(next.bridge.status().releaseBlocked).toBeNull();
		// Closed without enumerating them: one line with the count.
		expect(
			log.entries.filter(
				(e) =>
					(e.data as { event?: string } | undefined)?.event ===
					"sdk_bridge_turns_closed",
			),
		).toEqual([
			expect.objectContaining({
				level: "warn",
				data: expect.objectContaining({
					status: "failed",
					count: 1,
					httpStatus: 502,
				}),
			}),
		]);
		expect(repo.turns.get(liveId)?.status).toBe("running");
		expect(repo.turns.get("dead-turn")?.status).toBe("failed");
		q.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "hi" }]),
			resultMessage(),
		);
		expect((await reply(running)).status).toBe(200);
	});

	it("a write in flight when the lease was given up changes nothing", async () => {
		const h = await releaseHarness({ keep: true });
		let letGo!: () => void;
		h.parkRepo.hold.markReleased = new Promise((resolve) => {
			letGo = resolve;
		});
		const p = await parkTurn(h);
		await waitFor(() => h.parkRepo.calls.includes("markReleased"), 5_000);
		// The lease goes (as dispose gives it up) while markReleased waits.
		await h.parkRepo.releaseLease(h.parkRepo.lease?.token as string);
		letGo();
		await waitFor(
			() => h.bridge.status().counters.releaseFailures === 1,
			5_000,
		);
		await Bun.sleep(50);
		// Refused: never released. Its cleanup is refused too, so the record
		// stays `preparing` for the next holder's recovery to end, and the
		// turn row (fenced from the release on) is left to that recovery.
		expect(h.parkRepo.parks.get(p.turnId)?.state).toBe("preparing");
		expect(h.repo.turns.get(p.turnId)?.status).toBe("running");
		expect(parkFiles(h)).toEqual([]);
		await h.bridge.dispose();
	});
});

describe("writes the database has not confirmed", () => {
	it("keeps a park whose unclaim failed out of reach, and releases it once a retry lands", async () => {
		const h = await releaseHarness({ timing: { maintenanceIntervalMs: 50 } });
		const p = await parkTurn(h);
		await released(h, p);
		h.parkRepo.failNext.unclaim = new Error("SQLITE_BUSY");
		const response = answer(h, p, results(p));
		const q2 = await h.sdk.next();
		q2.emit(
			initMessage(),
			resultMessage({ isError: true, subtype: "error_during_execution" }),
		);
		q2.end();
		expect((await reply(response)).status).toBe(502);
		await waitFor(
			() => h.parkRepo.calls.filter((c) => c === "unclaim").length >= 2,
			3_000,
		);
		await waitFor(
			() => h.parkRepo.parks.get(p.turnId)?.state === "released",
			3_000,
		);
		await waitFor(() => h.bridge.status().releasedParks === 1, 3_000);
		const retry = answer(h, p, results(p));
		const q3 = await h.sdk.next();
		expect((await finishResumed(h, q3, retry)).status).toBe(200);
	});

	it("while a consumed mark is in flight, a close waits for it before choosing the park's fate", async () => {
		const h = await releaseHarness();
		const p = await parkTurn(h);
		await released(h, p);
		let letGo!: () => void;
		h.parkRepo.hold.markConsumed = new Promise((resolve) => {
			letGo = resolve;
		});
		const response = answer(h, p, results(p));
		const q2 = await h.sdk.next();
		const call = innerCall(q2);
		await waitFor(() => h.parkRepo.calls.includes("markConsumed"));
		// The query ends while the mark is still on its way.
		q2.emit(
			initMessage(),
			resultMessage({ isError: true, subtype: "error_during_execution" }),
		);
		q2.end();
		expect((await reply(response)).status).toBe(502);
		letGo();
		await call;
		// It landed: the park is spent, so it goes and the turn ends.
		await waitFor(() => !h.parkRepo.parks.has(p.turnId), 3_000);
		await waitFor(() => h.repo.turns.get(p.turnId)?.status === "failed", 3_000);
		expect(h.parkRepo.calls.includes("unclaim")).toBe(false);
	});

	it("chains a resumed leg's finish behind its insert", async () => {
		const h = await releaseHarness();
		const p = await parkTurn(h);
		await released(h, p);
		let letGo!: () => void;
		h.repo.legInsertHold.next = new Promise((resolve) => {
			letGo = resolve;
		});
		const meta = makeMeta();
		const response = h.bridge.continueTurn({
			turnId: p.turnId,
			request: messagesRequest({ tools: [READ_TOOL], messages: results(p) }),
			meta,
			signal: new AbortController().signal,
		});
		const q2 = await h.sdk.next();
		expect((await finishResumed(h, q2, response)).status).toBe(200);
		letGo();
		await waitFor(() => h.repo.legs.get(meta.legId)?.finished === true, 3_000);
		expect(h.repo.legs.get(meta.legId)).toMatchObject({
			kind: "continue",
			httpStatus: 200,
		});
	});
});

describe("the recovery gate", () => {
	it("answers 503 for results while recovering, then resumes once recovered", async () => {
		const workRoot = tempRoot();
		const repo = memoryTurnRepo();
		const parkRepo = memoryParkRepo(repo.turns);
		const a = await releaseHarness({ workRoot, repo, parkRepo, keep: true });
		const p = await parkTurn(a);
		await released(a, p);
		await a.bridge.dispose();

		parkRepo.failNext.list = new Error("database is locked");
		const b = await releaseHarness({
			workRoot,
			repo,
			parkRepo,
			timing: { recoveryRetryMs: 300 },
		});
		const found = b.bridge.findContinuation(p.ids, {
			apiKeyId: "key-1",
			model: MODEL,
		});
		expect(found).toMatchObject({ retryAfter: "5" });
		expect(String((found as { unavailable: string }).unavailable)).toContain(
			"recovering",
		);
		const refused = await b.bridge.continueTurn({
			turnId: p.turnId,
			request: messagesRequest({ tools: [READ_TOOL], messages: results(p) }),
			meta: makeMeta(),
			signal: new AbortController().signal,
		});
		expect(refused.status).toBe(503);
		expect(refused.headers.get("retry-after")).toBe("5");
		expect(b.sdk.queries.length).toBe(0);

		await waitFor(() => b.bridge.availability().state === "available", 3_000);
		expect(
			turnIdOf(
				b.bridge.findContinuation(p.ids, { apiKeyId: "key-1", model: MODEL }),
			),
		).toBe(p.turnId);
		const response = answer(b, p, results(p));
		const q2 = await b.sdk.next();
		expect((await finishResumed(b, q2, response)).status).toBe(200);
	});

	it("opens within its startup budget when the database is slow, recovering in the background", async () => {
		const workRoot = tempRoot();
		const repo = memoryTurnRepo();
		const parkRepo = memoryParkRepo(repo.turns);
		const a = await releaseHarness({ workRoot, repo, parkRepo, keep: true });
		const p = await parkTurn(a);
		await released(a, p);
		await a.bridge.dispose();

		let letGo!: () => void;
		parkRepo.hold.list = new Promise((resolve) => {
			letGo = resolve;
		});
		const t0 = Date.now();
		const b = await releaseHarness({
			workRoot,
			repo,
			parkRepo,
			timing: { recoveryStartupMs: 200 },
		});
		expect(Date.now() - t0).toBeLessThan(1_500);
		expect(b.bridge.availability().state).toBe("unavailable");
		letGo();
		await waitFor(() => b.bridge.availability().state === "available", 3_000);
		expect(b.bridge.status().releasedParks).toBe(1);
	});
});

describe("second review fixes", () => {
	it("a resumed turn's late writes change nothing once the lease has moved on", async () => {
		const h = await releaseHarness();
		const p = await parkTurn(h);
		await released(h, p);
		const meta = makeMeta();
		const response = h.bridge.continueTurn({
			turnId: p.turnId,
			request: messagesRequest({ tools: [READ_TOOL], messages: results(p) }),
			meta,
			signal: new AbortController().signal,
		});
		const q2 = await h.sdk.next();
		await innerCall(q2);
		// Another process takes the lease (this one declared dead).
		await h.parkRepo.acquireLease(
			{ dir: "/elsewhere", pid: 1, startTime: null, token: "other", at: 1 },
			() => true,
		);
		q2.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "done" }]),
			resultMessage(),
		);
		expect((await reply(response)).status).toBe(200);
		await waitFor(() => h.bridge.status().live === 0);
		await Bun.sleep(50);
		const turn = h.repo.turns.get(p.turnId);
		expect(turn?.status).toBe("running");
		expect(turn?.finishedAt).toBeUndefined();
		expect(turn?.counters.toolRounds).toBe(1);
		expect(h.repo.legs.get(meta.legId)?.finished).toBeUndefined();
	});

	it("never lets a delayed unclaim of an earlier claim release a newer one", async () => {
		const h = await releaseHarness({ timing: { maintenanceIntervalMs: 20 } });
		const p = await parkTurn(h);
		await released(h, p);
		// First resume: ends before its first model call, and its unclaim
		// fails; the maintenance retry after it waits on the hold.
		let letGo!: () => void;
		h.parkRepo.failNext.unclaim = new Error("SQLITE_BUSY");
		h.parkRepo.hold.unclaim = new Promise((resolve) => {
			letGo = resolve;
		});
		const first = answer(h, p, results(p));
		const q2 = await h.sdk.next();
		q2.emit(
			initMessage(),
			resultMessage({ isError: true, subtype: "error_during_execution" }),
		);
		q2.end();
		expect((await reply(first)).status).toBe(502);
		// The retry is held: maintenance keeps ticking but never starts another.
		await waitFor(
			() => h.parkRepo.calls.filter((c) => c === "unclaim").length === 2,
			3_000,
		);
		await Bun.sleep(200);
		expect(h.parkRepo.calls.filter((c) => c === "unclaim").length).toBe(2);
		letGo();
		await waitFor(() => h.bridge.status().releasedParks === 1, 3_000);
		// A new claim; the first claim's generation can no longer undo it.
		const second = answer(h, p, results(p));
		const q3 = await h.sdk.next();
		const claimed = h.parkRepo.parks.get(p.turnId);
		expect(claimed?.state).toBe("claimed");
		expect(
			await h.parkRepo.unclaim(p.turnId, String(h.parkRepo.lease?.token), {
				claimId: "an-earlier-claim",
			}),
		).toBe(false);
		await Bun.sleep(100);
		expect(h.parkRepo.parks.get(p.turnId)?.state).toBe("claimed");
		expect((await finishResumed(h, q3, second)).status).toBe(200);
	});

	it("refuses a recorded path with a symlink above released-parks", async () => {
		const repo = memoryTurnRepo();
		const parkRepo = memoryParkRepo(repo.turns);
		const root = tempRoot();
		const a = await releaseHarness({
			workRoot: root,
			repo,
			parkRepo,
			keep: true,
		});
		const p = await parkTurn(a);
		await released(a, p);
		await a.bridge.dispose();
		const real = String(parkRepo.parks.get(p.turnId)?.sessionPath);
		// The same file reached through a symlinked work root.
		const link = `${root}-link`;
		symlinkSync(root, link);
		cleanups.push(() => rmSync(link, { force: true }));
		Object.assign(parkRepo.parks.get(p.turnId) ?? {}, {
			sessionPath: real.replace(root, link),
		});
		const b = await releaseHarness({ workRoot: tempRoot(), repo, parkRepo });
		expect(b.bridge.status().releasedParks).toBe(0);
		expect(repo.turns.get(p.turnId)?.status).toBe("failed");
		// Nothing deleted through the link.
		expect(existsSync(real)).toBe(true);
	});

	it("checks the path again when a resume claims the park", async () => {
		const repo = memoryTurnRepo();
		const parkRepo = memoryParkRepo(repo.turns);
		const rootA = tempRoot();
		const a = await releaseHarness({
			workRoot: rootA,
			repo,
			parkRepo,
			keep: true,
		});
		const p = await parkTurn(a);
		await released(a, p);
		await a.bridge.dispose();
		const b = await releaseHarness({ workRoot: tempRoot(), repo, parkRepo });
		expect(b.bridge.status().releasedParks).toBe(1);
		// After recovery, released-parks in A's root becomes a symlink.
		const parksDir = join(rootA, "released-parks");
		const moved = `${parksDir}-moved`;
		renameSync(parksDir, moved);
		symlinkSync(moved, parksDir);
		const target = String(parkRepo.parks.get(p.turnId)?.sessionPath).replace(
			parksDir,
			moved,
		);
		expect(existsSync(target)).toBe(true);
		const response = answer(b, p, results(p));
		const q2 = await b.sdk.next();
		// Not resumed through the link: a flattened rebuild instead.
		expect(q2.options.resume).toBeUndefined();
		q2.emit(
			initMessage(),
			...streamedMessage([{ type: "text", text: "rebuilt" }]),
			resultMessage(),
		);
		expect((await reply(response)).status).toBe(200);
		// The park's record is gone, but nothing was deleted through the link.
		await waitFor(() => !parkRepo.parks.has(p.turnId), 3_000);
		expect(existsSync(target)).toBe(true);
	});

	it("fences the original turn from its first release on, queued writes included", async () => {
		const h = await releaseHarness();
		let letGo!: () => void;
		h.parkRepo.hold.markReleased = new Promise((resolve) => {
			letGo = resolve;
		});
		const p = await parkTurn(h);
		await waitFor(() => h.parkRepo.calls.includes("markReleased"), 5_000);
		// Another process takes the lease while the release waits.
		await h.parkRepo.acquireLease(
			{ dir: "/elsewhere", pid: 1, startTime: null, token: "other", at: 1 },
			() => true,
		);
		const roundsBefore = h.repo.turns.get(p.turnId)?.counters.toolRounds;
		letGo();
		await waitFor(
			() => h.bridge.status().counters.releaseFailures === 1,
			5_000,
		);
		await Bun.sleep(50);
		// The failed release's finish, from the turn's original recorder,
		// changed nothing: the new holder decides this turn.
		const turn = h.repo.turns.get(p.turnId);
		expect(turn?.status).toBe("running");
		expect(turn?.finishedAt).toBeUndefined();
		expect(turn?.counters.toolRounds).toBe(roundsBefore);
	});

	it("answers 503 for unmatched results while it recovers after another holder exits", async () => {
		const repo = memoryTurnRepo();
		const parkRepo = memoryParkRepo(repo.turns);
		const holder = await releaseHarness({ repo, parkRepo, keep: true });
		const p = await parkTurn(holder);
		await released(holder, p);
		const b = await releaseHarness({
			repo,
			parkRepo,
			timing: { maintenanceIntervalMs: 30 },
		});
		expect(b.bridge.status().releaseBlocked).toContain("database");
		// While it takes over, its recovery waits on the database.
		let letGo!: () => void;
		parkRepo.hold.list = new Promise((resolve) => {
			letGo = resolve;
		});
		await holder.bridge.dispose();
		await waitFor(
			() => parkRepo.calls.includes("list") && parkRepo.lease !== null,
			3_000,
		);
		const found = b.bridge.findContinuation(p.ids, {
			apiKeyId: "key-1",
			model: MODEL,
		});
		expect(found).toMatchObject({ retryAfter: "5" });
		letGo();
		await waitFor(
			() =>
				turnIdOf(
					b.bridge.findContinuation(p.ids, { apiKeyId: "key-1", model: MODEL }),
				) === p.turnId,
			3_000,
		);
		expect(b.bridge.status().releaseBlocked).toBeNull();
	});
});
