import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildQueryOptions, childEnv, workPaths } from "../options";
import { FileSessionStore } from "../session-store";
import { createToolServer, loadMcpSdk, ToolNames } from "../tool-server";

const ROOT = "/var/cache/clankermux/claude-agent-sdk";

const mcpSdk = await loadMcpSdk();

describe("child environment", () => {
	it("is exactly the allowlist, with every path under the work root", () => {
		process.env.SDK_BRIDGE_TEST_LEAK = "leak";
		process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
		try {
			const env = childEnv({
				paths: workPaths(ROOT),
				baseUrl: "http://127.0.0.1:4242",
				token: "cmxsdk_x_token",
			});
			expect(env).toEqual({
				PATH: `${ROOT}/bin`,
				HOME: `${ROOT}/home`,
				CLAUDE_CONFIG_DIR: `${ROOT}/claude-config`,
				TMPDIR: `${ROOT}/tmp`,
				ANTHROPIC_BASE_URL: "http://127.0.0.1:4242",
				ANTHROPIC_AUTH_TOKEN: "cmxsdk_x_token",
				CLAUDE_CODE_MAX_RETRIES: "0",
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
				DISABLE_AUTO_COMPACT: "1",
				CLAUDE_CODE_NO_MODEL_FALLBACK: "1",
				MAX_MCP_OUTPUT_TOKENS: "100000000",
				ENABLE_CLAUDEAI_MCP_SERVERS: "0",
				DISABLE_AUTOUPDATER: "1",
				CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
				CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
				ENABLE_TOOL_SEARCH: "false",
			});
			expect(Object.keys(env)).not.toContain("CLAUDE_CODE_ENTRYPOINT");
			expect(Object.values(env)).not.toContain("leak");
		} finally {
			delete process.env.SDK_BRIDGE_TEST_LEAK;
			delete process.env.CLAUDE_CODE_ENTRYPOINT;
		}
	});
});

describe("query options", () => {
	const dir = mkdtempSync(join(tmpdir(), "sdk-bridge-options-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const store = new FileSessionStore(dir);
	const server = createToolServer(
		mcpSdk,
		[{ name: "read", description: "", input_schema: { type: "object" } }],
		new ToolNames(["read"]),
		async () => ({ content: [] }),
	);
	const base = {
		paths: workPaths(ROOT),
		baseUrl: "http://127.0.0.1:4242",
		token: "t",
		model: "claude-sonnet-5",
		toolNames: ["read"],
		toolServer: server,
		webSearch: null,
		systemPrompt: { append: null, excludeDynamicSections: false },
		effort: null,
		maxOutputTokens: null,
		sessionId: "11111111-1111-4111-8111-111111111111",
		resume: false,
		sessionStore: store,
		executablePath: "/opt/claude",
		spawn: () => {
			throw new Error("unused");
		},
		stderr: () => {},
		abortController: new AbortController(),
	};

	it("runs Claude Code with no built-in tools, only the client's, and nothing from disk", () => {
		const {
			env,
			spawnClaudeCodeProcess,
			stderr,
			abortController,
			sessionStore,
			mcpServers,
			...rest
		} = buildQueryOptions(base);
		expect(env?.CLAUDE_CODE_MAX_RETRIES).toBe("0");
		expect(typeof spawnClaudeCodeProcess).toBe("function");
		expect(typeof stderr).toBe("function");
		expect(abortController).toBe(base.abortController);
		expect(sessionStore).toBe(store);
		expect(mcpServers?.c).toBe(server);
		expect(rest).toEqual({
			cwd: `${ROOT}/cwd`,
			model: "claude-sonnet-5",
			tools: [],
			allowedTools: ["mcp__c__read"],
			permissionMode: "dontAsk",
			strictMcpConfig: true,
			settingSources: [],
			settings: { autoMemoryEnabled: false, includeGitInstructions: false },
			skills: [],
			plugins: [],
			verbatimPrompts: true,
			systemPrompt: { type: "preset", preset: "claude_code", snapshot: false },
			extraArgs: { "thinking-display": "summarized" },
			includePartialMessages: true,
			persistSession: true,
			sessionStoreFlush: "eager",
			sessionId: "11111111-1111-4111-8111-111111111111",
			pathToClaudeCodeExecutable: "/opt/claude",
		});
		expect(server.timeout).toBe(24 * 60 * 60_000);
	});

	it("resumes by id, maps effort, and appends a policy's text", () => {
		const options = buildQueryOptions({
			...base,
			resume: true,
			effort: "xhigh",
			systemPrompt: { append: "extra", excludeDynamicSections: true },
		});
		expect(options.resume).toBe(base.sessionId);
		expect(options.sessionId).toBeUndefined();
		expect(options.effort).toBe("xhigh");
		expect(options.systemPrompt).toEqual({
			type: "preset",
			preset: "claude_code",
			append: "extra",
			excludeDynamicSections: true,
			snapshot: false,
		});
	});

	it("passes the effort only to a model that takes one, clamped to its range", () => {
		const effort = (model: string, level: "low" | "xhigh" | "max") =>
			buildQueryOptions({ ...base, model, effort: level }).effort;
		expect(effort("claude-opus-5-5", "max")).toBe("max");
		expect(effort("claude-fable-5-1[1m]", "max")).toBe("max");
		expect(effort("claude-sonnet-5", "xhigh")).toBe("xhigh");
		expect(effort("claude-sonnet-5", "low")).toBe("low");
		// A future Haiku takes an effort, within Haiku's range.
		expect(effort("claude-haiku-5", "max")).toBe("medium");
		// Haiku 4.5, Sonnet 4.5 and non-Claude ids take none: Claude Code's
		// default stands.
		for (const model of [
			"claude-haiku-4-5",
			"claude-sonnet-4-5",
			"primary-model",
		])
			expect(effort(model, "max")).toBeUndefined();
	});

	it("sets the client's output limit only when it gave one", () => {
		expect(
			buildQueryOptions({ ...base, maxOutputTokens: 500 }).env
				?.CLAUDE_CODE_MAX_OUTPUT_TOKENS,
		).toBe("500");
		expect(buildQueryOptions(base).env).not.toHaveProperty(
			"CLAUDE_CODE_MAX_OUTPUT_TOKENS",
		);
	});

	it("gives no MCP server to a turn without tools", () => {
		const options = buildQueryOptions({
			...base,
			toolNames: [],
			toolServer: null,
		});
		expect(options.mcpServers).toEqual({});
		expect(options.allowedTools).toEqual([]);
	});

	it("adds Claude Code's WebSearch, and nothing else of its own, for a hosted web search", () => {
		const options = buildQueryOptions({
			...base,
			webSearch: { allowedDomains: null },
		});
		expect(options.tools).toEqual(["WebSearch"]);
		expect(options.allowedTools).toEqual(["mcp__c__read", "WebSearch"]);
		expect(options.hooks).toBeUndefined();
		const filtered = buildQueryOptions({
			...base,
			webSearch: { allowedDomains: ["bun.sh"] },
		});
		expect(
			filtered.hooks?.PreToolUse?.map((m) => [m.matcher, m.hooks.length]),
		).toEqual([["WebSearch", 1]]);
	});
});
