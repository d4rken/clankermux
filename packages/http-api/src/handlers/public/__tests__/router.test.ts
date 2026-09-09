import { describe, expect, it } from "bun:test";
import type { Config } from "@clankermux/config";
import type { DatabaseOperations } from "@clankermux/database";
import { PublicRouter } from "../router";

const router = new PublicRouter({
	dbOps: { getAdapter: () => ({}) } as DatabaseOperations,
	config: {} as Config,
});
describe("replacement public routes", () => {
	it("has only the five documented resources", () => {
		for (const name of ["status", "accounts", "workloads", "stops", "stream"])
			expect(router.has(`/public/v1/${name}`)).toBe(true);
		for (const name of ["pacing", "runway", "workload-headroom"])
			expect(router.has(`/public/v1/${name}`)).toBe(false);
		expect(router.has("/public/v2/workloads")).toBe(false);
	});
	it("rejects writes before touching readers", async () => {
		const request = new Request("http://test/public/v1/workloads", {
			method: "POST",
		});
		const response = await router.handle(request, new URL(request.url));
		expect(response?.status).toBe(405);
		expect(response?.headers.get("Allow")).toBe("GET");
	});
	it("lets the public mount return 404 for removed routes", async () => {
		const request = new Request("http://test/public/v1/pacing");
		expect(await router.handle(request, new URL(request.url))).toBeNull();
	});
});
