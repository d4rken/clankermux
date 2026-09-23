import { Logger } from "@clankermux/logger";
import type { OpenAIRequest } from "@clankermux/openai-formats";
import { getDefaultEndpoint, PROVIDER_NAMES } from "@clankermux/types";
import type { RateLimitInfo } from "../../types";
import { OpenAICompatibleProvider } from "../openai/provider";
import {
	QWEN_CODE_CONTEXT_FILE,
	QWEN_CODE_FEEDBACK_LINE,
	QWEN_CODE_IDENTITY_PROMPT,
	QWEN_CODE_PRODUCT_NAME,
	qwenInferenceHeaders,
} from "./client-identity";

const _log = new Logger("QwenProvider");

// Lines in the Claude Code system prompt that are environment/model-specific
// and should be dropped entirely when proxying to Qwen.
const DROP_LINE_PATTERNS = [
	/You are powered by the model named/,
	/The most recent Claude model family is/,
	/Claude Code is available as a CLI/,
	/Fast mode for Claude Code/,
	/claude\.ai\/code/,
];

/**
 * Adapt a Claude Code system prompt block for Qwen/DashScope:
 * - Replace Claude Code identity with Qwen Code identity
 * - Replace CLAUDE.md references with QWEN.md
 * - Replace /help feedback link with qwen-code's /bug command
 * - Drop lines that reference Claude-specific model names or availability
 */
function sanitizeForQwen(text: string): string {
	// Replace identity line (block [1] is exactly this string)
	if (
		text === "You are Claude Code, Anthropic's official CLI for Claude." ||
		text ===
			"You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK." ||
		text === "You are a Claude agent, built on Anthropic's Claude Agent SDK."
	) {
		return QWEN_CODE_IDENTITY_PROMPT;
	}

	// Process line-by-line for the main instructions block
	const lines = text.split("\n");
	const out: string[] = [];
	for (const line of lines) {
		// Drop Claude-specific environment/model lines entirely
		if (DROP_LINE_PATTERNS.some((re) => re.test(line))) continue;

		let l = line;
		// CLAUDE.md → QWEN.md
		l = l.replace(/\bCLAUDE\.md\b/g, QWEN_CODE_CONTEXT_FILE);
		// /help feedback line
		l = l.replace(
			/To give feedback, users should report the issue at https:\/\/github\.com\/anthropics\/claude-code\/issues/,
			QWEN_CODE_FEEDBACK_LINE,
		);
		// "Get help with using Claude Code"
		l = l.replace(
			/Get help with using Claude Code/,
			`Get help with using ${QWEN_CODE_PRODUCT_NAME}`,
		);
		out.push(l);
	}
	return out.join("\n");
}

export class QwenProvider extends OpenAICompatibleProvider {
	override name = "qwen";

	/**
	 * A qwen account's DashScope host lives in `custom_endpoint`, written from the
	 * OAuth token response's `resource_url`. A token response that carries none,
	 * or a value an operator cleared, would otherwise inherit the parent's
	 * `api.openai.com` and send a DashScope bearer token to OpenAI.
	 */
	protected override defaultEndpoint(): string {
		return getDefaultEndpoint(PROVIDER_NAMES.QWEN);
	}

	/*
	 * Override to save raw Qwen SSE to /tmp for debugging tool call chunks.
	 * Remove once incremental argument handling is confirmed working.
	 *
	 * override async refreshToken(...) { ... }
	 * override buildUrl(...) { ... }
	 */

	override prepareHeaders(
		_headers: Headers,
		accessToken?: string,
		_apiKey?: string,
	): Headers {
		// Start from a clean set — DashScope is sensitive to unexpected headers
		// (e.g. x-stainless-*, anthropic-*, accept-encoding) causing 429s.
		return new Headers(qwenInferenceHeaders(accessToken));
	}

	override parseRateLimit(_response: Response): RateLimitInfo {
		// Qwen handles its own rate limiting — never mark as rate-limited
		// Quota errors come as 403s and are handled inline by the API
		return {
			isRateLimited: false,
			statusHeader: "allowed",
		};
	}

	override supportsOAuth(): boolean {
		return true;
	}

	override supportsUsageTracking(): boolean {
		return true;
	}

	/**
	 * Inject Qwen-specific fields after converting to OpenAI format.
	 */
	override afterConvert(body: OpenAIRequest): void {
		for (const msg of body.messages) {
			if (msg.role === "system" && Array.isArray(msg.content)) {
				msg.content = msg.content
					// Strip Anthropic billing header blocks
					.filter(
						(block) =>
							!(
								block.type === "text" &&
								typeof block.text === "string" &&
								block.text.startsWith("x-anthropic-")
							),
					)
					// Replace Claude-specific identity and environment blocks
					.map((block) => {
						if (block.type !== "text" || typeof block.text !== "string")
							return block;
						return { ...block, text: sanitizeForQwen(block.text) };
					})
					// Drop blocks that became empty after sanitization
					.filter(
						(block) =>
							block.type !== "text" ||
							typeof block.text !== "string" ||
							block.text.trim() !== "",
					);

				if (msg.content.length === 0) {
					msg.content = "";
				}
			}
		}

		// Enable vision support (coder-model supports vision)
		(body as unknown as Record<string, unknown>).vl_high_resolution_images =
			true;
	}
}
