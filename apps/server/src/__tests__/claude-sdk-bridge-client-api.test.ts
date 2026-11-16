/**
 * A request served through Claude Code, read back through `/client/v1` the
 * way an external client reads its own accounting: under the id it was
 * handed in `x-clankermux-request-id`, and by its correlation tag. Claude
 * Code is the scripted stand-in, whose model calls go through the real proxy
 * to the loopback mock upstream, so the sums come from real inner rows.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	initMessage,
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
const ALIAS = "alias:balanced";
const REQUEST_ID = "x-clankermux-request-id";
const TAG = "x-clankermux-correlation-tag";

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
	const sdk = fakeQueryFn();
	const root = mkdtempSync(join(tmpdir(), "cmx-bridge-client-api-"));
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
		models: [MODEL],
		bridge: {
			queryFn: sdk.fn,
			claudeExecutablePath: "/opt/fake/claude",
			timing: {
				headHoldMs: 2_000,
				pingIntervalMs: 500,
				settleWaitMs: 500,
				idleTimeoutMs: 20_000,
				exitGraceMs: 50,
			},
		},
	});
	await gw.dbOps.modelAliases.save({
		id: ALIAS,
		displayName: "Balanced",
		revision: 0,
		targets: [{ model: MODEL, accountIds: null }],
	});
	current = { gw, sdk, root };
	return current;
}

/** A client's Messages request, as an external program sends it. */
function send(
	gw: Gateway,
	body: Record<string, unknown>,
	tag: string | null,
): Promise<Response> {
	return fetch(`${gw.url}/wire/anthropic/v1/messages`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${gw.apiKey}`,
			"content-type": "application/json",
			"user-agent": "cnc-control/1.0",
			...(tag ? { [TAG]: tag } : {}),
		},
		body: JSON.stringify({ model: ALIAS, max_tokens: 256, ...body }),
	});
}

async function read(
	gw: Gateway,
	path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const res = await fetch(`${gw.url}${path}`, {
		headers: { authorization: `Bearer ${gw.apiKey}` },
	});
	return { status: res.status, body: (await res.json()) as never };
}

/** The request once its accounting is final. */
async function finalized(gw: Gateway, id: string) {
	const until = Date.now() + 8_000;
	for (;;) {
		const { status, body } = await read(gw, `/client/v1/requests/${id}`);
		if (status === 200 && body.finalized === true) return body;
		if (Date.now() > until)
			throw new Error(`never finalized: ${status} ${JSON.stringify(body)}`);
		await Bun.sleep(25);
	}
}

async function tagged(gw: Gateway, tag: string): Promise<string[]> {
	const { body } = await read(gw, `/client/v1/requests?tag=${tag}`);
	return (body.requests as Array<{ id: string }>).map((r) => r.id);
}

/** Usage the mock reports for every call whose body names `marker`. */
function usage(marker: string, input: number, output: number): void {
	mock.addRule({
		marker,
		shape: {
			usage: {
				input_tokens: input,
				output_tokens: output,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		},
	});
}

/** One of Claude Code's model calls, its answer read and dropped. */
async function call(query: FakeQuery, marker: string): Promise<void> {
	const res = await callModel(query, {
		messages: [{ role: "user", content: `hello ${marker}` }],
	});
	await res.text();
}

describe("a request served through Claude Code, read through the client API", () => {
	it("answers the id the client was handed, with the alias it asked for and its model calls summed", async () => {
		const { gw, sdk } = await harness();
		const marker = `M${crypto.randomUUID().slice(0, 8)}`;
		usage(marker, 11, 7);
		const pending = send(
			gw,
			{ messages: [{ role: "user", content: `hello ${marker}` }] },
			"run-1",
		);
		const query = await sdk.next();
		await call(query, marker);
		await relay(
			query,
			await callModel(query, {
				messages: [{ role: "user", content: `hello ${marker}` }],
			}),
		);
		const res = await pending;
		expect(res.status).toBe(200);
		await res.text();
		const id = res.headers.get(REQUEST_ID) ?? "";

		expect(await finalized(gw, id)).toMatchObject({
			id,
			statusCode: 200,
			requestedModel: ALIAS,
			model: MODEL,
			inputTokens: 22,
			outputTokens: 14,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			usageSource: "provider",
			correlationTag: "run-1",
			apiKeyId: gw.apiKeyId,
		});
		const inner = await gw.query<{ id: string }>(
			"SELECT id FROM requests WHERE sdk_bridge_leg_id = ?",
			[id],
		);
		expect(inner).toHaveLength(2);
		for (const row of inner)
			expect((await read(gw, `/client/v1/requests/${row.id}`)).status).toBe(
				404,
			);
		expect(await tagged(gw, "run-1")).toEqual([id]);
	});

	it("reads a tool round as two requests, each with its own model call", async () => {
		const { gw, sdk } = await harness();
		const marker = `M${crypto.randomUUID().slice(0, 8)}`;
		usage(marker, 5, 3);
		const tools = [
			{
				name: "read",
				description: "Read a file",
				input_schema: { type: "object", properties: {} },
			},
		];
		const first = { role: "user", content: `read a ${marker}` };
		const pending = send(gw, { tools, messages: [first] }, "round");
		const query = await sdk.next();
		await call(query, marker);
		const toolUse = {
			type: "tool_use" as const,
			id: "toolu_round",
			name: String(query.options.allowedTools?.[0]),
			input: {},
		};
		query.emit(initMessage(), ...streamedMessage([toolUse]));
		const answered = query.callTool("toolu_round", "read");
		const r1 = await pending;
		expect(r1.status).toBe(200);
		const r1Body = await r1.text();
		const id1 = r1.headers.get(REQUEST_ID) ?? "";
		expect(r1Body).toContain("toolu_round");

		const second = send(
			gw,
			{
				tools,
				messages: [
					first,
					{
						role: "assistant",
						content: [{ ...toolUse, name: "read" }],
					},
					{
						role: "user",
						content: [
							{ type: "tool_result", tool_use_id: "toolu_round", content: "A" },
						],
					},
				],
			},
			"round",
		);
		await answered;
		await relay(
			query,
			await callModel(query, {
				messages: [{ role: "user", content: `again ${marker}` }],
			}),
		);
		const r2 = await second;
		expect(r2.status).toBe(200);
		await r2.text();
		const id2 = r2.headers.get(REQUEST_ID) ?? "";

		expect(await finalized(gw, id1)).toMatchObject({
			inputTokens: 5,
			outputTokens: 3,
		});
		expect(await finalized(gw, id2)).toMatchObject({
			inputTokens: 5,
			outputTokens: 3,
		});
		expect(await tagged(gw, "round")).toEqual([id1, id2]);
	});

	it("pages bridged and direct requests of one tag together", async () => {
		const { gw, sdk } = await harness();
		const marker = `M${crypto.randomUUID().slice(0, 8)}`;
		const pending = send(
			gw,
			{ messages: [{ role: "user", content: `hello ${marker}` }] },
			"mixed",
		);
		const query = await sdk.next();
		await relay(
			query,
			await callModel(query, {
				messages: [{ role: "user", content: `hello ${marker}` }],
			}),
		);
		const res = await pending;
		await res.text();
		const bridged = res.headers.get(REQUEST_ID) ?? "";
		const leg = await finalized(gw, bridged);
		for (const [id, at] of [
			["direct-before", Number(leg.timestamp) - 1],
			["direct-after", Number(leg.timestamp) + 1],
		] as const)
			await gw.dbOps.getAdapter().run(
				`INSERT INTO requests (id, timestamp, method, path, api_key_id, correlation_tag)
					VALUES (?, ?, 'POST', '/v1/messages', ?, 'mixed')`,
				[id, at, gw.apiKeyId],
			);

		const seen: string[] = [];
		let after: string | null = null;
		for (;;) {
			const { body } = await read(
				gw,
				`/client/v1/requests?tag=mixed&limit=1${after ? `&after=${after}` : ""}`,
			);
			seen.push(...(body.requests as Array<{ id: string }>).map((r) => r.id));
			after = body.next as string | null;
			if (!after) break;
		}
		expect(seen).toEqual(["direct-before", bridged, "direct-after"]);
	});

	it("records tool results the bridge could not take yet under the client's id", async () => {
		const { gw } = await harness();
		const transport = gw.proxyContext.sdkBridge;
		if (!transport) throw new Error("no bridge");
		gw.proxyContext.sdkBridge = {
			...transport,
			findContinuation: () => ({ unavailable: "recovering", retryAfter: "3" }),
		};
		const res = await send(
			gw,
			{
				messages: [
					{ role: "user", content: "read a" },
					{
						role: "assistant",
						content: [
							{ type: "tool_use", id: "toolu_x", name: "read", input: {} },
						],
					},
					{
						role: "user",
						content: [
							{ type: "tool_result", tool_use_id: "toolu_x", content: "A" },
						],
					},
				],
			},
			"waiting",
		);
		expect(res.status).toBe(503);
		await res.text();
		const id = res.headers.get(REQUEST_ID) ?? "";

		expect(await finalized(gw, id)).toMatchObject({
			id,
			statusCode: 503,
			correlationTag: "waiting",
		});
		expect(await tagged(gw, "waiting")).toEqual([id]);
	});
});
