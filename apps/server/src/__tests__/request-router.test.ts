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
	publicApi: { pathname: string; method: string }[];
	dispatch: { pathname: string; search: string; apiKeyId?: string | null }[];
	responses: { pathname: string; search: string }[];
	models: number;
	/**
	 * What `handleModels` was handed: the URL, the authenticated key id, and the
	 * mount's dialect — the reply's SHAPE is the dialect's, so the hop has to
	 * carry it.
	 */
	modelUrls: {
		pathname: string;
		search: string;
		apiKeyId?: string | null;
		dialect?: string;
	}[];
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
	/** Paths the read-only widget router claims. */
	publicRoutes?: string[];
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
		publicRoutes = ["/public/v1/status"],
	} = options;

	const calls: Calls = {
		api: [],
		publicApi: [],
		dispatch: [],
		responses: [],
		models: 0,
		modelUrls: [],
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
		async handlePublicRequest(req, url) {
			calls.publicApi.push({ pathname: url.pathname, method: req.method });
			return publicRoutes.includes(url.pathname)
				? new Response(JSON.stringify({ handler: "public" }), {
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
		async handleModels(url, apiKeyId, dialect) {
			calls.models++;
			calls.modelUrls.push({
				pathname: url.pathname,
				search: url.search,
				apiKeyId,
				dialect,
			});
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

	// Codex's models-manager identifies itself with `?client_version=`, and the
	// handler picks the reply SHAPE from it. If the mount strip dropped the query
	// string, every Codex fetch would silently get the OpenAI list shape instead
	// of a catalog. `GET /v1/models` is served under `/wire/openai` only:
	// `isDialectAllowed` rejects it on the Anthropic mount.
	it("preserves the models query string through the OpenAI mount", async () => {
		const { deps, calls } = makeDeps();

		await routeRequest(
			makeRequest("/wire/openai/v1/models?client_version=0.149.0", {
				headers: withKey,
			}),
			deps,
		);

		expect(calls.modelUrls).toEqual([
			{
				pathname: "/v1/models",
				search: "?client_version=0.149.0",
				apiKeyId: "key-1",
				dialect: "openai",
			},
		]);
	});

	// The reply's shape is the mount's: Claude Code's gateway model discovery
	// reads Anthropic's own listing shape, which only the anthropic branch of the
	// handler produces. Losing the dialect here would answer a Claude client with
	// an OpenAI-shaped body it silently ignores.
	it("serves GET /v1/models under the anthropic mount, tagged with its dialect", async () => {
		const { deps, calls } = makeDeps();

		const res = await routeRequest(
			makeRequest("/wire/anthropic/v1/models", { headers: withKey }),
			deps,
		);

		expect(await res.json()).toEqual({ handler: "models" });
		expect(calls.modelUrls).toEqual([
			{
				pathname: "/v1/models",
				search: "",
				apiKeyId: "key-1",
				dialect: "anthropic",
			},
		]);
		expect(calls.dispatch).toEqual([]);
	});

	// The alias spellings are the dangerous half of that claim. The local
	// dispatch matches `/v1/models` with `===`, so an admitted alias would carry
	// a pooled OAuth bearer straight to Anthropic; the mount gate refuses them
	// instead, and none of them may reach dispatchProxy.
	//
	// Only spellings that SURVIVE URL parsing are listed. A dot-segment form like
	// `/v1/foo/../models` never reaches the gate as an alias — the URL parser has
	// already collapsed it to the canonical path — so it is served locally, which
	// is the correct outcome for it.
	it("refuses alias spellings of GET /v1/models rather than forwarding them", async () => {
		for (const alias of [
			"/v1/models/",
			"//v1/%6dodels",
			"/v1/%6dodels",
			"/v1/models/.",
		]) {
			const { deps, calls } = makeDeps();
			const res = await routeRequest(
				makeRequest(`/wire/anthropic${alias}`, { headers: withKey }),
				deps,
			);

			expect(res.status).toBe(404);
			expect(calls.dispatch).toEqual([]);
			expect(calls.models).toBe(0);
		}
	});

	// A verb we do not answer locally is ordinary forwarded traffic, and a
	// sub-path of the models route is not the models route at all.
	it("forwards other verbs and sub-paths of /v1/models under anthropic", async () => {
		const { deps, calls } = makeDeps();

		await routeRequest(
			makeRequest("/wire/anthropic/v1/models", {
				method: "POST",
				headers: withKey,
			}),
			deps,
		);
		await routeRequest(
			makeRequest("/wire/anthropic/v1/models/claude-opus-5", {
				headers: withKey,
			}),
			deps,
		);

		expect(calls.models).toBe(0);
		expect(calls.dispatch.map((c) => c.pathname)).toEqual([
			"/v1/models",
			"/v1/models/claude-opus-5",
		]);
	});

	// Which catalog a key may be shown depends on that key's routing pin, so the
	// authenticated identity has to survive the hop into the handler.
	it("hands the authenticated API key id to the models handler", async () => {
		const { deps, calls } = makeDeps();

		await routeRequest(
			makeRequest("/wire/openai/v1/models", { headers: withKey }),
			deps,
		);

		expect(calls.modelUrls).toHaveLength(1);
		expect(calls.modelUrls[0].apiKeyId).toBe("key-1");
		expect(calls.modelUrls[0].dialect).toBe("openai");
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

/**
 * Everything the root used to proxy. Exactly the set the removed
 * `isRootProxyPath` matched, spelled out so a narrowing of the predicate cannot
 * quietly reopen part of the surface.
 */
const LEGACY_ROOT_PATHS = [
	"/v1",
	"/v1/",
	"/v1/messages",
	"/v1/messages/count_tokens",
	"/v1/responses",
	"/v1/models",
	"/v1/code/sessions",
	"/messages",
	"/messages/",
	"/messages/foo",
] as const;

/**
 * The three ways the dashboard can be configured. The refusal has to be
 * identical in all of them: it used to be the dashboard branch that decided
 * whether an unrecognized root path was proxied, and that is exactly the kind
 * of mode-dependence this rejection must not have.
 */
const dashboardConfigs: { name: string; options: Options }[] = [
	{ name: "the dashboard on", options: {} },
	{ name: "the dashboard off", options: { withDashboard: false } },
	{
		name: "the dashboard on but no assets built",
		options: { withDashboard: true, dashboardManifest: null },
	},
];

describe("the root no longer serves agent traffic", () => {
	for (const method of ["GET", "POST"] as const) {
		for (const { name, options } of dashboardConfigs) {
			for (const path of LEGACY_ROOT_PATHS) {
				it(`404s ${method} ${path} with ${name}`, async () => {
					const { deps, calls } = makeDeps(options);
					const res = await routeRequest(
						makeRequest(path, { method, headers: withKey }),
						deps,
					);

					expect(res.status).toBe(404);
					expect(res.headers.get("Content-Type")).toBe("application/json");
					const body = (await res.json()) as { error: { message: string } };
					expect(body.error.message).toContain("/wire/anthropic");
					expect(body.error.message).toContain("/wire/openai");

					// Never the dashboard's index.html, in any mode.
					expect(calls.dashboard).toEqual([]);
					// The refusal is the FIRST thing the root does, so nothing behind
					// it ran: not the management router, not the auth gate, and
					// certainly nothing that dispatches.
					expect(calls.api).toEqual([]);
					expect(calls.auth).toEqual([]);
					expect(calls.dispatch).toEqual([]);
					expect(calls.responses).toEqual([]);
					expect(calls.models).toBe(0);
				});
			}
		}
	}

	// The refusal outranks even a manifest hit. A dashboard build cannot emit a
	// legacy path, so this manifest is deliberately impossible - it exists to show
	// that first position beats the branch that would otherwise answer first.
	it("refuses a legacy path even when the manifest claims it as an asset", async () => {
		const { deps, calls } = makeDeps({
			dashboardManifest: { "/v1/messages": "/assets/v1-messages.js" },
		});
		const res = await routeRequest(
			makeRequest("/v1/messages", { method: "POST", headers: withKey }),
			deps,
		);

		expect(res.status).toBe(404);
		expect(calls.dashboard).toEqual([]);
		expect(calls.api).toEqual([]);
	});

	// The rejection sits ahead of the auth gate, so a client with no key gets
	// told where to point itself rather than being asked for a credential it
	// would then spend on a 404.
	it("404s an unauthenticated legacy request rather than 401ing it", async () => {
		const { deps, calls } = makeDeps({ authenticated: false });
		const res = await routeRequest(
			makeRequest("/v1/messages", { method: "POST" }),
			deps,
		);

		expect(res.status).toBe(404);
		expect(calls.auth).toEqual([]);
	});

	// The identity-bound refusal exists to stop a pooled token reaching an
	// endpoint bound to one account. At the root there is no dispatch left to
	// stop, so `/v1/code/*` gets the same answer as every other removed path.
	// The refusal keeps its job on the mount and in the proxy's ingest
	// prologue.
	it("404s root /v1/code/*, not the identity-bound 501", async () => {
		const { deps, calls } = makeDeps();
		const res = await routeRequest(makeRequest("/v1/code/sessions"), deps);

		expect(res.status).toBe(404);
		expect(res.headers.get("x-clankermux-refusal")).toBeNull();
		expect(calls.dispatch).toEqual([]);
	});

	// Same stem, one segment longer: never proxied, so the refusal must not
	// claim them. A status check cannot tell the legacy 404 from the ordinary
	// `Unknown route` 404 — both are 404s naming the mounts — so the assertion
	// is that the request reached the branches BEHIND the refusal.
	it("leaves same-stem neighbours to the ordinary root routing", async () => {
		for (const path of ["/v10", "/messagesx"]) {
			const { deps, calls } = makeDeps();
			const res = await routeRequest(makeRequest(path), deps);

			expect(res.status).toBe(200);
			expect(calls.api.map((c) => c.pathname)).toEqual([path]);
			expect(calls.dashboard.map((c) => c.assetPath)).toEqual(["/index.html"]);
		}
	});
});

describe("the root's management and dashboard surface", () => {
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

	// Claude Code's own root telemetry paths are no longer special-cased here.
	// They are answered under `/wire/anthropic`, which is where a client
	// configured for this proxy sends them; at the root they are just
	// management paths we do not serve.
	it("404s Claude Code's root telemetry paths as unknown management routes", async () => {
		for (const path of [
			"/api/event_logging/batch",
			"/api/system/package-manager",
		]) {
			const { deps, calls } = makeDeps();
			const res = await routeRequest(
				makeRequest(path, { method: "POST" }),
				deps,
			);

			expect(res.status).toBe(404);
			const body = (await res.json()) as { error: { message: string } };
			expect(body.error.message).toBe(`Unknown API route: ${path}`);
			expect(calls.auth).toEqual([]);
			expect(calls.dispatch).toEqual([]);
		}
	});

	// Root `/api/oauth/*` is the half of the identity-bound set the management
	// router does not own, and the refusal still has work to do there: it is
	// reachable without a key, because root `/api/*` is genuinely public.
	it("refuses identity-bound /api/oauth paths at the root, before authenticating", async () => {
		const { deps, calls } = makeDeps({ authenticated: false });
		const res = await routeRequest(makeRequest("/api/oauth/profile"), deps);

		expect(res.status).toBe(501);
		expect(res.headers.get("x-clankermux-refusal")).toBe(
			"identity-bound-endpoint",
		);
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

	it("still proxies mounted agent traffic with the dashboard off", async () => {
		const { deps, calls } = makeDeps({
			withDashboard: false,
			dashboardManifest: null,
		});
		await routeRequest(
			makeRequest("/wire/anthropic/v1/messages", {
				method: "POST",
				headers: withKey,
			}),
			deps,
		);

		expect(calls.dispatch.map((c) => c.pathname)).toEqual(["/v1/messages"]);
	});
});
