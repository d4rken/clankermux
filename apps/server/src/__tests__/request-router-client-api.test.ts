/**
 * The `/client/v1/*` front door, end to end through the REAL auth service and
 * the REAL client router.
 *
 * The spies used elsewhere in this directory cannot see the two properties this
 * surface actually turns on. One is the credential itself: which spellings are
 * accepted, and that an inactive row fails like an unknown key. The other is
 * that reading here must not count as CLIENT USAGE — `AuthService.accept`
 * otherwise bumps `last_used` and `usage_count`, which the dashboard renders as
 * a client's last request and its within-24h activity marker, so a client that
 * only polls its own history would read as live traffic while `usage_count`
 * stopped meaning "proxied requests". Both are only observable with the real
 * service in the deps, which is why this file builds one.
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type { Config } from "@clankermux/config";
import type { DatabaseOperations } from "@clankermux/database";
import { AuthService, ClientRouter } from "@clankermux/http-api";
import type { ApiKey, CryptoUtils } from "@clankermux/types";
import { apiKeyLookupSuffix } from "@clankermux/types";
import type { RequestRouterDeps } from "../request-router";
import { routeRequest } from "../request-router";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const hashOf = (secret: string) => `sha256$${sha256(secret)}`;

const VALID_KEY = "btr-validvalidvalidvalidvalidVAL1";
const INACTIVE_KEY = "btr-inactiveinactiveinactiveIN01";
const RETENTION_DAYS = 45;

class TestCrypto implements CryptoUtils {
	async generateApiKey(): Promise<string> {
		return "btr-unused";
	}
	async hashApiKey(apiKey: string): Promise<string> {
		return hashOf(apiKey);
	}
	async verifyApiKey(apiKey: string, hashedKey: string): Promise<boolean> {
		return hashedKey === hashOf(apiKey);
	}
}

function keyRow(id: string, secret: string, isActive: boolean): ApiKey {
	return {
		id,
		name: id,
		hashedKey: hashOf(secret),
		prefixLast8: apiKeyLookupSuffix(secret),
		createdAt: 1,
		lastUsed: null,
		usageCount: 0,
		isActive,
		pinnedAccountId: null,
		pinnedProviders: null,
	};
}

/** The slice of DatabaseOperations the auth path touches, with the usage
 *  write recorded rather than performed. */
class FakeDbOps {
	keys: ApiKey[] = [
		keyRow("key-live", VALID_KEY, true),
		keyRow("key-dead", INACTIVE_KEY, false),
	];
	/** Every `updateApiKeyUsage` the auth service asked for. */
	usageWrites: { id: string }[] = [];

	async getActiveApiKeys(): Promise<ApiKey[]> {
		return this.keys.filter((k) => k.isActive);
	}
	async countActiveApiKeys(): Promise<number> {
		return this.keys.filter((k) => k.isActive).length;
	}
	updateApiKeyUsage(id: string): void {
		this.usageWrites.push({ id });
	}
	async getApiKeyByHashedKey(hashedKey: string): Promise<ApiKey | null> {
		return (
			this.keys.find((k) => k.hashedKey === hashedKey && k.isActive) ?? null
		);
	}
	async rotateApiKeySecret(): Promise<boolean> {
		return true;
	}
	/** No management password configured — the session policy is fail-open. */
	async getManagementPassword(): Promise<null> {
		return null;
	}
	/**
	 * The client router builds a `RequestRepository` over this at construction.
	 * The routes this file exercises never issue a query, so an empty adapter is
	 * enough; the request routes have their own tests against a real database.
	 */
	getAdapter(): unknown {
		return {};
	}
}

function makeDeps(): {
	deps: RequestRouterDeps;
	db: FakeDbOps;
	dispatched: string[];
} {
	const db = new FakeDbOps();
	const authService = new AuthService(
		db as unknown as DatabaseOperations,
		new TestCrypto(),
	);
	const clientRouter = new ClientRouter({
		config: {
			getRequestRetentionDays: () => RETENTION_DAYS,
		} as unknown as Config,
		dbOps: db as unknown as DatabaseOperations,
	});
	const dispatched: string[] = [];

	const deps: RequestRouterDeps = {
		async handleApiRequest() {
			return null;
		},
		async handlePublicRequest() {
			return null;
		},
		handleClientRequest: (req, url, apiKeyId) =>
			clientRouter.handle(req, url, { apiKeyId }),
		authenticate: (req, path, method, requirement, options) =>
			authService.authenticateRequest(req, path, method, requirement, options),
		async dispatchProxy(_req, url) {
			dispatched.push(url.pathname);
			return new Response("{}", { status: 200 });
		},
		async handleChatCompletions() {
			return new Response("{}", { status: 200 });
		},
		async handleResponses() {
			return new Response("{}", { status: 200 });
		},
		async handleModels() {
			return new Response("{}", { status: 200 });
		},
		// The dashboard is ON, so an unknown path that escaped the namespace
		// would be answered with the SPA shell rather than a 404.
		withDashboard: true,
		dashboardManifest: { "/assets/app.js": "/assets/app.js" },
		serveDashboardFile(assetPath) {
			return new Response(`<!doctype html><!-- ${assetPath} -->`, {
				status: 200,
				headers: { "Content-Type": "text/html" },
			});
		},
	};

	return { deps, db, dispatched };
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

const RETENTION = "/client/v1/retention";

describe("the credential", () => {
	it("serves a valid key both credential spellings", async () => {
		const spellings: Record<string, string>[] = [
			{ "x-api-key": VALID_KEY },
			{ Authorization: `Bearer ${VALID_KEY}` },
		];
		for (const headers of spellings) {
			const { deps } = makeDeps();
			const res = await routeRequest(request(RETENTION, { headers }), deps);

			expect(res.status).toBe(200);
			expect(res.headers.get("Cache-Control")).toBe("private, no-store");
			expect(await res.json()).toEqual({
				requestRetentionDays: RETENTION_DAYS,
			});
		}
	});

	// Three ways to hold no usable credential; all three are the same answer,
	// and the inactive row is the one that matters operationally — revoking a
	// client in the dashboard has to close this surface with it.
	const refused: [string, Record<string, string>][] = [
		["no credential at all", {}],
		["an unknown key", { "x-api-key": "btr-not-a-real-key" }],
		["a key whose row is inactive", { "x-api-key": INACTIVE_KEY }],
	];
	for (const [what, headers] of refused) {
		it(`answers 401 to ${what}`, async () => {
			const { deps } = makeDeps();
			const res = await routeRequest(request(RETENTION, { headers }), deps);

			expect(res.status).toBe(401);
			expect(res.headers.get("Cache-Control")).toBe("private, no-store");
			const body = (await res.json()) as { error: { type: string } };
			expect(body.error.type).toBe("authentication_error");
		});
	}
});

describe("the namespace", () => {
	it("is read-only, with the refusal naming the verb it accepts", async () => {
		const { deps } = makeDeps();
		const res = await routeRequest(
			request(RETENTION, {
				method: "POST",
				headers: { "x-api-key": VALID_KEY },
			}),
			deps,
		);

		expect(res.status).toBe(405);
		expect(res.headers.get("Allow")).toBe("GET");
		expect(res.headers.get("Cache-Control")).toBe("private, no-store");
	});

	it("404s an unknown route in JSON rather than with the dashboard shell", async () => {
		const { deps } = makeDeps();
		const res = await routeRequest(
			request("/client/v1/inventory", { headers: { "x-api-key": VALID_KEY } }),
			deps,
		);

		expect(res.status).toBe(404);
		expect(res.headers.get("Content-Type")).toBe("application/json");
		expect(res.headers.get("Cache-Control")).toBe("private, no-store");
		const text = JSON.stringify(await res.json());
		expect(text).toContain("not_found");
		expect(text).not.toContain("doctype");
	});
});

describe("reads do not count as client usage", () => {
	it("does not ask the database to bump last_used or usage_count", async () => {
		const { deps, db } = makeDeps();
		const res = await routeRequest(
			request(RETENTION, { headers: { "x-api-key": VALID_KEY } }),
			deps,
		);

		expect(res.status).toBe(200);
		expect(db.usageWrites).toEqual([]);
	});

	it("still counts a proxied request on the same key", async () => {
		const { deps, db, dispatched } = makeDeps();
		const res = await routeRequest(
			request("/wire/anthropic/v1/messages", {
				method: "POST",
				headers: { "x-api-key": VALID_KEY },
			}),
			deps,
		);

		expect(res.status).toBe(200);
		expect(dispatched).toEqual(["/v1/messages"]);
		expect(db.usageWrites).toEqual([{ id: "key-live" }]);
	});
});
