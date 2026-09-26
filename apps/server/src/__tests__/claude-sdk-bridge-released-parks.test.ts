/**
 * Released parks through the proxy: a /wire/openai turn parks on a client
 * tool call, is released into the gateway's own database and work root, and
 * the client's results, sent like any request, reach the stored park through
 * continueParkedSdkBridgeTurn. Claude Code is the scripted fake (a real
 * child process per query, so the release's SIGTERM is real); the bridge,
 * proxy, adapters and repositories are real.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assistantMessage,
	streamedMessage,
} from "../../../../packages/claude-sdk-bridge/src/__tests__/fixtures/fake-sdk";
import { startMockUpstream } from "../../../../packages/claude-sdk-bridge/src/__tests__/fixtures/mock-upstream";
import {
	callModel,
	type FakeQuery,
	fakeQueryFn,
	relay,
} from "./fixtures/scripted-claude-code";
import { type Gateway, startGateway } from "./fixtures/sdk-bridge-gateway";

const MODEL = "claude-sonnet-5";
const OTHER_MODEL = "claude-opus-5";

async function waitFor(
	check: () => boolean | Promise<boolean>,
	ms = 5_000,
): Promise<void> {
	const until = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > until) throw new Error("waitFor timed out");
		await Bun.sleep(20);
	}
}

const mock = startMockUpstream();
afterAll(() => mock.stop());

interface Harness {
	gw: Gateway;
	sdk: ReturnType<typeof fakeQueryFn>;
	root: string;
}

let current: Harness | null = null;
afterEach(async () => {
	if (!current) return;
	const { gw, root } = current;
	current = null;
	await gw.stop();
	expect(gw.blockedEgress.filter((h) => /anthropic|claude/i.test(h))).toEqual(
		[],
	);
	rmSync(root, { recursive: true, force: true });
});

async function harness(): Promise<Harness> {
	const sdk = fakeQueryFn({ process: "normal" });
	const root = mkdtempSync(join(tmpdir(), "cmx-bridge-released-"));
	const n = crypto.randomUUID().slice(0, 8);
	const gw = await startGateway({
		root,
		upstreamUrl: mock.url,
		accounts: [
			{
				id: `acct-a-${n}`,
				name: `claude-a-${n}`,
				token: `sk-ant-oat01-ACCT-A-${n}`,
			},
		],
		models: [MODEL, OTHER_MODEL],
		releasedParks: true,
		bridge: {
			queryFn: sdk.fn,
			claudeExecutablePath: "/opt/fake/claude",
			limits: () => ({ parkReleaseMs: 100 }),
			timing: {
				headHoldMs: 2_000,
				pingIntervalMs: 500,
				settleWaitMs: 500,
				idleTimeoutMs: 20_000,
				exitGraceMs: 50,
			},
		},
	});
	current = { gw, sdk, root };
	return current;
}

const tools = [
	{
		type: "function",
		name: "read",
		parameters: { type: "object", properties: {} },
	},
];
const user = {
	type: "message",
	role: "user",
	content: [{ type: "input_text", text: "read a" }],
};

async function post(gw: Gateway, model: string, input: unknown[]) {
	const response = await fetch(`${gw.url}/wire/openai/v1/responses`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${gw.apiKey}`,
			"content-type": "application/json",
			"user-agent": "opencode/1.14.0",
		},
		body: JSON.stringify({ model, stream: false, tools, input }),
	});
	return { status: response.status, body: await response.json() };
}

/** A turn parked on `toolu_gw_r`, then released into the database. */
async function releasedTurn(h: Harness) {
	const first = post(h.gw, MODEL, [user]);
	const parked = await h.sdk.next();
	await parked.nextPrompt();
	const call = {
		type: "tool_use",
		id: "toolu_gw_r",
		name: String(parked.options.allowedTools?.[0]),
		input: {},
	};
	parked.emit(...streamedMessage([call as never], { id: "msg_gw_r" }));
	// Claude Code's envelope for the call, after message_stop.
	parked.emit(
		assistantMessage([call], { id: "msg_gw_r", stopReason: "tool_use" }),
	);
	void parked.callTool(
		"toolu_gw_r",
		String(call.name).slice("mcp__c__".length),
	);
	const r1 = await first;
	expect(r1.status).toBe(200);
	let park: { turn_id: string; resume_at: string } | undefined;
	await waitFor(async () => {
		[park] = await h.gw.query<{ turn_id: string; resume_at: string }>(
			"SELECT turn_id, resume_at FROM sdk_bridge_released_parks WHERE state = 'released'",
		);
		return park !== undefined;
	}, 8_000);
	const history = [
		user,
		...r1.body.output,
		{ type: "function_call_output", call_id: "toolu_gw_r", output: "A" },
	];
	return {
		parked,
		history,
		park: park as { turn_id: string; resume_at: string },
	};
}

async function turnStatus(gw: Gateway, id: string): Promise<string> {
	const [row] = await gw.query<{ status: string }>(
		"SELECT status FROM sdk_bridge_turns WHERE id = ?",
		[id],
	);
	return String(row?.status);
}

describe("released parks through the proxy", () => {
	it("resumes the stored park at its call when the results arrive, and refuses a replay", async () => {
		const h = await harness();
		const { history, park } = await releasedTurn(h);
		expect(await turnStatus(h.gw, park.turn_id)).toBe("released");

		const second = post(h.gw, MODEL, history);
		const resumed: FakeQuery = await h.sdk.next();
		expect(resumed.options.resume).toBeString();
		expect(resumed.options.resumeSessionAt).toBe(park.resume_at);
		await resumed.nextPrompt();
		expect(resumed.prompts[0]?.message.content).toEqual([
			{ type: "tool_result", tool_use_id: "toolu_gw_r", content: "A" },
		]);

		// A replay while the resume runs is refused, and starts nothing.
		const replay = await post(h.gw, MODEL, history);
		expect(replay.status).toBe(409);
		expect(h.sdk.queries.length).toBe(2);

		await relay(resumed, await callModel(resumed));
		const r2 = await second;
		expect(r2.status).toBe(200);
		await waitFor(
			async () => (await turnStatus(h.gw, park.turn_id)) === "completed",
		);
		expect(
			await h.gw.query("SELECT turn_id FROM sdk_bridge_released_parks"),
		).toEqual([]);
	});

	it("ends the park when the results name another model, and starts a fresh turn", async () => {
		const h = await harness();
		const { history, park } = await releasedTurn(h);
		const second = post(h.gw, OTHER_MODEL, history);
		const fresh = await h.sdk.next();
		expect(fresh.options.resume).toBeUndefined();
		await fresh.nextPrompt();
		await relay(fresh, await callModel(fresh));
		expect((await second).status).toBe(200);
		expect(await turnStatus(h.gw, park.turn_id)).toBe("aborted");
		expect(
			await h.gw.query("SELECT turn_id FROM sdk_bridge_released_parks"),
		).toEqual([]);
		await waitFor(async () => {
			const rows = await h.gw.query<{ rebuild_reason: string | null }>(
				"SELECT rebuild_reason FROM sdk_bridge_turns WHERE status = 'completed'",
			);
			return rows[0]?.rebuild_reason === "dead_continuation";
		});
	});
});
