/**
 * pi's side requests (recap, session title) through the public /wire/openai
 * endpoints: the main turn's body replayed with its reply and one new prompt,
 * `tool_choice: "none"`, a text format and a capped output, under the main
 * turn's session header and `x-clankermux-side-request: session-fork-v1`.
 * Claude Code is the scripted fake; the bridge, proxy and adapters are real.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionStore } from "@anthropic-ai/claude-agent-sdk";
import {
	initMessage,
	resultMessage,
	streamedMessage,
} from "../../../../packages/claude-sdk-bridge/src/__tests__/fixtures/fake-sdk";
import { startMockUpstream } from "../../../../packages/claude-sdk-bridge/src/__tests__/fixtures/mock-upstream";
import {
	expectedAppend,
	loadPiPromptFixture,
} from "../../../../packages/claude-sdk-bridge/src/__tests__/fixtures/pi-prompt-fixtures";
import { type FakeQuery, fakeQueryFn } from "./fixtures/scripted-claude-code";
import { type Gateway, startGateway } from "./fixtures/sdk-bridge-gateway";

const MODEL = "claude-sonnet-5";
const PI_USER_AGENT = "pi (linux 6.12.101+deb13-amd64; x64)";
const SESSION = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const RECAP_PROMPT =
	"Give the returning user a session recap in fewer than 40 words.";
const PI_SYSTEM = loadPiPromptFixture("0.87", "stock-all");

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
	const root = mkdtempSync(join(tmpdir(), "cmx-bridge-side-"));
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

/** pi's conversation in one dialect: its prompt, then user and assistant text. */
function items(
	endpoint: Endpoint,
	turns: Array<["user" | "assistant", string]>,
) {
	const system =
		endpoint === "chat"
			? { role: "system", content: PI_SYSTEM.system }
			: { type: "message", role: "developer", content: PI_SYSTEM.system };
	return [
		system,
		...turns.map(([role, text]) =>
			endpoint === "chat"
				? { role, content: text }
				: {
						type: "message",
						role,
						content: [
							{
								type: role === "user" ? "input_text" : "output_text",
								text,
							},
						],
					},
		),
	];
}

const READ = {
	name: "read",
	description: "Read a file",
	parameters: {
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
	},
};

/**
 * A main turn's body, and with `recap` what pi's recapPayload makes of it:
 * the reply and the prompt appended, tool_choice none, a text format and
 * the output capped.
 */
function body(
	endpoint: Endpoint,
	turns: Array<["user" | "assistant", string]>,
	recap: boolean,
) {
	const history = items(endpoint, turns);
	if (endpoint === "chat")
		return {
			model: MODEL,
			stream: true,
			stream_options: { include_usage: true },
			messages: history,
			tools: [{ type: "function", function: READ }],
			...(recap
				? {
						tool_choice: "none",
						response_format: { type: "text" },
						max_tokens: 4096,
					}
				: {}),
		};
	return {
		model: MODEL,
		stream: true,
		store: false,
		prompt_cache_key: SESSION,
		input: history,
		tools: [{ type: "function", ...READ }],
		...(recap
			? {
					tool_choice: "none",
					text: { format: { type: "text" } },
					max_output_tokens: 4096,
				}
			: {}),
	};
}

function send(
	gw: Gateway,
	endpoint: Endpoint,
	payload: unknown,
	headers: Record<string, string> = {},
): Promise<Response> {
	return fetch(
		`${gw.url}/wire/openai/v1/${endpoint === "chat" ? "chat/completions" : "responses"}`,
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${gw.apiKey}`,
				"content-type": "application/json",
				"user-agent": PI_USER_AGENT,
				"session-id": SESSION,
				"x-clankermux-pi-prompt": "0.87",
				...headers,
			},
			body: JSON.stringify(payload),
		},
	);
}

const SIDE = { "x-clankermux-side-request": "session-fork-v1" };

/** What the real CLI does through `sessionStore.append`: mirror its transcript. */
async function mirror(query: FakeQuery, text: string) {
	const store = query.options.sessionStore as SessionStore;
	const sessionId = (query.options.sessionId ?? query.options.resume) as string;
	await store.append({ projectKey: "p", sessionId }, [
		{
			type: "user",
			sessionId,
			uuid: crypto.randomUUID(),
			message: { role: "user", content: text },
		},
	]);
}

/** The data payloads of an SSE body. */
function events(text: string): Array<Record<string, unknown>> {
	return text
		.split("\n\n")
		.map((frame) =>
			frame
				.split("\n")
				.find((line) => line.startsWith("data: "))
				?.slice(6),
		)
		.filter((data): data is string => !!data && data !== "[DONE]")
		.map((data) => JSON.parse(data) as Record<string, unknown>);
}

async function mainTurn(h: Harness, endpoint: Endpoint) {
	const pending = send(
		h.gw,
		endpoint,
		body(endpoint, [["user", "hello"]], false),
	);
	const query = await h.sdk.next();
	await mirror(query, "hello");
	query.emit(
		initMessage(),
		...streamedMessage([{ type: "text", text: "echo: hello" }]),
		resultMessage(),
	);
	const res = await pending;
	expect(res.status).toBe(200);
	await res.text();
	return query;
}

async function turnRows(gw: Gateway) {
	return gw.query<{ kind: string; status: string; history_mode: string }>(
		"SELECT kind, status, history_mode FROM sdk_bridge_turns ORDER BY started_at, rowid",
	);
}

for (const endpoint of ["responses", "chat"] as const)
	describe(`side requests at /wire/openai ${endpoint}`, () => {
		const recapTurns: Array<["user" | "assistant", string]> = [
			["user", "hello"],
			["assistant", "echo: hello"],
			["user", RECAP_PROMPT],
		];

		it("answers pi's recap on a copy of the session, with the main turn's tools and the cache reads", async () => {
			const h = await harness();
			const main = await mainTurn(h, endpoint);
			const pending = send(
				h.gw,
				endpoint,
				body(endpoint, recapTurns, true),
				SIDE,
			);
			const query = await h.sdk.next();
			expect(query.options.resume).toBeTruthy();
			expect(query.options.resume).not.toBe(main.options.sessionId);
			expect(query.options.tools).toEqual(main.options.tools);
			expect(query.options.allowedTools).toEqual(main.options.allowedTools);
			expect(query.options.allowedTools).toHaveLength(1);
			expect(Object.keys(query.options.mcpServers ?? {})).toEqual(
				Object.keys(main.options.mcpServers ?? {}),
			);
			expect(query.options.maxTurns).toBe(1);
			expect(query.options.model).toBe(MODEL);
			expect(query.options.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("4096");
			// pi's prompt policy applies as on the main turn.
			expect(query.options.systemPrompt).toEqual(main.options.systemPrompt);
			expect((query.options.systemPrompt as { append?: string }).append).toBe(
				expectedAppend(PI_SYSTEM) as string,
			);
			expect(query.prompts[0]?.message.content).toEqual([
				{ type: "text", text: RECAP_PROMPT },
			]);
			query.emit(
				initMessage(),
				...streamedMessage([{ type: "text", text: "You greeted me." }], {
					usage: {
						input_tokens: 12,
						output_tokens: 1,
						cache_read_input_tokens: 9_000,
						cache_creation_input_tokens: 40,
					},
				}),
				resultMessage(),
			);
			const res = await pending;
			expect(res.status).toBe(200);
			const seen = events(await res.text());
			if (endpoint === "responses") {
				const completed = seen.find((e) => e.type === "response.completed")
					?.response as {
					output: Array<{ content?: Array<{ text: string }> }>;
					usage: {
						input_tokens: number;
						input_tokens_details: { cached_tokens: number };
					};
				};
				expect(completed.output.at(-1)?.content?.[0]?.text).toBe(
					"You greeted me.",
				);
				expect(completed.usage.input_tokens).toBe(9_052);
				expect(completed.usage.input_tokens_details.cached_tokens).toBe(9_000);
			} else {
				const text = seen
					.flatMap(
						(e) => (e.choices as Array<{ delta?: { content?: string } }>) ?? [],
					)
					.map((c) => c.delta?.content ?? "")
					.join("");
				expect(text).toBe("You greeted me.");
				const usage = seen.find((e) => e.usage)?.usage as {
					prompt_tokens_details: { cached_tokens: number };
				};
				expect(usage.prompt_tokens_details.cached_tokens).toBe(9_000);
			}
			await Bun.sleep(100);
			expect(await turnRows(h.gw)).toEqual([
				{ kind: "turn", status: "completed", history_mode: "fresh" },
				{ kind: "side_request", status: "completed", history_mode: "resume" },
			]);

			// The conversation's next turn still resumes the main turn's session.
			const next = send(
				h.gw,
				endpoint,
				body(
					endpoint,
					[
						["user", "hello"],
						["assistant", "echo: hello"],
						["user", "again"],
					],
					false,
				),
			);
			const third = await h.sdk.next();
			expect(third.options.resume).toBeTruthy();
			expect(third.options.resume).not.toBe(query.options.resume);
			third.emit(
				...streamedMessage([{ type: "text", text: "ok" }]),
				resultMessage(),
			);
			await (await next).text();
			const rows = await turnRows(h.gw);
			expect(rows.at(-1)).toMatchObject({
				kind: "turn",
				history_mode: "resume",
			});
		});

		it("refuses a recap whose history the stored session does not hold with a coded 409", async () => {
			const h = await harness();
			await mainTurn(h, endpoint);
			const res = await send(
				h.gw,
				endpoint,
				body(
					endpoint,
					[
						["user", "hello"],
						["assistant", "a reply pi never got"],
						["user", RECAP_PROMPT],
					],
					true,
				),
				SIDE,
			);
			expect(res.status).toBe(409);
			expect(
				((await res.json()) as { error: { code: string } }).error.code,
			).toBe("sdk_bridge_side_request_prefix_mismatch");
			expect(h.sdk.queries).toHaveLength(1);
		});

		it("refuses a recap in a conversation with no stored session with a coded 409", async () => {
			const h = await harness();
			const res = await send(
				h.gw,
				endpoint,
				body(endpoint, recapTurns, true),
				SIDE,
			);
			expect(res.status).toBe(409);
			expect(
				((await res.json()) as { error: { code: string } }).error.code,
			).toBe("sdk_bridge_side_request_no_session");
			expect(h.sdk.queries).toEqual([]);
		});

		it("refuses an unknown side-request mode with a coded 400", async () => {
			const h = await harness();
			const res = await send(
				h.gw,
				endpoint,
				body(endpoint, [["user", "hello"]], false),
				{ "x-clankermux-side-request": "session-fork-v2" },
			);
			expect(res.status).toBe(400);
			expect(
				((await res.json()) as { error: { code: string } }).error.code,
			).toBe("sdk_bridge_side_request_unknown");
			expect(h.sdk.queries).toEqual([]);
		});

		it("keeps tool_choice none refused without the header", async () => {
			const h = await harness();
			await mainTurn(h, endpoint);
			const res = await send(h.gw, endpoint, body(endpoint, recapTurns, true));
			expect(res.status).toBe(400);
			expect(JSON.stringify(await res.json())).toContain("tool_choice");
			expect(h.sdk.queries).toHaveLength(1);
		});
	});
