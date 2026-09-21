import { describe, expect, it } from "bun:test";
import type { Config } from "@clankermux/config";
import type { DatabaseOperations } from "@clankermux/database";
import { ClientRouter } from "../router";

const RETENTION_DAYS = 45;

// Routing only: the request routes are matched here, never executed, so the
// repository the router builds at construction is never queried. Their
// behaviour is tested against a real database in requests.test.ts.
const router = new ClientRouter({
	config: {
		getRequestRetentionDays: () => RETENTION_DAYS,
	} as unknown as Config,
	dbOps: { getAdapter: () => ({}) } as unknown as DatabaseOperations,
});

const ctx = { apiKeyId: "key-1" };

function get(path: string, method = "GET"): Request {
	return new Request(`http://test${path}`, { method });
}

describe("the client API routes", () => {
	it("serves the retention window a caller needs to bound its reconciliation", async () => {
		const req = get("/client/v1/retention");
		const res = await router.handle(req, new URL(req.url), ctx);

		expect(res?.status).toBe(200);
		expect(res?.headers.get("Cache-Control")).toBe("private, no-store");
		expect(await res?.json()).toEqual({
			requestRetentionDays: RETENTION_DAYS,
		});
	});

	it("claims exactly the routes it serves", () => {
		for (const path of [
			"/client/v1/retention",
			"/client/v1/requests",
			"/client/v1/requests/abc-123",
		]) {
			expect(router.has(path)).toBe(true);
		}
		for (const path of [
			"/client/v2/retention",
			"/client/retention",
			// The by-id pattern is anchored and segment-bounded: it claims one
			// segment under `/requests/`, not a subtree and not a suffix of some
			// longer path.
			"/client/v1/requests/abc/extra",
			"/client/v1/requests/",
			"/client/v1/requestsX/abc",
			"/prefix/client/v1/requests/abc",
		]) {
			expect(router.has(path)).toBe(false);
		}
	});

	it("rejects a write before the handler runs", async () => {
		const req = get("/client/v1/retention", "POST");
		const res = await router.handle(req, new URL(req.url), ctx);

		expect(res?.status).toBe(405);
		expect(res?.headers.get("Allow")).toBe("GET");
		expect(res?.headers.get("Cache-Control")).toBe("private, no-store");
	});

	// The mount claims the whole `/client` prefix, so the 404 for a path no
	// route serves belongs to it and not here.
	it("lets the mount answer for a path it does not serve", async () => {
		const req = get("/client/v1/inventory");
		expect(await router.handle(req, new URL(req.url), ctx)).toBeNull();
	});
});
