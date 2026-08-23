/**
 * The management gate at the front door.
 *
 * This is the enforcement point that actually gates `/api/*`. The API router
 * returns its response to `routeRootRequest`, which returns it to the client,
 * so a check inside the router would run after the handler had already done its
 * work — and `handleRequest` is reachable from anywhere else holding the
 * router. The property these tests exist to pin down is therefore not "a 401
 * comes back" but "the management router was NEVER CALLED", which is only
 * observable by watching the dependency.
 *
 * The exemptions get individual coverage for the same reason: each one is a
 * different failure if it regresses. Gating the auth endpoints makes logging in
 * require being logged in; gating the two Claude Code telemetry paths breaks
 * agent clients that never had a dashboard cookie; gating an identity-bound
 * path turns a deliberate 501 into an auth failure a CLI reads as a dead
 * session.
 */

import { describe, expect, it } from "bun:test";
import type {
	AuthenticationResult,
	AuthRequirement,
} from "@clankermux/http-api";
import { managementAuthRequirement } from "@clankermux/http-api";
import type { RequestRouterDeps } from "../request-router";
import { routeRequest } from "../request-router";

interface Calls {
	api: { pathname: string; method: string }[];
	publicApi: { pathname: string; method: string }[];
	dispatch: { pathname: string }[];
	auth: { path: string; method: string; requirement?: AuthRequirement }[];
}

interface Options {
	/** A management password is set, so `/api/*` is gated. */
	gated?: boolean;
	/** The request presents a live session cookie. */
	signedIn?: boolean;
	/** Paths the management router claims. */
	apiRoutes?: string[];
	withDashboard?: boolean;
}

function makeDeps(options: Options = {}): {
	deps: RequestRouterDeps;
	calls: Calls;
} {
	const {
		gated = true,
		signedIn = false,
		apiRoutes = [],
		withDashboard = false,
	} = options;

	const calls: Calls = { api: [], publicApi: [], dispatch: [], auth: [] };

	const deps: RequestRouterDeps = {
		async handleApiRequest(url, req) {
			calls.api.push({ pathname: url.pathname, method: req.method });
			return apiRoutes.includes(url.pathname)
				? new Response(JSON.stringify({ handler: "management" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					})
				: null;
		},
		async handlePublicRequest(req, url) {
			calls.publicApi.push({ pathname: url.pathname, method: req.method });
			return url.pathname === "/public/v1/status"
				? new Response(JSON.stringify({ handler: "public" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					})
				: null;
		},
		async authenticate(_req, path, method, requirement) {
			calls.auth.push({ path, method, requirement });
			const effective = requirement ?? managementAuthRequirement(path);
			if (effective === "session") {
				// Mirrors SessionAuthService.authorizeRequest: fail-open until a
				// password exists, then a live cookie is required.
				if (!gated || signedIn) return { isAuthenticated: true };
				return {
					isAuthenticated: false,
					error: "Sign in to use the management API",
				} satisfies AuthenticationResult;
			}
			return { isAuthenticated: true };
		},
		async dispatchProxy(_req, url) {
			calls.dispatch.push({ pathname: url.pathname });
			return new Response(JSON.stringify({ handler: "proxy" }), {
				status: 200,
			});
		},
		async handleResponses() {
			return new Response("{}", { status: 200 });
		},
		handleModels() {
			return new Response("{}", { status: 200 });
		},
		withDashboard,
		dashboardManifest: withDashboard
			? { "/assets/app.js": "/assets/app.js" }
			: null,
		serveDashboardFile(assetPath) {
			return new Response(`<!-- ${assetPath} -->`, { status: 200 });
		},
	};

	return { deps, calls };
}

function request(
	path: string,
	init: { method?: string; headers?: Record<string, string> } = {},
): Request {
	return new Request(`http://localhost:8090${path}`, {
		method: init.method ?? "GET",
		headers: init.headers,
	});
}

const GATED_PATHS = [
	// exact
	"/api/accounts",
	"/api/config",
	"/api/stats",
	// dynamic
	"/api/accounts/f3a1-2b7c/pause",
	"/api/requests/payload/abc123",
	// unknown — an unrouted management URL must not be a way to probe either
	"/api/not-a-real-route",
	// the bare namespace root
	"/api",
];

describe("a gated deployment refuses management requests without a session", () => {
	for (const path of GATED_PATHS) {
		it(`answers 401 for GET ${path} and never calls the API router`, async () => {
			const { deps, calls } = makeDeps();
			const res = await routeRequest(request(path), deps);
			expect(res.status).toBe(401);
			expect(calls.api).toEqual([]);
		});
	}

	for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
		it(`answers 401 for a mutating ${method} and never calls the API router`, async () => {
			const { deps, calls } = makeDeps();
			const res = await routeRequest(
				request("/api/accounts/f3a1/pause", { method }),
				deps,
			);
			expect(res.status).toBe(401);
			expect(calls.api).toEqual([]);
		});
	}

	it("passes the requirement EXPLICITLY rather than letting it be inferred", async () => {
		const { deps, calls } = makeDeps();
		await routeRequest(request("/api/accounts"), deps);
		expect(calls.auth).toEqual([
			{ path: "/api/accounts", method: "GET", requirement: "session" },
		]);
	});

	it("reports the refusal as a JSON authentication error", async () => {
		const { deps } = makeDeps();
		const res = await routeRequest(request("/api/accounts"), deps);
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(await res.json()).toEqual({
			type: "error",
			error: {
				type: "authentication_error",
				message: "Sign in to use the management API",
			},
		});
	});

	it("does not serve the dashboard shell in place of a refused API route", async () => {
		const { deps, calls } = makeDeps({ withDashboard: true });
		const res = await routeRequest(request("/api/accounts"), deps);
		expect(res.status).toBe(401);
		expect(calls.api).toEqual([]);
	});
});

describe("a gated deployment serves management requests that carry a session", () => {
	it("reaches the API router", async () => {
		const { deps, calls } = makeDeps({
			signedIn: true,
			apiRoutes: ["/api/accounts"],
		});
		const res = await routeRequest(request("/api/accounts"), deps);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ handler: "management" });
		expect(calls.api).toEqual([{ pathname: "/api/accounts", method: "GET" }]);
	});

	it("still 404s an unknown management route rather than falling through", async () => {
		const { deps } = makeDeps({ signedIn: true });
		const res = await routeRequest(request("/api/not-a-real-route"), deps);
		expect(res.status).toBe(404);
	});
});

describe("an ungated deployment is unchanged", () => {
	for (const path of GATED_PATHS) {
		it(`serves ${path} with no cookie at all`, async () => {
			const { deps, calls } = makeDeps({ gated: false, apiRoutes: [path] });
			const res = await routeRequest(request(path), deps);
			expect(res.status).toBe(200);
			expect(calls.api).toEqual([{ pathname: path, method: "GET" }]);
		});
	}
});

describe("exempt paths", () => {
	for (const path of [
		"/api/auth/login",
		"/api/auth/logout",
		"/api/auth/status",
	]) {
		it(`reaches the API router for ${path} on a gated deployment`, async () => {
			const { deps, calls } = makeDeps({ apiRoutes: [path] });
			const res = await routeRequest(request(path, { method: "POST" }), deps);
			expect(res.status).toBe(200);
			expect(calls.api).toHaveLength(1);
		});
	}

	for (const path of [
		"/api/event_logging/batch",
		"/api/system/package-manager",
	]) {
		it(`lets the Claude Code telemetry path ${path} reach the proxy on a gated deployment`, async () => {
			const { deps, calls } = makeDeps();
			const res = await routeRequest(request(path, { method: "POST" }), deps);
			expect(res.status).toBe(200);
			expect(calls.dispatch).toEqual([{ pathname: path }]);
		});
	}

	it("does not exempt the /v2/ spelling of the telemetry path at the root", async () => {
		const { deps, calls } = makeDeps();
		const res = await routeRequest(
			request("/api/event_logging/v2/batch", { method: "POST" }),
			deps,
		);
		expect(res.status).toBe(401);
		expect(calls.dispatch).toEqual([]);
	});
});

describe("identity-bound refusals outrank the gate", () => {
	for (const path of [
		"/api/oauth/profile",
		"/api/oauth/file_upload",
		"/api/oauth/files/abc",
	]) {
		it(`refuses ${path} with 501, not 401, on a gated deployment`, async () => {
			const { deps, calls } = makeDeps();
			const res = await routeRequest(request(path), deps);
			// An agent client reads an auth failure as a dead session; the whole
			// point of this refusal is that it says "not served", not "not you".
			expect(res.status).toBe(501);
			expect(calls.auth).toEqual([]);
			expect(calls.api).toEqual([]);
		});
	}

	it("still refuses the /v1/code surface", async () => {
		const { deps } = makeDeps();
		const res = await routeRequest(request("/v1/code/sessions"), deps);
		expect(res.status).toBe(501);
	});
});

describe("surfaces outside the management namespace stay ungated", () => {
	it("leaves upstream AI traffic on its API-key policy", async () => {
		const { deps, calls } = makeDeps();
		const res = await routeRequest(
			request("/v1/messages", { method: "POST" }),
			deps,
		);
		expect(res.status).toBe(200);
		expect(calls.dispatch).toEqual([{ pathname: "/v1/messages" }]);
		// One auth call, and it was not the session one.
		expect(calls.auth.map((c) => c.requirement)).toEqual([undefined]);
	});

	it("leaves the wire mounts on their explicit api_key requirement", async () => {
		const { deps, calls } = makeDeps();
		const res = await routeRequest(
			request("/wire/anthropic/v1/messages", { method: "POST" }),
			deps,
		);
		expect(res.status).toBe(200);
		expect(calls.auth.map((c) => c.requirement)).toEqual(["api_key"]);
	});

	it("serves the widget API on a gated deployment, with no cookie", async () => {
		const { deps, calls } = makeDeps();
		const res = await routeRequest(request("/public/v1/status"), deps);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ handler: "public" });
		// The gate must not even have been consulted: `/public/*` is a sibling of
		// the wire mounts, not a carve-out inside `/api/*`.
		expect(calls.auth).toEqual([]);
		expect(calls.api).toEqual([]);
	});

	it("404s an unknown widget route instead of leaking it to the proxy or the shell", async () => {
		const { deps, calls } = makeDeps({ withDashboard: true });
		const res = await routeRequest(request("/public/v1/nope"), deps);
		expect(res.status).toBe(404);
		expect(calls.dispatch).toEqual([]);
	});

	it("serves the dashboard shell for a client-side route", async () => {
		const { deps } = makeDeps({ withDashboard: true });
		const res = await routeRequest(request("/accounts"), deps);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("/index.html");
	});
});
