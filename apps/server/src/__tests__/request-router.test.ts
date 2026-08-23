/**
 * The front-door routing, exercised end to end through the real router with
 * every dependency injected.
 *
 * What these tests are for: the three namespaces on this port are invisible to
 * each other, so a request that ends up in the wrong one does not fail — it
 * gets a plausible answer from the wrong handler. The failure this whole change
 * exists to remove was exactly that shape (`/api/event_logging/v2/batch`
 * collecting our management 404 instead of reaching Anthropic), and the failure
 * it must not introduce is its mirror image (an Anthropic path being answered
 * with our unauthenticated management JSON). Both are only observable by
 * watching WHICH dependency was called, which is why they are spies rather than
 * real handlers.
 */

import { describe, expect, it } from "bun:test";
import type {
	AuthenticationResult,
	AuthRequirement,
} from "@clankermux/http-api";
import type { RequestRouterDeps } from "../request-router";
import { routeRequest } from "../request-router";

interface Calls {
	api: { pathname: string }[];
	dispatch: { pathname: string; search: string; apiKeyId?: string | null }[];
	responses: { pathname: string; search: string }[];
	models: number;
	dashboard: { assetPath: string }[];
	auth: { path: string; method: string; requirement?: AuthRequirement }[];
}

interface Options {
	/** Paths the management router claims. It answers with a marker body. */
	apiRoutes?: string[];
	withDashboard?: boolean;
	dashboardManifest?: Record<string, string> | null;
	/** Present a valid key. Absent means the request carries none. */
	authenticated?: boolean;
}

function makeDeps(options: Options = {}): {
	deps: RequestRouterDeps;
	calls: Calls;
} {
	const {
		apiRoutes = [],
		withDashboard = true,
		dashboardManifest = { "/assets/app.js": "/assets/app.js" },
		authenticated = true,
	} = options;

	const calls: Calls = {
		api: [],
		dispatch: [],
		responses: [],
		models: 0,
		dashboard: [],
		auth: [],
	};

	const deps: RequestRouterDeps = {
		async handleApiRequest(url) {
			calls.api.push({ pathname: url.pathname });
			return apiRoutes.includes(url.pathname)
				? new Response(JSON.stringify({ handler: "management" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					})
				: null;
		},
		async authenticate(_req, path, method, requirement) {
			calls.auth.push({ path, method, requirement });
			// Mirrors the auth service's shape closely enough to route on: an
			// explicit requirement wins, otherwise the path policy decides, and
			// only api-key surfaces can reject.
			const effective: AuthRequirement =
				requirement ??
				(path === "/v1" ||
				path.startsWith("/v1/") ||
				path === "/messages" ||
				path.startsWith("/messages/")
					? "api_key"
					: "public");
			if (effective === "public") return { isAuthenticated: true };
			if (!authenticated) {
				return {
					isAuthenticated: false,
					error: "API key required. Include it in the 'x-api-key' header",
				} satisfies AuthenticationResult;
			}
			return { isAuthenticated: true, apiKeyId: "key-1", apiKeyName: "test" };
		},
		async dispatchProxy(_req, url, apiKeyId) {
			calls.dispatch.push({
				pathname: url.pathname,
				search: url.search,
				apiKeyId,
			});
			return new Response(JSON.stringify({ handler: "proxy" }), {
				status: 200,
			});
		},
		async handleResponses(_req, url) {
			calls.responses.push({ pathname: url.pathname, search: url.search });
			return new Response(JSON.stringify({ handler: "responses" }), {
				status: 200,
			});
		},
		handleModels() {
			calls.models++;
			return new Response(JSON.stringify({ handler: "models" }), {
				status: 200,
			});
		},
		withDashboard,
		dashboardManifest,
		serveDashboardFile(assetPath) {
			calls.dashboard.push({ assetPath });
			return new Response(`<!doctype html><!-- ${assetPath} -->`, {
				status: 200,
				headers: { "Content-Type": "text/html" },
			});
		},
	};

	return { deps, calls };
}

function makeRequest(
	path: string,
	init: { method?: string; headers?: Record<string, string> } = {},
): Request {
	return new Request(`http://localhost:8090${path}`, {
		method: init.method ?? "GET",
		headers: init.headers,
	});
}

const withKey = { "x-api-key": "btr-test" };

describe("mounted agent traffic", () => {
	// The motivating route. Claude Code 2.1.241 posts telemetry to
	// /api/event_logging/v2/batch; at the root that collects our
	// `Unknown API route` 404 because we only enumerate the older v1 spelling.
	// On the mount it is simply forwarded, which is the forward-compatibility
	// prize the whole design is for.
	it("forwards an unenumerated Anthropic /api path, preserving the query", async () => {
		const { deps, calls } = makeDeps({
			apiRoutes: ["/api/system/status"],
		});
		const res = await routeRequest(
			makeRequest("/wire/anthropic/api/event_logging/v2/batch?trace=abc&n=2", {
				method: "POST",
				headers: withKey,
			}),
			deps,
		);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ handler: "proxy" });
		expect(calls.dispatch).toEqual([
			{
				pathname: "/api/event_logging/v2/batch",
				search: "?trace=abc&n=2",
				apiKeyId: "key-1",
			},
		]);
		// The strip is what makes the canonical path safe downstream, and the
		// management router must never see a mounted request at all.
		expect(calls.api).toEqual([]);
	});

	// The mirror-image failure: a management route we own that Anthropic also
	// uses. On the mount, ours must not answer.
	it("does not let a mounted path fall into a colliding management route", async () => {
		const { deps, calls } = makeDeps({ apiRoutes: ["/api/system/status"] });
		const res = await routeRequest(
			makeRequest("/wire/anthropic/api/system/status", { headers: withKey }),
			deps,
		);

		expect(await res.json()).toEqual({ handler: "proxy" });
		expect(calls.api).toEqual([]);
		expect(calls.dispatch.map((c) => c.pathname)).toEqual([
			"/api/system/status",
		]);
	});

	it("routes /v1/messages under the anthropic mount to dispatch", async () => {
		const { deps, calls } = makeDeps();
		const res = await routeRequest(
			makeRequest("/wire/anthropic/v1/messages", {
				method: "POST",
				headers: withKey,
			}),
			deps,
		);

		expect(res.status).toBe(200);
		expect(calls.dispatch.map((c) => c.pathname)).toEqual(["/v1/messages"]);
	});

	it("routes the OpenAI mount's own routes to their handlers", async () => {
		const { deps, calls } = makeDeps();

		const responses = await routeRequest(
			makeRequest("/wire/openai/v1/responses", {
				method: "POST",
				headers: withKey,
			}),
			deps,
		);
		expect(await responses.json()).toEqual({ handler: "responses" });
		expect(calls.responses).toEqual([
			{ pathname: "/v1/responses", search: "" },
		]);

		const models = await routeRequest(
			makeRequest("/wire/openai/v1/models", { headers: withKey }),
			deps,
		);
		expect(await models.json()).toEqual({ handler: "models" });
		expect(calls.models).toBe(1);
		expect(calls.dispatch).toEqual([]);
	});

	it("rejects a WebSocket upgrade on the mounted Responses path", async () => {
		const { deps, calls } = makeDeps();
		const res = await routeRequest(
			makeRequest("/wire/openai/v1/responses", {
				method: "POST",
				headers: { ...withKey, upgrade: "websocket" },
			}),
			deps,
		);

		expect(res.status).toBe(503);
		expect(calls.responses).toEqual([]);
	});

	// A bare mount has no path of its own. It is forwarded like any other
	// unrecognized Anthropic path rather than being special-cased.
	it("treats a bare anthropic mount as the dialect root", async () => {
		const { deps, calls } = makeDeps();
		await routeRequest(
			makeRequest("/wire/anthropic", { headers: withKey }),
			deps,
		);
		expect(calls.dispatch.map((c) => c.pathname)).toEqual(["/"]);
	});
});

describe("mount gating", () => {
	it("404s an OpenAI-only route under the anthropic mount, naming the right mount", async () => {
		const { deps, calls } = makeDeps();
		const res = await routeRequest(
			makeRequest("/wire/anthropic/v1/responses", {
				method: "POST",
				headers: withKey,
			}),
			deps,
		);

		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toContain("/wire/openai");
		expect(calls.dispatch).toEqual([]);
		expect(calls.responses).toEqual([]);
	});

	it("404s an Anthropic route under the openai mount, naming the right mount", async () => {
		const { deps, calls } = makeDeps();
		const res = await routeRequest(
			makeRequest("/wire/openai/v1/messages", {
				method: "POST",
				headers: withKey,
			}),
			deps,
		);

		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toContain("/wire/anthropic");
		expect(calls.dispatch).toEqual([]);
	});

	// The namespace is ours in its entirety, so a misconfigured base URL fails
	// visibly instead of being handed the dashboard's HTML.
	it("404s an unknown dialect and the bare namespace root", async () => {
		for (const path of ["/wire/gemini/v1/messages", "/wire", "/wire/"]) {
			const { deps, calls } = makeDeps();
			const res = await routeRequest(
				makeRequest(path, { headers: withKey }),
				deps,
			);
			expect(res.status).toBe(404);
			expect(res.headers.get("Content-Type")).toBe("application/json");
			expect(calls.dashboard).toEqual([]);
			expect(calls.dispatch).toEqual([]);
			expect(calls.api).toEqual([]);
		}
	});

	it("refuses an identity-bound endpoint on the mount", async () => {
		const { deps, calls } = makeDeps();
		const res = await routeRequest(
			makeRequest("/wire/anthropic/api/oauth/file_upload", {
				method: "POST",
				headers: withKey,
			}),
			deps,
		);

		expect(res.status).toBe(501);
		expect(res.headers.get("x-clankermux-refusal")).toBe(
			"identity-bound-endpoint",
		);
		expect(calls.dispatch).toEqual([]);
	});
});

describe("mounted authentication", () => {
	it("401s a mounted request that carries no key", async () => {
		const { deps, calls } = makeDeps({ authenticated: false });
		const res = await routeRequest(
			makeRequest("/wire/anthropic/v1/messages", { method: "POST" }),
			deps,
		);

		expect(res.status).toBe(401);
		expect(calls.dispatch).toEqual([]);
	});

	// The mount's gates sit BEHIND authentication on purpose: an anonymous
	// caller must not be able to probe which endpoints are refused, and every
	// request on this mount has to be attributable to a key.
	it("authenticates before refusing or gating", async () => {
		for (const path of [
			"/wire/anthropic/api/oauth/file_upload",
			"/wire/anthropic/v1/responses",
			"/wire/openai/v1/messages",
		]) {
			const { deps } = makeDeps({ authenticated: false });
			const res = await routeRequest(
				makeRequest(path, { method: "POST" }),
				deps,
			);
			expect(res.status).toBe(401);
		}
	});

	// The auth service infers a policy from the path, and a stripped
	// `/api/event_logging/v2/batch` reads as public management surface to it.
	// The router therefore states the requirement instead of leaving it to be
	// inferred; without this the mounted /api/* surface would be wide open.
	it("states the api_key requirement explicitly, on the canonical path", async () => {
		const { deps, calls } = makeDeps();
		await routeRequest(
			makeRequest("/wire/anthropic/api/event_logging/v2/batch", {
				method: "POST",
				headers: withKey,
			}),
			deps,
		);

		expect(calls.auth).toEqual([
			{
				path: "/api/event_logging/v2/batch",
				method: "POST",
				requirement: "api_key",
			},
		]);
	});
});

describe("the legacy root flow is unchanged", () => {
	it("answers management routes from the API router", async () => {
		const { deps, calls } = makeDeps({ apiRoutes: ["/api/system/status"] });
		const res = await routeRequest(makeRequest("/api/system/status"), deps);

		expect(await res.json()).toEqual({ handler: "management" });
		expect(calls.dispatch).toEqual([]);
	});

	it("404s an unknown /api route", async () => {
		const { deps, calls } = makeDeps();
		const res = await routeRequest(makeRequest("/api/not-a-route"), deps);

		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toBe("Unknown API route: /api/not-a-route");
		expect(calls.dispatch).toEqual([]);
	});

	it("passes Claude Code's own root telemetry paths to the proxy", async () => {
		const { deps, calls } = makeDeps();
		await routeRequest(
			makeRequest("/api/event_logging/batch", { method: "POST" }),
			deps,
		);
		await routeRequest(makeRequest("/api/system/package-manager"), deps);

		expect(calls.dispatch.map((c) => c.pathname)).toEqual([
			"/api/event_logging/batch",
			"/api/system/package-manager",
		]);
	});

	it("proxies root /v1 and /messages traffic", async () => {
		const { deps, calls } = makeDeps();
		await routeRequest(
			makeRequest("/v1/messages", { method: "POST", headers: withKey }),
			deps,
		);
		await routeRequest(
			makeRequest("/messages", { method: "POST", headers: withKey }),
			deps,
		);

		expect(calls.dispatch.map((c) => c.pathname)).toEqual([
			"/v1/messages",
			"/messages",
		]);
	});

	it("refuses identity-bound endpoints at the root, before authenticating", async () => {
		const { deps, calls } = makeDeps({ authenticated: false });
		const res = await routeRequest(makeRequest("/v1/code/sessions"), deps);

		// Root /api/* is genuinely public, so the refusal must stay reachable
		// without a key — the opposite ordering from the mount.
		expect(res.status).toBe(501);
		expect(calls.auth).toEqual([]);
		expect(calls.dispatch).toEqual([]);
	});

	it("serves dashboard assets and client routes when the dashboard is on", async () => {
		const { deps, calls } = makeDeps();
		await routeRequest(makeRequest("/assets/app.js"), deps);
		await routeRequest(makeRequest("/dashboard/accounts"), deps);

		expect(calls.dashboard.map((c) => c.assetPath)).toEqual([
			"/assets/app.js",
			"/index.html",
		]);
		expect(calls.dispatch).toEqual([]);
	});

	it("does not answer root /v1 traffic with the dashboard", async () => {
		const { deps, calls } = makeDeps();
		await routeRequest(
			makeRequest("/v1/messages", { method: "POST", headers: withKey }),
			deps,
		);
		expect(calls.dashboard).toEqual([]);
	});
});

describe("headless mode routes like dashboard mode", () => {
	// The proxy boundary used to be tested INSIDE the dashboard branch, so with
	// the dashboard off it never ran: any unrecognized path authenticated as
	// public and went upstream on a pooled account. Now it is a 404 in both
	// modes.
	// Both ways the dashboard can be absent: switched off, and enabled but with
	// no assets built.
	const headlessConfigs: Options[] = [
		{ withDashboard: false, dashboardManifest: { "/assets/app.js": "/x.js" } },
		{ withDashboard: true, dashboardManifest: null },
	];

	it("404s an unknown root path instead of proxying it", async () => {
		for (const config of headlessConfigs) {
			const { deps, calls } = makeDeps(config);
			const res = await routeRequest(makeRequest("/dashboard/accounts"), deps);

			expect(res.status).toBe(404);
			expect(res.headers.get("Content-Type")).toBe("application/json");
			expect(calls.dispatch).toEqual([]);
			expect(calls.auth).toEqual([]);
		}
	});

	it("still proxies real agent traffic with the dashboard off", async () => {
		const { deps, calls } = makeDeps({
			withDashboard: false,
			dashboardManifest: null,
		});
		await routeRequest(
			makeRequest("/v1/messages", { method: "POST", headers: withKey }),
			deps,
		);
		await routeRequest(
			makeRequest("/wire/anthropic/v1/messages", {
				method: "POST",
				headers: withKey,
			}),
			deps,
		);

		expect(calls.dispatch.map((c) => c.pathname)).toEqual([
			"/v1/messages",
			"/v1/messages",
		]);
	});
});
