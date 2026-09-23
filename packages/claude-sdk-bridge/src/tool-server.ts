import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Block, ClientTool } from "./turn-request";

/**
 * The parts of the MCP SDK the tool server uses, imported on first use like
 * the Agent SDK. The compiled server marks both SDKs external, and a static
 * import of an external module stops the whole binary from starting instead
 * of leaving just the bridge unavailable.
 */
export interface McpSdk {
	McpServer: typeof McpServer;
	CallToolRequestSchema: typeof CallToolRequestSchema;
	ListToolsRequestSchema: typeof ListToolsRequestSchema;
}

export async function loadMcpSdk(): Promise<McpSdk> {
	const [server, types] = await Promise.all([
		import("@modelcontextprotocol/sdk/server/mcp.js"),
		import("@modelcontextprotocol/sdk/types.js"),
	]);
	return {
		McpServer: server.McpServer,
		CallToolRequestSchema: types.CallToolRequestSchema,
		ListToolsRequestSchema: types.ListToolsRequestSchema,
	};
}

export const MCP_SERVER_NAME = "client";
/** Claude Code names our tools `mcp__<server>__<tool>`. */
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
/** Where Claude Code puts the model's tool_use id on an MCP call. */
export const TOOL_USE_ID_META = "claudecode/toolUseId";
/** Parked calls wait on the client; the bridge's own timeouts end them first. */
export const TOOL_CALL_TIMEOUT_MS = 24 * 60 * 60_000;

export type McpContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

export interface McpToolResult {
	content: McpContent[];
	isError?: boolean;
	[key: string]: unknown;
}

/** The client's name for one of our tools, or null for any other tool. */
export function clientToolName(
	name: string,
	known: ReadonlySet<string>,
): string | null {
	if (!name.startsWith(MCP_TOOL_PREFIX)) return null;
	const stripped = name.slice(MCP_TOOL_PREFIX.length);
	return known.has(stripped) ? stripped : null;
}

/** The client's JSON Schema verbatim, minus the `$schema` keyword. */
export function mcpInputSchema(
	schema: Record<string, unknown>,
): Record<string, unknown> {
	const { $schema: _dropped, ...rest } = schema;
	return rest;
}

export function toMcpResult(block: Block): McpToolResult {
	const raw = block.content;
	const content: McpContent[] = [];
	if (typeof raw === "string") content.push({ type: "text", text: raw });
	else if (Array.isArray(raw)) {
		for (const b of raw as Block[]) {
			if (b?.type === "text")
				content.push({ type: "text", text: String(b.text ?? "") });
			else if (b?.type === "image") {
				const source = b.source as
					| { type?: string; data?: string; media_type?: string }
					| undefined;
				if (source?.type === "base64" && source.data && source.media_type)
					content.push({
						type: "image",
						data: source.data,
						mimeType: source.media_type,
					});
				else content.push({ type: "text", text: "[image omitted]" });
			} else if (b?.type)
				content.push({ type: "text", text: `[${b.type} omitted]` });
		}
	}
	if (!content.length) content.push({ type: "text", text: "" });
	return { content, isError: block.is_error === true };
}

export function abortedResult(reason: string): McpToolResult {
	return {
		content: [{ type: "text", text: `Tool call aborted (${reason})` }],
		isError: true,
	};
}

/**
 * The MCP calls of one Claude Code query that wait for the client, keyed by
 * tool_use id. A result can arrive before Claude Code makes its call (the
 * client answers as soon as it sees the tool_use), so it waits in `early`.
 */
export class ParkedCalls {
	private readonly parked = new Map<string, (result: McpToolResult) => void>();
	private readonly early = new Map<string, McpToolResult>();
	private closedReason: string | null = null;

	get size(): number {
		return this.parked.size;
	}

	get closed(): boolean {
		return this.closedReason !== null;
	}

	has(id: string): boolean {
		return this.parked.has(id);
	}

	wait(id: string): Promise<McpToolResult> {
		const early = this.early.get(id);
		if (early) {
			this.early.delete(id);
			return Promise.resolve(early);
		}
		if (this.closedReason !== null)
			return Promise.resolve(abortedResult(this.closedReason));
		return new Promise((resolve) => this.parked.set(id, resolve));
	}

	deliver(id: string, result: McpToolResult): "resolved" | "early" {
		const resolve = this.parked.get(id);
		if (resolve) {
			this.parked.delete(id);
			resolve(result);
			return "resolved";
		}
		this.early.set(id, result);
		return "early";
	}

	close(reason: string): void {
		if (this.closedReason !== null) return;
		this.closedReason = reason;
		for (const resolve of this.parked.values()) resolve(abortedResult(reason));
		this.parked.clear();
		this.early.clear();
	}
}

/**
 * An in-process MCP server exposing the client's tools under their own
 * schemas. Every call goes to `onCall`, which parks it until the client sends
 * the result.
 */
export function createToolServer(
	mcp: McpSdk,
	tools: readonly ClientTool[],
	onCall: (toolUseId: string, name: string) => Promise<McpToolResult>,
): McpSdkServerConfigWithInstance {
	const server = new mcp.McpServer(
		{ name: MCP_SERVER_NAME, version: "1.0.0" },
		{ capabilities: { tools: {} } },
	);
	const listed = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: mcpInputSchema(tool.input_schema) as {
			type: "object";
			[key: string]: unknown;
		},
		// The SDK's own `alwaysLoad` option sets exactly this per tool: never
		// defer the client's tools behind tool search.
		_meta: { "anthropic/alwaysLoad": true },
	}));
	server.server.setRequestHandler(mcp.ListToolsRequestSchema, () => ({
		tools: listed,
	}));
	server.server.setRequestHandler(
		mcp.CallToolRequestSchema,
		async (request) => {
			const id = request.params._meta?.[TOOL_USE_ID_META];
			if (typeof id !== "string")
				return {
					content: [
						{ type: "text", text: `Missing _meta["${TOOL_USE_ID_META}"]` },
					],
					isError: true,
				};
			return onCall(id, request.params.name);
		},
	);
	return {
		type: "sdk",
		name: MCP_SERVER_NAME,
		instance: server,
		timeout: TOOL_CALL_TIMEOUT_MS,
	};
}
