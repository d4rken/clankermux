import type { Config } from "@clankermux/config";
import { jsonResponse } from "@clankermux/http-common";
import { CLIENT_NO_STORE_HEADERS } from "./cache-headers";

/**
 * The read-only client API.
 *
 * A top-level mount, sibling of `/wire/*` and `/public/*` and deliberately
 * OUTSIDE `/api/*` so the management session gate never touches it (see
 * `apps/server/src/client-api-mount.ts`). Unlike the widget surface this one is
 * CREDENTIAL-SCOPED: the caller presents the same client key it proxies AI
 * traffic with, and every route is scoped to that key's own requests.
 *
 * GET-ONLY, and structurally so rather than as a fact about the current route
 * list: the mount authenticates with a key that can also spend money on the
 * proxy, so a write must never become reachable here by someone adding a route.
 */
export interface ClientRouterDeps {
	config: Config;
}

/** The authenticated identity every route on this surface is scoped to. */
export interface ClientRequestContext {
	/** The api-key row the mount authenticated. Never absent. */
	apiKeyId: string;
}

type ClientHandler = (
	req: Request,
	ctx: ClientRequestContext,
) => Promise<Response> | Response;

export class ClientRouter {
	private readonly handlers: Map<string, ClientHandler>;

	constructor({ config }: ClientRouterDeps) {
		this.handlers = new Map<string, ClientHandler>([
			[
				"/client/v1/retention",
				// How long a request stays readable here. A client reconciling its own
				// accounting has to bound the window it asks about, and the only
				// alternative to publishing the number is an out-of-band agreement
				// with whoever set it.
				() =>
					jsonResponse(
						{ requestRetentionDays: config.getRequestRetentionDays() },
						200,
						CLIENT_NO_STORE_HEADERS,
					),
			],
		]);
	}

	/** True when this router owns `path`, whatever the method. */
	has(path: string): boolean {
		return this.handlers.has(path);
	}

	/**
	 * Route one request. Returns null when no route matched, so the caller owns
	 * the 404 for the whole `/client/*` namespace — the mount claims more paths
	 * than this router serves.
	 *
	 * The method gate is here rather than per-route, which is what makes
	 * "GET-only" a property of the prefix instead of a coincidence of the map
	 * above.
	 */
	async handle(
		req: Request,
		url: URL,
		ctx: ClientRequestContext,
	): Promise<Response | null> {
		const handler = this.handlers.get(url.pathname);
		if (!handler) return null;
		if (req.method !== "GET") {
			return jsonResponse(
				{
					error: "method_not_allowed",
					message: `${url.pathname} is read-only.`,
				},
				405,
				{ ...CLIENT_NO_STORE_HEADERS, Allow: "GET" },
			);
		}
		return await handler(req, ctx);
	}
}
