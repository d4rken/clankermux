/**
 * Serve a worktree's built dashboard against the LIVE server's data.
 *
 * QA on a dashboard change needs the real account set: a second backend on a
 * fresh database has no accounts to render, and a second backend on the live
 * database would race the running server's OAuth refresh-token rotation — two
 * processes refreshing the same token invalidates one of them, which costs a
 * re-auth. So this serves only static bundle files itself and forwards the data
 * reads to the server that is already running.
 *
 * READ-ONLY BY CONSTRUCTION. The upstream is a production instance with real
 * accounts, so the guard is a denylist that answers 405 rather than a promise
 * that the reviewer will not click anything: GET and HEAD pass, the two auth
 * endpoints pass because signing in is what makes the reads work, `/api/debug/*`
 * is refused outright, and everything else under the API prefixes is refused.
 *
 * LOOPBACK ONLY. It forwards an authenticated management session; binding it to
 * a routable interface would publish that session to the network.
 *
 * Usage: bun run preview:dashboard -- --port 8095 --upstream http://127.0.0.1:8090
 */

const DEFAULT_PORT = 8095;
const DEFAULT_UPSTREAM = "http://127.0.0.1:8090";
const UPSTREAM_TIMEOUT_MS = 15_000;

/** Prefixes whose requests belong to the upstream server, not to the bundle. */
const FORWARDED_PREFIXES = ["/api/", "/public/"] as const;

/** Always refused: these expose server internals and can mutate state. */
const DEBUG_PREFIX = "/api/debug/";

/** Non-GET endpoints that must work, because nothing else does without them. */
const ALLOWED_MUTATIONS = new Set(["/api/auth/login", "/api/auth/logout"]);

/**
 * Hop-by-hop headers, plus `host`. Forwarding these corrupts the upstream
 * connection: `host` would name this proxy, and a `transfer-encoding` copied
 * onto a body `fetch` re-frames desynchronises the response.
 */
const STRIPPED_REQUEST_HEADERS = [
	"host",
	"connection",
	"keep-alive",
	"transfer-encoding",
	"upgrade",
];

function parseArgs(argv: string[]): { port: number; upstream: string } {
	let port = DEFAULT_PORT;
	let upstream = DEFAULT_UPSTREAM;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--port") {
			const value = Number(argv[++i]);
			if (!Number.isInteger(value) || value <= 0) {
				throw new Error(`--port expects a positive integer, got ${argv[i]}`);
			}
			port = value;
		} else if (arg === "--upstream") {
			const value = argv[++i];
			if (!value) throw new Error("--upstream expects a URL");
			upstream = value.replace(/\/$/, "");
		} else {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	return { port, upstream };
}

function isForwardedPath(pathname: string): boolean {
	return FORWARDED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function refused(): Response {
	return Response.json(
		{ error: "dashboard-preview is read-only" },
		{ status: 405 },
	);
}

function forwardableHeaders(request: Request): Headers {
	const headers = new Headers(request.headers);
	for (const name of STRIPPED_REQUEST_HEADERS) headers.delete(name);
	// `proxy-*` is a family rather than a fixed list, so it is matched by prefix.
	// Collected first: deleting from a Headers mid-iteration skips entries.
	const proxyHeaders: string[] = [];
	headers.forEach((_value, name) => {
		if (name.toLowerCase().startsWith("proxy-")) proxyHeaders.push(name);
	});
	for (const name of proxyHeaders) headers.delete(name);
	return headers;
}

async function forward(request: Request, upstream: string): Promise<Response> {
	const url = new URL(request.url);
	const target = `${upstream}${url.pathname}${url.search}`;
	try {
		const upstreamResponse = await fetch(target, {
			method: request.method,
			headers: forwardableHeaders(request),
			body:
				request.method === "GET" || request.method === "HEAD"
					? undefined
					: await request.arrayBuffer(),
			redirect: "manual",
			signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
		});
		// Returned as-is, `set-cookie` included: the session cookie the login
		// endpoint issues is what every subsequent read depends on.
		return new Response(upstreamResponse.body, {
			status: upstreamResponse.status,
			statusText: upstreamResponse.statusText,
			headers: upstreamResponse.headers,
		});
	} catch (error) {
		return Response.json(
			{
				error: "upstream unreachable",
				upstream: target,
				detail: error instanceof Error ? error.message : String(error),
			},
			{ status: 502 },
		);
	}
}

const { port, upstream } = parseArgs(Bun.argv.slice(2));
const distDir = new URL("../packages/dashboard-web/dist/", import.meta.url)
	.pathname;

const server = Bun.serve({
	// Loopback only. See the header comment: this carries a live management
	// session.
	hostname: "127.0.0.1",
	port,
	async fetch(request) {
		const url = new URL(request.url);

		if (isForwardedPath(url.pathname)) {
			if (url.pathname.startsWith(DEBUG_PREFIX)) return refused();
			if (request.method === "GET" || request.method === "HEAD") {
				return forward(request, upstream);
			}
			if (
				request.method === "POST" &&
				ALLOWED_MUTATIONS.has(url.pathname)
			) {
				return forward(request, upstream);
			}
			return refused();
		}

		const file = Bun.file(`${distDir}${url.pathname.replace(/^\//, "")}`);
		if (url.pathname !== "/" && (await file.exists())) {
			return new Response(file);
		}
		// SPA fallback: the dashboard routes client-side, so any unknown path
		// that is not a bundle file is a route, not a 404.
		return new Response(Bun.file(`${distDir}index.html`), {
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	},
});

console.log(
	`dashboard-preview serving ${distDir} on http://127.0.0.1:${server.port} (read-only, upstream ${upstream})`,
);
