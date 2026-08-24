import type { Config } from "@clankermux/config";
import type { DatabaseOperations } from "@clankermux/database";
import { jsonResponse } from "@clankermux/http-common";
import { createPublicSnapshotReader } from "../../services/public-snapshot";
import { createPublicAccountsHandler } from "./accounts";
import { PUBLIC_SCHEMA } from "./dto";
import { createPublicStatusHandler } from "./status";
import { createPublicStreamHandler } from "./stream";

/**
 * The read-only widget API.
 *
 * A top-level mount, sibling of `/wire/*` and deliberately OUTSIDE `/api/*` so
 * the management session gate never touches it. The consumers are an ESP32 desk
 * panel and a Cinnamon panel applet, neither of which can hold a credential.
 *
 * GET-ONLY, and the constraint is structural rather than a current fact about
 * the routes: an authorized write must never land under this prefix, because
 * the prefix itself is what documents "no credential required". Anything that
 * needs authorization belongs under `/api/*`, behind the session.
 */
export interface PublicRouterDeps {
	dbOps: DatabaseOperations;
	config: Config;
}

export class PublicRouter {
	private readonly handlers: Map<
		string,
		(req: Request) => Promise<Response> | Response
	>;

	constructor({ dbOps, config }: PublicRouterDeps) {
		// One snapshot reader shared by both JSON routes, so the two can never
		// disagree about the pool they are describing.
		const readSnapshot = createPublicSnapshotReader(dbOps, config);
		const statusHandler = createPublicStatusHandler(readSnapshot);
		const accountsHandler = createPublicAccountsHandler(readSnapshot);
		const streamHandler = createPublicStreamHandler();

		this.handlers = new Map<
			string,
			(req: Request) => Promise<Response> | Response
		>([
			["/public/v1/status", () => statusHandler()],
			["/public/v1/accounts", () => accountsHandler()],
			["/public/v1/stream", (req) => streamHandler(req)],
		]);
	}

	/** True when this router owns `path`, whatever the method. */
	has(path: string): boolean {
		return this.handlers.has(path);
	}

	/**
	 * Route one request. Returns null when no route matched, so the caller owns
	 * the 404 for the whole `/public/*` namespace.
	 *
	 * The method gate is here rather than per-route: every route on this surface
	 * is a read, and answering 405 to a POST is what makes "GET-only" a property
	 * of the mount instead of a coincidence of the current route list.
	 */
	async handle(req: Request, url: URL): Promise<Response | null> {
		const handler = this.handlers.get(url.pathname);
		if (!handler) return null;
		if (req.method !== "GET") {
			return jsonResponse(
				{
					schema: PUBLIC_SCHEMA,
					error: "method_not_allowed",
					message: `${url.pathname} is read-only.`,
				},
				405,
				{ Allow: "GET" },
			);
		}
		return await handler(req);
	}
}
