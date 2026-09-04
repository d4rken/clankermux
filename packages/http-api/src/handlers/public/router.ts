import type { Config } from "@clankermux/config";
import type { DatabaseOperations } from "@clankermux/database";
import { jsonResponse } from "@clankermux/http-common";
import type { LoadBalancingStrategy } from "@clankermux/types";
import { createPublicPacingReader } from "../../services/public-pacing";
import { createPublicRunwayReader } from "../../services/public-runway";
import { createPublicSnapshotReader } from "../../services/public-snapshot";
import { createPublicStopsReader } from "../../services/public-stops";
import { createPublicWorkloadHeadroomReader } from "../../services/public-workload-headroom";
import { createPublicAccountsHandler } from "./accounts";
import { NO_STORE_HEADERS } from "./cache-headers";
import { createPublicPacingHandler } from "./pacing";
import { createPublicRunwayHandler } from "./runway";
import { createPublicStatusHandler } from "./status";
import { createPublicStopsHandler } from "./stops";
import { createPublicStreamHandler } from "./stream";
import { createPublicWorkloadHeadroomHandler } from "./workload-headroom";

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
	/**
	 * The live load-balancing strategy, for the routing prediction `status` and
	 * `accounts` publish. Optional so a test can mount the router without one;
	 * absent means the routing context cannot be evaluated and both the candidate
	 * and the count derived from it say so.
	 */
	getStrategy?: () => LoadBalancingStrategy | null;
}

export class PublicRouter {
	private readonly handlers: Map<
		string,
		(req: Request) => Promise<Response> | Response
	>;

	constructor({ dbOps, config, getStrategy }: PublicRouterDeps) {
		// One snapshot reader shared by both pool routes, so the two can never
		// disagree about the pool they are describing.
		const readSnapshot = createPublicSnapshotReader(dbOps, config, getStrategy);
		const statusHandler = createPublicStatusHandler(readSnapshot);
		const accountsHandler = createPublicAccountsHandler(readSnapshot);
		// The runway has its own reader: it is a different, much more expensive
		// computation, and folding it into the shared snapshot would make every
		// `status` poll pay for a scan nobody asked for.
		const runwayHandler = createPublicRunwayHandler(
			createPublicRunwayReader(dbOps),
		);
		// Its own reader too, and for the same reason: a scan of the request table
		// is not something a `status` poll should pay for. Memoized inside the
		// reader, so the isolation costs nothing per caller.
		const stopsHandler = createPublicStopsHandler(
			createPublicStopsReader(dbOps),
		);
		// Its own reader again, and for the sharpest version of the same reason.
		// The pacing scan builds the FULL account list — session stats, snapshots,
		// prediction regressions, duplicate detection — because computing pacing
		// from anything narrower would let it drift from the account bars it sits
		// beside. The memo is what stops an anonymous poll loop deciding how often
		// that is paid for.
		const pacingHandler = createPublicPacingHandler(
			createPublicPacingReader(dbOps, config, getStrategy),
		);
		// Shares the runway SCAN (not its reader): the workload rows are that same
		// resolution viewed per class and per family, so a second scan here could
		// disagree with the runway resource about the pool at one instant. Its own
		// memo, because each row runs a pace probe on top.
		const workloadHeadroomHandler = createPublicWorkloadHeadroomHandler(
			createPublicWorkloadHeadroomReader(dbOps),
		);
		const streamHandler = createPublicStreamHandler();

		this.handlers = new Map<
			string,
			(req: Request) => Promise<Response> | Response
		>([
			["/public/v1/status", () => statusHandler()],
			["/public/v1/accounts", () => accountsHandler()],
			["/public/v1/runway", () => runwayHandler()],
			["/public/v1/stops", () => stopsHandler()],
			["/public/v1/pacing", () => pacingHandler()],
			["/public/v1/workload-headroom", () => workloadHeadroomHandler()],
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
					error: "method_not_allowed",
					message: `${url.pathname} is read-only.`,
				},
				405,
				{ ...NO_STORE_HEADERS, Allow: "GET" },
			);
		}
		return await handler(req);
	}
}
