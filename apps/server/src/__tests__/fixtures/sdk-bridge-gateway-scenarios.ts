/**
 * Drives the real Claude Code binary through a composed ClankerMux gateway
 * (see sdk-bridge-gateway.ts) from the two OpenAI-dialect front doors, pi
 * style, and writes what happened to the JSON file named by argv[2].
 *
 * Only ever run inside a network namespace with nothing but loopback:
 *   unshare -rn sh -c 'ip link set lo up && bun sdk-bridge-gateway-scenarios.ts out.json'
 * It refuses to start when 1.1.1.1 is reachable.
 */
import { execFileSync } from "node:child_process";
import {
	lstatSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeSdkBridgeDeps } from "@clankermux/claude-sdk-bridge";
import { clearProviderOverloadCooldown } from "@clankermux/proxy";
import {
	type MockRequest,
	startMockUpstream,
} from "../../../../../packages/claude-sdk-bridge/src/__tests__/fixtures/mock-upstream";
import { type Gateway, startGateway } from "./sdk-bridge-gateway";

const out = process.argv[2];
if (!out) throw new Error("usage: sdk-bridge-gateway-scenarios.ts <out.json>");

const MODEL = "claude-sonnet-5";
const results: Record<string, unknown> = {};
const save = () => writeFileSync(out, JSON.stringify(results, null, 2));

let egressBlocked = false;
try {
	await fetch("https://1.1.1.1", { signal: AbortSignal.timeout(2_000) });
} catch {
	egressBlocked = true;
}
results.egressBlocked = egressBlocked;
save();
if (!egressBlocked) {
	console.error("network is reachable; refusing to start Claude Code");
	process.exit(2);
}

function childPids(): number[] {
	try {
		return execFileSync("pgrep", ["-P", String(process.pid)])
			.toString()
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(Number);
	} catch {
		return [];
	}
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
	const until = Date.now() + ms;
	while (!check()) {
		if (Date.now() > until) return false;
		await Bun.sleep(50);
	}
	return true;
}

const mock = startMockUpstream();

// ── pi-style clients ─────────────────────────────────────────────────────

type Endpoint = "responses" | "chat";

const READ_SCHEMA = {
	type: "object",
	properties: { path: { type: "string" } },
	required: ["path"],
};

interface Reply {
	status: number;
	requestId: string | null;
	retryAfter: string | null;
	text: string;
	/** Final assistant text. */
	answer: string;
	toolCalls: Array<{ id: string; name: string; arguments: string }>;
	finish: string | null;
	error: string | null;
	elapsedMs: number;
	finishedAt: number;
}

/** One conversation as a client keeps it, in its own dialect. */
class Conversation {
	readonly items: unknown[] = [];
	constructor(
		readonly endpoint: Endpoint,
		readonly session: string,
	) {}

	user(text: string): void {
		this.items.push(
			this.endpoint === "chat"
				? { role: "user", content: text }
				: {
						type: "message",
						role: "user",
						content: [{ type: "input_text", text }],
					},
		);
	}

	/** Record the reply as the client would, and answer its tool calls. */
	absorb(reply: Reply, toolOutput?: string): void {
		if (this.endpoint === "chat") {
			this.items.push({
				role: "assistant",
				content: reply.answer || null,
				...(reply.toolCalls.length
					? {
							tool_calls: reply.toolCalls.map((c) => ({
								id: c.id,
								type: "function",
								function: { name: c.name, arguments: c.arguments },
							})),
						}
					: {}),
			});
			for (const c of reply.toolCalls)
				this.items.push({
					role: "tool",
					tool_call_id: c.id,
					content: toolOutput ?? "",
				});
			return;
		}
		if (reply.answer)
			this.items.push({
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: reply.answer }],
			});
		for (const c of reply.toolCalls)
			this.items.push({
				type: "function_call",
				call_id: c.id,
				name: c.name,
				arguments: c.arguments,
			});
		for (const c of reply.toolCalls)
			this.items.push({
				type: "function_call_output",
				call_id: c.id,
				output: toolOutput ?? "",
			});
	}

	async send(
		gw: Gateway,
		signal?: AbortSignal,
	): Promise<Reply | { aborted: string }> {
		const t0 = Date.now();
		const chat = this.endpoint === "chat";
		const body = chat
			? {
					model: MODEL,
					stream: true,
					messages: this.items,
					tools: [
						{
							type: "function",
							function: {
								name: "read",
								description: "Read a file",
								parameters: READ_SCHEMA,
							},
						},
					],
				}
			: {
					model: MODEL,
					stream: true,
					input: this.items,
					tools: [
						{
							type: "function",
							name: "read",
							description: "Read a file",
							parameters: READ_SCHEMA,
						},
					],
				};
		let response: Response;
		let text: string;
		try {
			response = await fetch(
				`${gw.url}/wire/openai/v1/${chat ? "chat/completions" : "responses"}`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${gw.apiKey}`,
						"content-type": "application/json",
						"user-agent": "pi/0.86.0",
						"x-clankermux-pi-prompt": "0.87",
						session_id: this.session,
					},
					body: JSON.stringify(body),
					...(signal ? { signal } : {}),
				},
			);
			text = await response.text();
		} catch (error) {
			return { aborted: String(error) };
		}
		const reply: Reply = {
			status: response.status,
			requestId: response.headers.get("x-clankermux-request-id"),
			retryAfter: response.headers.get("retry-after"),
			text: text.slice(0, 4_000),
			answer: "",
			toolCalls: [],
			finish: null,
			error: null,
			elapsedMs: Date.now() - t0,
			finishedAt: Date.now(),
		};
		if (response.status !== 200) {
			reply.error = text.slice(0, 1_000);
			return reply;
		}
		const events = text
			.split("\n\n")
			.map((f) =>
				f
					.split("\n")
					.find((l) => l.startsWith("data: "))
					?.slice(6),
			)
			.filter((d): d is string => !!d && d !== "[DONE]")
			.map((d) => JSON.parse(d) as Record<string, unknown>);
		if (chat) {
			const calls = new Map<
				number,
				{ id: string; name: string; arguments: string }
			>();
			for (const e of events) {
				if (e.error) reply.error = JSON.stringify(e.error);
				const choice = (
					e.choices as Array<Record<string, unknown>> | undefined
				)?.[0];
				if (!choice) continue;
				const delta = choice.delta as {
					content?: string;
					tool_calls?: Array<{
						index: number;
						id?: string;
						function: { name?: string; arguments?: string };
					}>;
				};
				reply.answer += delta?.content ?? "";
				for (const c of delta?.tool_calls ?? []) {
					const call = calls.get(c.index) ?? {
						id: "",
						name: "",
						arguments: "",
					};
					if (c.id) call.id = c.id;
					if (c.function.name) call.name = c.function.name;
					call.arguments += c.function.arguments ?? "";
					calls.set(c.index, call);
				}
				if (choice.finish_reason) reply.finish = String(choice.finish_reason);
			}
			reply.toolCalls = [...calls.values()];
			return reply;
		}
		for (const e of events) {
			if (e.type === "response.failed" || e.type === "error")
				reply.error = JSON.stringify(e);
			if (e.type !== "response.completed") continue;
			const response = e.response as {
				status: string;
				output: Array<Record<string, unknown>>;
			};
			reply.finish = response.status;
			for (const item of response.output) {
				if (item.type === "message")
					reply.answer += (item.content as Array<{ text?: string }>)
						.map((c) => c.text ?? "")
						.join("");
				if (item.type === "function_call")
					reply.toolCalls.push({
						id: String(item.call_id),
						name: String(item.name),
						arguments: String(item.arguments),
					});
			}
		}
		return reply;
	}
}

// ── scenario plumbing ────────────────────────────────────────────────────

interface Account {
	id: string;
	name: string;
	token: string;
}

/** Every file under `dir`, relative, without following symlinks. */
function filesUnder(dir: string): string[] {
	const out: string[] = [];
	const walk = (path: string, rel: string) => {
		let names: string[] = [];
		try {
			names = readdirSync(path);
		} catch {
			return;
		}
		for (const name of names) {
			const child = join(path, name);
			if (lstatSync(child).isDirectory()) walk(child, `${rel}${name}/`);
			else out.push(`${rel}${name}`);
		}
	};
	walk(dir, "");
	return out;
}

async function withGateway<T>(
	name: string,
	run: (gw: Gateway, accounts: Account[]) => Promise<T>,
	bridge?: Partial<ClaudeSdkBridgeDeps>,
): Promise<void> {
	const n = crypto.randomUUID().slice(0, 8);
	const accounts = [
		{
			id: `acct-a-${n}`,
			name: `claude-a-${n}`,
			token: `sk-ant-oat01-ACCT-A-${n}`,
		},
		{
			id: `acct-b-${n}`,
			name: `claude-b-${n}`,
			token: `sk-ant-oat01-ACCT-B-${n}`,
		},
	];
	clearProviderOverloadCooldown();
	mock.clearFailures();
	const root = mkdtempSync(join(tmpdir(), "cmx-gateway-it-"));
	let gw: Gateway | null = null;
	const t0 = Date.now();
	try {
		gw = await startGateway({
			root,
			upstreamUrl: mock.url,
			accounts,
			models: [MODEL],
			...(bridge ? { bridge } : {}),
		});
		const detail = (await run(gw, accounts)) as Record<string, unknown>;
		// Every turn over: no Claude Code process may outlive it.
		const bridgeIdle = await waitFor(
			() => gw?.bridge.status().live === 0,
			15_000,
		);
		const processesGone = await waitFor(() => childPids().length === 0, 15_000);
		results[name] = {
			ok: true,
			...detail,
			bridgeIdle,
			processesLeft: childPids().length,
			processesGone,
			blockedEgress: gw.blockedEgress,
			ms: Date.now() - t0,
		};
	} catch (error) {
		results[name] = {
			ok: false,
			error:
				error instanceof Error ? (error.stack ?? error.message) : String(error),
		};
	} finally {
		mock.clearFailures();
		await gw?.stop();
		// The bridge's work root, once the gateway has stopped: nothing left.
		const result = results[name] as Record<string, unknown> | undefined;
		if (result)
			result.workFilesAfterStop = filesUnder(join(root, "claude-agent-sdk"));
		rmSync(root, { recursive: true, force: true });
		save();
		console.log(
			`[gateway-it] ${name}: ${(results[name] as { ok: boolean }).ok ? "done" : "FAILED"}`,
		);
	}
}

function messagesCalls(from: number): MockRequest[] {
	return mock.requests
		.slice(from)
		.filter((r) => r.method === "POST" && r.path.startsWith("/v1/messages"));
}

function accountOf(accounts: Account[], request: MockRequest): string {
	const auth = request.headers.authorization ?? "";
	return (
		accounts.find((a) => auth === `Bearer ${a.token}`)?.id ??
		`other:${auth.slice(0, 24)}`
	);
}

function asReply(r: Reply | { aborted: string }): Reply {
	if ("aborted" in r) throw new Error(`request aborted: ${r.aborted}`);
	return r;
}

async function turnRows(gw: Gateway) {
	return gw.query<Record<string, unknown>>(
		"SELECT id, status, history_mode, rebuild_reason, account_id, client_harness, http_status, error_type FROM sdk_bridge_turns ORDER BY started_at",
	);
}

/** The turn rows once every turn has finished and its row says so. */
async function finishedTurnRows(gw: Gateway) {
	await waitFor(() => gw.bridge.status().live === 0, 20_000);
	const until = Date.now() + 5_000;
	let rows = await turnRows(gw);
	while (rows.some((r) => r.status === "running") && Date.now() < until) {
		await Bun.sleep(100);
		rows = await turnRows(gw);
	}
	return rows;
}

async function legRows(gw: Gateway) {
	return gw.query<Record<string, unknown>>(
		"SELECT id, turn_id, kind, http_status, error_phase, error_type FROM sdk_bridge_turn_legs ORDER BY started_at",
	);
}

/** The inner request rows, once the recorder has written them. */
async function innerRows(gw: Gateway, count: number) {
	const read = () =>
		gw.query<Record<string, unknown>>(
			"SELECT id, account_used, status_code, sdk_bridge_turn_id, client_harness, api_key_id FROM requests WHERE sdk_bridge_turn_id IS NOT NULL ORDER BY timestamp",
		);
	const until = Date.now() + 5_000;
	let rows = await read();
	while (rows.length < count && Date.now() < until) {
		await Bun.sleep(100);
		rows = await read();
	}
	return rows;
}

const RATE_LIMITED = {
	type: "error",
	error: { type: "rate_limit_error", message: "mock 429" },
};

for (const endpoint of ["responses", "chat"] as const) {
	const key = (s: string) => `${endpoint}.${s}`;

	await withGateway(key("g1CredentialSwap"), async (gw, accounts) => {
		const from = mock.requests.length;
		const c = new Conversation(endpoint, `g1-${endpoint}`);
		c.user("hello via gateway");
		const reply = asReply(await c.send(gw));
		const [up] = messagesCalls(from);
		const h = up?.headers ?? {};
		const inner = await innerRows(gw, 1);
		return {
			reply,
			upstreamAccount: up ? accountOf(accounts, up) : null,
			authorization: h.authorization ?? null,
			carriesClientKey: JSON.stringify(h).includes(gw.apiKey),
			beta: h["anthropic-beta"] ?? null,
			userAgent: h["user-agent"] ?? null,
			leakedHeaders: Object.keys(h).filter((k) => k.startsWith("x-clankermux")),
			innerRows: inner,
			turns: await turnRows(gw),
			legs: await legRows(gw),
			apiKeyId: gw.apiKeyId,
		};
	});

	await withGateway(key("g2ToolRoundTrip"), async (gw, accounts) => {
		const from = mock.requests.length;
		const c = new Conversation(endpoint, `g2-${endpoint}`);
		c.user("TOOL via gateway");
		const r1 = asReply(await c.send(gw));
		c.absorb(r1, "GW-CONTENT");
		const r2 = asReply(await c.send(gw));
		c.absorb(r2);
		c.user("third turn");
		const r3 = asReply(await c.send(gw));
		const calls = messagesCalls(from);
		return {
			r1,
			r2,
			r3,
			upstreamAccounts: [...new Set(calls.map((q) => accountOf(accounts, q)))],
			upstreamToolNames: calls.map((q) =>
				((q.body as { tools?: Array<{ name: string }> }).tools ?? []).map(
					(t) => t.name,
				),
			),
			cliRetries: calls.map(
				(q) => q.headers["x-stainless-retry-count"] ?? null,
			),
			turns: await turnRows(gw),
			legs: await legRows(gw),
			innerRows: await innerRows(gw, calls.length),
		};
	});

	await withGateway(key("g3Abort"), async (gw) => {
		const from = mock.requests.length;
		const c = new Conversation(endpoint, `g3-${endpoint}`);
		c.user("SLOW via gateway");
		const abort = new AbortController();
		const pending = c.send(gw, abort.signal);
		const started = await waitFor(() => messagesCalls(from).length > 0, 30_000);
		await Bun.sleep(500);
		const liveDuring = gw.bridge.status().live;
		const processesDuring = childPids().length;
		abort.abort();
		const outcome = await pending;
		const upstreamAborted = await waitFor(
			() => messagesCalls(from).some((q) => q.abortedAfterMs !== undefined),
			10_000,
		);
		return {
			started,
			liveDuring,
			processesDuring,
			clientSaw: "aborted" in outcome ? "aborted" : (outcome as Reply).status,
			upstreamAborted,
			upstream: messagesCalls(from).map((q) => ({
				status: q.status ?? null,
				abortedAfterMs: q.abortedAfterMs ?? null,
			})),
			legs: await legRows(gw),
		};
	});

	await withGateway(key("g4OneOverload"), async (gw, accounts) => {
		const from = mock.requests.length;
		mock.failNext(
			529,
			{
				type: "error",
				error: { type: "overloaded_error", message: "mock 529" },
			},
			{},
			1,
		);
		const c = new Conversation(endpoint, `g4-${endpoint}`);
		c.user("after a 529 via gateway");
		const reply = asReply(await c.send(gw));
		return {
			reply,
			upstream: messagesCalls(from).map((q) => ({
				account: accountOf(accounts, q),
				status: q.status ?? null,
				cliRetry: q.headers["x-stainless-retry-count"] ?? null,
			})),
			turns: await turnRows(gw),
		};
	});

	await withGateway(key("g5FailoverInsideOneAttempt"), async (gw, accounts) => {
		const from = mock.requests.length;
		mock.failNext(
			429,
			RATE_LIMITED,
			{
				"retry-after": "600",
				"anthropic-ratelimit-unified-status": "rejected",
			},
			50,
			accounts[0]?.token,
		);
		const c = new Conversation(endpoint, `g5-${endpoint}`);
		c.user("429 on A");
		const reply = asReply(await c.send(gw));
		return {
			reply,
			upstream: messagesCalls(from).map((q) => ({
				account: accountOf(accounts, q),
				status: q.status ?? null,
				cliRetry: q.headers["x-stainless-retry-count"] ?? null,
			})),
		};
	});

	await withGateway(key("g6AllRateLimited"), async (gw, accounts) => {
		const from = mock.requests.length;
		mock.failNext(
			429,
			RATE_LIMITED,
			{
				"retry-after": "600",
				"anthropic-ratelimit-unified-status": "rejected",
			},
			500,
		);
		const c = new Conversation(endpoint, `g6-${endpoint}`);
		c.user("429 everywhere");
		const reply = asReply(await c.send(gw));
		const calls = messagesCalls(from);
		return {
			reply,
			// From Claude Code's first model call to the client's answer: the
			// part retries would stretch, without the process's start-up.
			sinceFirstUpstreamMs:
				reply.finishedAt - (calls[0]?.at ?? reply.finishedAt),
			upstream: messagesCalls(from).map((q) => ({
				account: accountOf(accounts, q),
				status: q.status ?? null,
				cliRetry: q.headers["x-stainless-retry-count"] ?? null,
			})),
		};
	});

	await withGateway(key("overage429"), async (gw, accounts) => {
		const from = mock.requests.length;
		mock.failNext(
			429,
			{
				type: "error",
				error: { type: "rate_limit_error", message: "out of credits" },
			},
			{
				"anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
				"x-should-retry": "true",
			},
			50,
			accounts[0]?.token,
		);
		const c = new Conversation(endpoint, `oc429-${endpoint}`);
		c.user("credits on A are gone");
		const reply = asReply(await c.send(gw));
		return {
			reply,
			upstream: messagesCalls(from).map((q) => ({
				account: accountOf(accounts, q),
				status: q.status ?? null,
			})),
			accounts: await gw.query(
				"SELECT id, paused, rate_limited_reason, rate_limited_until > ? AS cooling FROM accounts ORDER BY priority",
				[Date.now()],
			),
		};
	});

	await withGateway(key("overage400"), async (gw, accounts) => {
		const from = mock.requests.length;
		mock.failNext(
			400,
			{
				type: "error",
				error: {
					type: "invalid_request_error",
					message: "You're out of extra usage.",
				},
			},
			{
				"anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
			},
			50,
		);
		const c = new Conversation(endpoint, `oc400-${endpoint}`);
		c.user("no extra usage left");
		const reply = asReply(await c.send(gw));
		return {
			reply,
			upstream: messagesCalls(from).map((q) => ({
				account: accountOf(accounts, q),
				status: q.status ?? null,
			})),
			accounts: await gw.query(
				"SELECT id, paused, rate_limited_reason, rate_limited_until FROM accounts ORDER BY priority",
			),
		};
	});

	await withGateway(
		key("g7DeadContinuation"),
		async (gw) => {
			const c = new Conversation(endpoint, `g7-${endpoint}`);
			c.user("TOOL via gateway, answered late");
			const r1 = asReply(await c.send(gw));
			// The parked call times out and its query ends before the answer.
			const ended = await waitFor(() => gw.bridge.status().live === 0, 20_000);
			c.absorb(r1, "GW-LATE-RESULT");
			const from = mock.requests.length;
			const r2 = asReply(await c.send(gw));
			const sent = messagesCalls(from).at(-1)?.body as {
				messages?: Array<{ role: string; content: unknown }>;
			};
			const lastUser = JSON.stringify(
				sent?.messages?.filter((m) => m.role === "user").at(-1) ?? null,
			);
			return {
				ended,
				r1,
				r2,
				upstreamCarriesResult: lastUser.includes("GW-LATE-RESULT"),
				upstreamCarriesCall: lastUser.includes(`id=${r1.toolCalls[0]?.id}`),
				turns: await finishedTurnRows(gw),
				legs: await legRows(gw),
			};
		},
		{ limits: () => ({ parkedTimeoutMs: 1_500 }) },
	);

	await withGateway(key("g8TextWithToolResults"), async (gw) => {
		const c = new Conversation(endpoint, `g8-${endpoint}`);
		c.user("TOOL via gateway, with a note");
		const r1 = asReply(await c.send(gw));
		c.absorb(r1, "GW-TXT-RESULT");
		c.user("ALSO-GW-USER-TEXT");
		const from = mock.requests.length;
		const r2 = asReply(await c.send(gw));
		const carrying = messagesCalls(from).filter((q) =>
			JSON.stringify(q.body).includes("ALSO-GW-USER-TEXT"),
		);
		const text = JSON.stringify(
			(carrying.at(-1)?.body as { messages?: unknown })?.messages ?? [],
		);
		return {
			r1,
			r2,
			upstreamCalls: messagesCalls(from).length,
			textReachedUpstream: carrying.length > 0,
			resultBeforeText:
				text.indexOf("GW-TXT-RESULT") >= 0 &&
				text.indexOf("GW-TXT-RESULT") < text.indexOf("ALSO-GW-USER-TEXT"),
			legs: await legRows(gw),
		};
	});

	await withGateway(
		key("g9OversizedInnerBody"),
		async (gw) => {
			const from = mock.requests.length;
			const c = new Conversation(endpoint, `g9-${endpoint}`);
			c.user("small request, large model call");
			const reply = asReply(await c.send(gw));
			await finishedTurnRows(gw);
			return {
				reply,
				upstreamCalls: messagesCalls(from).length,
				turns: await gw.query(
					"SELECT status, inner_call_count, inner_error_count FROM sdk_bridge_turns",
				),
			};
		},
		{ limits: () => ({ maxHistoryBytes: 8_000 }) },
	);
}

// The same overage answers to a direct Claude Code request on /wire/anthropic:
// the control for "inner calls get the account handling direct traffic gets".
for (const [name, status, body, headers] of [
	[
		"direct.overage429",
		429,
		{
			type: "error",
			error: { type: "rate_limit_error", message: "out of credits" },
		},
		{
			"anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
			"x-should-retry": "true",
		},
	],
	[
		"direct.overage400",
		400,
		{
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "You're out of extra usage.",
			},
		},
		{ "anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits" },
	],
] as const)
	await withGateway(name, async (gw, accounts) => {
		const from = mock.requests.length;
		mock.failNext(
			status,
			body,
			headers,
			50,
			status === 429 ? accounts[0]?.token : undefined,
		);
		const response = await fetch(`${gw.url}/wire/anthropic/v1/messages`, {
			method: "POST",
			headers: {
				"x-api-key": gw.apiKey,
				"content-type": "application/json",
				"anthropic-version": "2023-06-01",
				"user-agent": "claude-cli/2.1.280 (external, cli)",
			},
			body: JSON.stringify({
				model: MODEL,
				max_tokens: 64,
				stream: true,
				messages: [{ role: "user", content: "direct control" }],
			}),
		});
		const text = await response.text();
		return {
			status: response.status,
			text: text.slice(0, 500),
			upstream: messagesCalls(from).map((q) => ({
				account: accountOf(accounts, q),
				status: q.status ?? null,
			})),
			accounts: await gw.query(
				status === 429
					? "SELECT id, paused, rate_limited_reason, rate_limited_until > ? AS cooling FROM accounts ORDER BY priority"
					: "SELECT id, paused, rate_limited_reason, rate_limited_until FROM accounts ORDER BY priority",
				status === 429 ? [Date.now()] : [],
			),
		};
	});

results.upstreamPaths = [
	...new Set(mock.requests.map((q) => `${q.method} ${q.path}`)),
];
results.leftoverChildren = childPids().length;
save();
mock.stop();
process.exit(0);
