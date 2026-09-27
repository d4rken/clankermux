/**
 * `x-clankermux-sdk-bridge-history` as a client sees it at the public
 * /wire/openai endpoints, Responses and Chat Completions: how each turn's
 * conversation reached Claude Code. Claude Code is the scripted fake; the
 * bridge, proxy and adapters are real.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionStore } from "@anthropic-ai/claude-agent-sdk";
import {
	assistantMessage,
	initMessage,
	resultMessage,
	streamedMessage,
} from "../../../../packages/claude-sdk-bridge/src/__tests__/fixtures/fake-sdk";
import { startMockUpstream } from "../../../../packages/claude-sdk-bridge/src/__tests__/fixtures/mock-upstream";
import { loadPiPromptFixture } from "../../../../packages/claude-sdk-bridge/src/__tests__/fixtures/pi-prompt-fixtures";
import { type FakeQuery, fakeQueryFn } from "./fixtures/scripted-claude-code";
import { type Gateway, startGateway } from "./fixtures/sdk-bridge-gateway";

const MODEL = "claude-sonnet-5";
const HEADER = "x-clankermux-sdk-bridge-history";
const PI_SYSTEM = loadPiPromptFixture("0.87", "stock-all");

const mock = startMockUpstream();
afterAll(() => mock.stop());

type Endpoint = "responses" | "chat";
type Turn = ["user" | "assistant", string];

interface Harness {
	gw: Gateway;
	sdk: ReturnType<typeof fakeQueryFn>;
	root: string;
	accounts: [string, string];
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
	const root = mkdtempSync(join(tmpdir(), "cmx-bridge-history-"));
	const n = crypto.randomUUID().slice(0, 8);
	const accounts: [string, string] = [`acct-a-${n}`, `acct-b-${n}`];
	const gw = await startGateway({
		root,
		upstreamUrl: mock.url,
		accounts: accounts.map((id) => ({
			id,
			name: id.replace("acct", "claude"),
			token: `sk-ant-oat01-${id.toUpperCase()}`,
		})),
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
	current = { gw, sdk, root, accounts };
	return current;
}

function body(endpoint: Endpoint, turns: Turn[], stream: boolean) {
	if (endpoint === "chat")
		return {
			model: MODEL,
			stream,
			messages: [
				{ role: "system", content: PI_SYSTEM.system },
				...turns.map(([role, content]) => ({ role, content })),
			],
		};
	return {
		model: MODEL,
		stream,
		store: false,
		input: [
			{ type: "message", role: "developer", content: PI_SYSTEM.system },
			...turns.map(([role, text]) => ({
				type: "message",
				role,
				content: [
					{ type: role === "user" ? "input_text" : "output_text", text },
				],
			})),
		],
	};
}

function send(
	h: Harness,
	endpoint: Endpoint,
	turns: Turn[],
	opts: { stream?: boolean; account?: string } = {},
): Promise<Response> {
	return fetch(
		`${h.gw.url}/wire/openai/v1/${endpoint === "chat" ? "chat/completions" : "responses"}`,
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${h.gw.apiKey}`,
				"content-type": "application/json",
				"user-agent": "pi (linux 6.12.101+deb13-amd64; x64)",
				"session-id": "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c",
				"x-clankermux-pi-prompt": "0.87",
				...(opts.account ? { "x-clankermux-account-id": opts.account } : {}),
			},
			body: JSON.stringify(body(endpoint, turns, opts.stream ?? true)),
		},
	);
}

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

/** One user turn, answered "echo"; the response's status and header. */
async function answered(
	h: Harness,
	endpoint: Endpoint,
	turns: Turn[],
	opts: { stream?: boolean; account?: string } = {},
) {
	const pending = send(h, endpoint, turns, opts);
	const query = await h.sdk.next();
	await mirror(query, turns.at(-1)?.[1] ?? "");
	query.emit(
		initMessage(),
		...streamedMessage([{ type: "text", text: "echo" }]),
		resultMessage(),
	);
	const res = await pending;
	const contentType = res.headers.get("content-type") ?? "";
	const text = await res.text();
	// Let the turn settle before the conversation's next one.
	await Bun.sleep(100);
	return {
		status: res.status,
		contentType,
		history: res.headers.get(HEADER),
		requestId: res.headers.get("x-clankermux-request-id"),
		text,
	};
}

async function turnRows(gw: Gateway) {
	return gw.query<{
		history_mode: string;
		rebuild_reason: string | null;
		account_id: string;
	}>(
		"SELECT history_mode, rebuild_reason, account_id FROM sdk_bridge_turns ORDER BY started_at, rowid",
	);
}

for (const endpoint of ["responses", "chat"] as const)
	describe(`${HEADER} at /wire/openai ${endpoint}`, () => {
		it("reports fresh, resume, a rebuild with its reason and an account change", async () => {
			const h = await harness();
			const [a, b] = h.accounts;

			const first: Turn[] = [["user", "hello"]];
			const fresh = await answered(h, endpoint, first, { account: a });
			expect(fresh.status).toBe(200);
			expect(fresh.contentType).toContain("text/event-stream");
			expect(fresh.history).toBe("fresh");
			expect(fresh.requestId).toBeTruthy();

			// JSON, not a stream: the header rides on it too.
			const second: Turn[] = [
				...first,
				["assistant", "echo"],
				["user", "again"],
			];
			const resumed = await answered(h, endpoint, second, {
				stream: false,
				account: a,
			});
			expect(resumed.status).toBe(200);
			expect(resumed.contentType).toContain("application/json");
			expect(resumed.history).toBe("resume");

			// The client rewrote the last answer before its next message.
			const edited: Turn[] = [
				...second,
				["assistant", "an edited answer"],
				["user", "third"],
			];
			const rebuilt = await answered(h, endpoint, edited, { account: a });
			expect(rebuilt.history).toBe("rebuild_transcript; reason=edit");

			const moved = await answered(
				h,
				endpoint,
				[...edited, ["assistant", "echo"], ["user", "on the other account"]],
				{ account: b },
			);
			expect(moved.history).toBe("resume; reason=account_change");

			expect(await turnRows(h.gw)).toEqual([
				{ history_mode: "fresh", rebuild_reason: null, account_id: a },
				{ history_mode: "resume", rebuild_reason: null, account_id: a },
				{
					history_mode: "rebuild_transcript",
					rebuild_reason: "edit",
					account_id: a,
				},
				{
					history_mode: "resume",
					rebuild_reason: "account_change",
					account_id: b,
				},
			]);
		});

		it("rides on an error the turn answers", async () => {
			const h = await harness();
			const pending = send(h, endpoint, [["user", "hello"]]);
			const query = await h.sdk.next();
			query.emit(
				initMessage(),
				assistantMessage([{ type: "text", text: "API Error: 500" }], {
					error: "unknown",
				}),
				resultMessage({ isError: true, result: "API Error: 500" }),
			);
			const res = await pending;
			expect(res.status).toBe(502);
			expect(res.headers.get("content-type")).toContain("application/json");
			expect(res.headers.get(HEADER)).toBe("fresh");
			expect(res.headers.get("x-clankermux-request-id")).toBeTruthy();
		});
	});
