import { join } from "node:path";
import type {
	EffortLevel,
	McpSdkServerConfigWithInstance,
	Options,
	SessionStore,
	SpawnedProcess,
	SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "./tool-server";

export interface WorkPaths {
	root: string;
	/** An empty directory: Claude Code runs with no tools that need binaries. */
	bin: string;
	home: string;
	configDir: string;
	tmp: string;
	cwd: string;
	sessions: string;
}

export function workPaths(root: string): WorkPaths {
	return {
		root,
		bin: join(root, "bin"),
		home: join(root, "home"),
		configDir: join(root, "claude-config"),
		tmp: join(root, "tmp"),
		cwd: join(root, "cwd"),
		sessions: join(root, "sessions"),
	};
}

/**
 * Claude Code's whole environment, built from nothing: the SDK replaces the
 * child's environment with this object, and nothing of the server's own
 * environment (credentials, proxy settings, CLAUDE_CODE_ENTRYPOINT) may leak
 * into it.
 */
export function childEnv(input: {
	paths: WorkPaths;
	baseUrl: string;
	token: string;
}): Record<string, string> {
	return {
		PATH: input.paths.bin,
		HOME: input.paths.home,
		CLAUDE_CONFIG_DIR: input.paths.configDir,
		TMPDIR: input.paths.tmp,
		ANTHROPIC_BASE_URL: input.baseUrl,
		ANTHROPIC_AUTH_TOKEN: input.token,
		// Retries belong to the proxy's inner calls, which fail over across
		// accounts; Claude Code's own backoff turned an all-accounts 429 from
		// 0.7 s into 594 s in the spike.
		CLAUDE_CODE_MAX_RETRIES: "0",
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		DISABLE_AUTO_COMPACT: "1",
		ENABLE_CLAUDEAI_MCP_SERVERS: "0",
		DISABLE_AUTOUPDATER: "1",
		CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
		CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
		// Off, not "auto": Claude Code decides tool search per base URL, account
		// and flag rollout, so an unpinned value could defer the client's tools
		// behind a search tool on one turn and not the next.
		ENABLE_TOOL_SEARCH: "false",
	};
}

export interface QueryOptionsInput {
	paths: WorkPaths;
	baseUrl: string;
	token: string;
	model: string;
	/** The client tools' names inside Claude Code (`ToolNames.exposed`). */
	toolNames: readonly string[];
	toolServer: McpSdkServerConfigWithInstance | null;
	systemPrompt: { append: string | null; excludeDynamicSections: boolean };
	effort: EffortLevel | null;
	sessionId: string;
	/** Resume `sessionId` from the session store instead of starting it. */
	resume: boolean;
	sessionStore: SessionStore;
	executablePath: string;
	spawn: (options: SpawnOptions) => SpawnedProcess;
	stderr: (text: string) => void;
	abortController: AbortController;
}

export function buildQueryOptions(input: QueryOptionsInput): Options {
	return {
		cwd: input.paths.cwd,
		model: input.model,
		tools: [],
		allowedTools: input.toolNames.map((name) => `${MCP_TOOL_PREFIX}${name}`),
		permissionMode: "dontAsk",
		mcpServers: input.toolServer ? { [MCP_SERVER_NAME]: input.toolServer } : {},
		strictMcpConfig: true,
		settingSources: [],
		settings: { autoMemoryEnabled: false, includeGitInstructions: false },
		skills: [],
		plugins: [],
		verbatimPrompts: true,
		systemPrompt: {
			type: "preset",
			preset: "claude_code",
			...(input.systemPrompt.append !== null
				? { append: input.systemPrompt.append }
				: {}),
			...(input.systemPrompt.excludeDynamicSections
				? { excludeDynamicSections: true }
				: {}),
			// Rendered fresh on every request, so a resumed session always carries
			// the current policy's prompt rather than the one recorded first.
			snapshot: false,
		},
		...(input.effort ? { effort: input.effort } : {}),
		extraArgs: { "thinking-display": "summarized" },
		includePartialMessages: true,
		persistSession: true,
		sessionStore: input.sessionStore,
		sessionStoreFlush: "eager",
		...(input.resume
			? { resume: input.sessionId }
			: { sessionId: input.sessionId }),
		env: childEnv(input),
		pathToClaudeCodeExecutable: input.executablePath,
		spawnClaudeCodeProcess: input.spawn,
		stderr: input.stderr,
		abortController: input.abortController,
	};
}
