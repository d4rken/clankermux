import { Logger } from "@clankermux/logger";
import type { Account } from "@clankermux/types";
import { AnthropicCompatibleProvider } from "../anthropic-compatible/provider";

const log = new Logger("OpenRouterProvider");

const OPENROUTER_DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1";

export class OpenRouterProvider extends AnthropicCompatibleProvider {
	constructor() {
		super({
			name: "openrouter",
			baseUrl: OPENROUTER_DEFAULT_ENDPOINT,
			authHeader: "authorization",
			authType: "bearer",
			supportsStreaming: true,
		});
	}

	/** OpenRouter's non-Anthropic backends reject mid-conversation effort updates.
	 * Applying the last update to this generation preserves current intent while
	 * keeping the system messages at their original positions in the history. */
	override async transformRequestBody(request: Request): Promise<Request> {
		if (request.method !== "POST") return request;
		let body: Record<string, unknown>;
		try {
			body = await request.clone().json();
		} catch {
			return request;
		}
		if (
			typeof body?.model !== "string" ||
			body.model.startsWith("anthropic/") ||
			body.model.startsWith("claude-") ||
			!Array.isArray(body.messages)
		)
			return request;
		// Preserve invalid controls for upstream validation rather than silently
		// replacing them (or spreading string/array indices into an object).
		if (
			"output_config" in body &&
			(!body.output_config ||
				typeof body.output_config !== "object" ||
				Array.isArray(body.output_config))
		)
			return request;
		let updates = 0;
		const messages = body.messages.map((message: Record<string, unknown>) => {
			const config = message.output_config;
			if (
				message.role !== "system" ||
				!config ||
				typeof config !== "object" ||
				Array.isArray(config) ||
				Object.keys(config).length !== 1 ||
				!("effort" in config) ||
				typeof config.effort !== "string"
			)
				return message;
			body.output_config = {
				...(body.output_config as Record<string, unknown> | undefined),
				effort: config.effort,
			};
			const { output_config: _config, ...rest } = message;
			updates++;
			return rest;
		});
		if (!updates) return request;
		body.messages = messages;
		log.info(
			`Normalized ${updates} conversation effort update(s) for ${body.model}`,
		);
		const headers = new Headers(request.headers);
		headers.delete("content-length");
		return new Request(request, { headers, body: JSON.stringify(body) });
	}

	override buildUrl(
		pathname: string,
		search: string,
		account?: Account,
	): string {
		const base = (
			account?.custom_endpoint || OPENROUTER_DEFAULT_ENDPOINT
		).replace(/\/+$/, "");
		let basePath: string;
		try {
			basePath = new URL(base).pathname.replace(/\/+$/, "");
		} catch {
			return `${base}${pathname}${search}`;
		}
		// The base already carries /v1, and the proxy hands us Anthropic paths
		// that start with /v1 — drop one, on a segment boundary so /v1beta
		// survives intact.
		const path =
			basePath.endsWith("/v1") &&
			(pathname === "/v1" || pathname.startsWith("/v1/"))
				? pathname.slice("/v1".length) || "/"
				: pathname;
		return `${base}${path}${search}`;
	}
}
