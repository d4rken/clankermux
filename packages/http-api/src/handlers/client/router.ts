import type { Config } from "@clankermux/config";
import {
	type DatabaseOperations,
	RequestRepository,
} from "@clankermux/database";
import { jsonResponse } from "@clankermux/http-common";
import { CLIENT_NO_STORE_HEADERS } from "./cache-headers";
import {
	createClientRequestByIdHandler,
	createClientRequestSearchHandler,
} from "./requests";

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
	dbOps: DatabaseOperations;
}

/** The authenticated identity every route on this surface is scoped to. */
export interface ClientRequestContext {
	/** The api-key row the mount authenticated. Never absent. */
	apiKeyId: string;
}

type ClientHandler = (
	req: Request,
	url: URL,
	ctx: ClientRequestContext,
	/** The matched pattern's capture groups, in order. Empty for exact paths. */
	params: readonly string[],
) => Promise<Response> | Response;

/**
 * A route whose path carries a value.
 *
 * The pattern is anchored over the WHOLE path and its capture is
 * segment-bounded (`[^/]+`), the same shape `client-api-mount.ts` and
 * `wire-mounts.ts` use and for the same reason: an unanchored or
 * slash-swallowing pattern claims paths nobody wrote down, and every other
 * predicate in the pipeline matches exactly, so none of them would report the
 * surprise.
 */
interface ClientPatternRoute {
	pattern: RegExp;
	handler: ClientHandler;
}

export class ClientRouter {
	private readonly handlers: Map<string, ClientHandler>;
	/**
	 * Tried IN ORDER, and only after the exact map misses. Exact paths therefore
	 * keep winning over any pattern that could also match them.
	 */
	private readonly patterns: readonly ClientPatternRoute[];

	constructor({ config, dbOps }: ClientRouterDeps) {
		// A thin wrapper over the adapter, built once per router rather than per
		// request — the same way `createPublicStopsReader` builds its own.
		const requests = new RequestRepository(dbOps.getAdapter());
		const readById = createClientRequestByIdHandler(requests);
		const searchByTag = createClientRequestSearchHandler(requests);

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
			["/client/v1/requests", (_req, url, ctx) => searchByTag(url, ctx)],
		]);

		this.patterns = [
			{
				pattern: /^\/client\/v1\/requests\/([^/]+)$/,
				// The captured segment is an OPAQUE LITERAL. Request ids are
				// `crypto.randomUUID()` values, so a percent-encoded spelling is not
				// an id this proxy ever issued; decoding it would invent a second
				// spelling for one row and hand this surface a key the recorder never
				// wrote.
				handler: (_req, _url, ctx, params) => readById(params[0], ctx),
			},
		];
	}

	/** True when this router owns `path`, whatever the method. */
	has(path: string): boolean {
		return this.match(path) !== null;
	}

	/**
	 * Route one request. Returns null when no route matched, so the caller owns
	 * the 404 for the whole `/client/*` namespace — the mount claims more paths
	 * than this router serves.
	 *
	 * The method gate is here rather than per-route, which is what makes
	 * "GET-only" a property of the prefix instead of a coincidence of the routes
	 * above.
	 */
	async handle(
		req: Request,
		url: URL,
		ctx: ClientRequestContext,
	): Promise<Response | null> {
		const matched = this.match(url.pathname);
		if (!matched) return null;
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
		return await matched.handler(req, url, ctx, matched.params);
	}

	private match(
		path: string,
	): { handler: ClientHandler; params: readonly string[] } | null {
		const exact = this.handlers.get(path);
		if (exact) return { handler: exact, params: [] };
		for (const route of this.patterns) {
			const found = route.pattern.exec(path);
			if (found) return { handler: route.handler, params: found.slice(1) };
		}
		return null;
	}
}
