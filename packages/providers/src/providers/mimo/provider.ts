import type { Account } from "@clankermux/types";
import { BaseAnthropicCompatibleProvider } from "../base-anthropic-compatible";

/** Singapore is the default of MiMo's three Token Plan regions. */
const MIMO_DEFAULT_ENDPOINT = "https://token-plan-sgp.xiaomimimo.com/anthropic";

function splitSegments(path: string): string[] {
	return path.split("/").filter(Boolean);
}

/**
 * Drop the leading segments of `path` that the base path already ends with.
 *
 *   base /anthropic    + /v1/messages -> /v1/messages
 *   base /anthropic/v1 + /v1/messages -> /messages
 *   base /v1x          + /v1/messages -> /v1/messages
 */
function withoutOverlap(basePath: string, path: string): string {
	const baseSegments = splitSegments(basePath);
	const pathSegments = splitSegments(path);
	const maxOverlap = Math.min(baseSegments.length, pathSegments.length);
	for (let n = maxOverlap; n > 0; n--) {
		const tail = baseSegments.slice(baseSegments.length - n).join("/");
		const head = pathSegments.slice(0, n).join("/");
		if (tail === head) {
			const rest = pathSegments.slice(n).join("/");
			return rest ? `/${rest}` : "";
		}
	}
	return path;
}

export class MimoProvider extends BaseAnthropicCompatibleProvider {
	constructor() {
		super({
			name: "mimo",
			baseUrl: MIMO_DEFAULT_ENDPOINT,
			authHeader: "x-api-key",
			authType: "direct",
			supportsStreaming: true,
		});
	}

	getEndpoint(): string {
		return this.config.baseUrl || MIMO_DEFAULT_ENDPOINT;
	}

	/**
	 * Resolve the request against the account's region, which is stored in
	 * `custom_endpoint`. Composed from parsed URL parts rather than concatenated,
	 * so the base's own path is extended on the path and a query already on the
	 * base cannot swallow the rest of the URL.
	 */
	override buildUrl(path: string, query: string, account?: Account): string {
		const base = account?.custom_endpoint || this.getEndpoint();
		let url: URL;
		try {
			url = new URL(base);
		} catch {
			return `${base.replace(/\/+$/, "")}${path}${query}`;
		}
		const basePath = url.pathname.replace(/\/+$/, "");
		url.pathname = `${basePath}${withoutOverlap(basePath, path)}`;
		if (!url.search) {
			// Verbatim: assigning `search` preserves the request's own encoding,
			// while re-encoding through URLSearchParams would rewrite %20 as +.
			url.search = query;
		} else if (query) {
			const merged = new URLSearchParams(url.search);
			for (const [key, value] of new URLSearchParams(query)) {
				merged.set(key, value);
			}
			url.search = merged.toString();
		}
		url.hash = "";
		return url.toString();
	}
}
