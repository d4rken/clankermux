import type { Account } from "@clankermux/types";
import { AnthropicCompatibleProvider } from "../anthropic-compatible/provider";

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
