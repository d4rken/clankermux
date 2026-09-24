/**
 * pi's system prompt through the public /wire/openai endpoints to the options
 * Claude Code starts with. pi sends its prompt as instruction messages (one
 * leading, one per later section update); the Responses and Chat adapters
 * fold them into the Messages `system`, and the bridge projects that. The
 * cases assert the exact `append`, so an adapter that joined or trimmed the
 * messages differently would fail here rather than shift what is forwarded.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	resultMessage,
	streamedMessage,
} from "../../../../packages/claude-sdk-bridge/src/__tests__/fixtures/fake-sdk";
import { startMockUpstream } from "../../../../packages/claude-sdk-bridge/src/__tests__/fixtures/mock-upstream";
import {
	expectedAppend,
	loadPiPromptFixtures,
	type PiPromptFixture,
} from "../../../../packages/claude-sdk-bridge/src/__tests__/fixtures/pi-prompt-fixtures";
import { fakeQueryFn } from "./fixtures/scripted-claude-code";
import { type Gateway, startGateway } from "./fixtures/sdk-bridge-gateway";

const MODEL = "claude-sonnet-5";
/** pi 0.87's user agent through its clankermux provider, as recorded live. */
const PI_USER_AGENT = "pi (linux 6.12.101+deb13-amd64; x64)";

const mock = startMockUpstream();
afterAll(() => mock.stop());

type Endpoint = "responses" | "chat";

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
	const root = mkdtempSync(join(tmpdir(), "cmx-bridge-pi-prompt-"));
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
	current = { gw, sdk, root };
	return current;
}

/**
 * The request pi makes: its leading system message first; a later section
 * update where pi's transcript has it, after the turn it followed. The Chat
 * adapter takes instruction messages only before the conversation, so there
 * they all lead.
 */
function send(
	gw: Gateway,
	endpoint: Endpoint,
	f: PiPromptFixture,
	headers: Record<string, string> = { "x-clankermux-pi-prompt": "0.87" },
): Promise<Response> {
	const [leading, ...updates] = f.messages;
	const instruction = (text: string) =>
		endpoint === "chat"
			? { role: "system", content: text }
			: { type: "message", role: "developer", content: text };
	const user = (text: string) =>
		endpoint === "chat"
			? { role: "user", content: text }
			: {
					type: "message",
					role: "user",
					content: [{ type: "input_text", text }],
				};
	const assistant = (text: string) =>
		endpoint === "chat"
			? { role: "assistant", content: text }
			: {
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text }],
				};
	const later = updates.length
		? endpoint === "chat"
			? [assistant("hi"), user("again")]
			: [assistant("hi"), ...updates.map(instruction), user("again")]
		: [];
	const history = [
		instruction(leading ?? ""),
		...(endpoint === "chat" ? updates.map(instruction) : []),
		user("hello"),
		...later,
	];
	return fetch(
		`${gw.url}/wire/openai/v1/${endpoint === "chat" ? "chat/completions" : "responses"}`,
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${gw.apiKey}`,
				"content-type": "application/json",
				"user-agent": PI_USER_AGENT,
				...headers,
			},
			body: JSON.stringify({
				model: MODEL,
				stream: false,
				...(endpoint === "chat" ? { messages: history } : { input: history }),
			}),
		},
	);
}

const fixtures = loadPiPromptFixtures("0.87");
const byName = (name: string): PiPromptFixture => {
	const found = fixtures.find((f) => f.name === name);
	if (!found) throw new Error(`no fixture ${name}`);
	return found;
};

async function turnRow(gw: Gateway) {
	const [row] = await gw.query<{
		status: string;
		system_prompt_policy: string;
		system_prompt_detail: string | null;
	}>(
		"SELECT status, system_prompt_policy, system_prompt_detail FROM sdk_bridge_turns",
	);
	return row;
}

for (const endpoint of ["responses", "chat"] as const)
	describe(`pi's system prompt at /wire/openai ${endpoint}`, () => {
		for (const name of [
			"stock-all",
			"context-verbatim",
			"subagent-persona",
			"forced-prompt",
			"stock-extension-section",
			"forced-claude-context-and-agents",
			"section-update",
			"update-tools-and-skills",
		])
			it(`${name}: Claude Code starts with pi's prompt minus its head appended, byte for byte`, async () => {
				const h = await harness();
				const f = byName(name);
				const pending = send(h.gw, endpoint, f);
				const query = await h.sdk.next();
				expect(query.options.systemPrompt).toEqual({
					type: "preset",
					preset: "claude_code",
					append: expectedAppend(f) as string,
					snapshot: false,
				});
				query.emit(
					...streamedMessage([{ type: "text", text: "ok" }]),
					resultMessage(),
				);
				query.end();
				expect((await pending).status).toBe(200);
				const row = await turnRow(h.gw);
				expect(row?.system_prompt_policy).toBe("pi-head-v1");
				expect(JSON.parse(row?.system_prompt_detail ?? "null")).toMatchObject({
					outcome: "forwarded",
					version: "0.87",
				});
			});

		it("refuses a pi turn without the layout header with a named 400", async () => {
			const h = await harness();
			const f = byName("stock-all");
			const response = await send(h.gw, endpoint, f, {});
			expect(response.status).toBe(400);
			const body = (await response.json()) as {
				error: { type: string; code: string; message: string };
			};
			expect(body.error).toMatchObject({
				type: "invalid_request_error",
				code: "sdk_bridge_prompt_unsupported",
			});
			expect(body.error.message).toContain("x-clankermux-pi-prompt");
			expect(h.sdk.queries).toEqual([]);
			const row = await turnRow(h.gw);
			expect(row).toMatchObject({
				status: "rejected",
				system_prompt_policy: "pi-head-v1",
			});
			expect(JSON.parse(row?.system_prompt_detail ?? "null")).toMatchObject({
				outcome: "refused",
				reason: "missing_version",
				promptLength: f.system.length,
			});
			expect(row?.system_prompt_detail).not.toContain("expert coding");
		});

		it("refuses a malformed pi prompt with its code", async () => {
			const h = await harness();
			const response = await send(
				h.gw,
				endpoint,
				byName("context-closes-docs"),
			);
			expect(response.status).toBe(400);
			expect(
				((await response.json()) as { error: { code: string } }).error.code,
			).toBe("sdk_bridge_prompt_malformed");
			expect(h.sdk.queries).toEqual([]);
		});
	});
