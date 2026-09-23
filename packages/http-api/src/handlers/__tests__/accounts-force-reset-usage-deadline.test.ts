/**
 * The force-reset handler's direct usage read goes to the same /oauth/usage
 * bucket as the poll, so the shared rate-limit deadline holds it too.
 */
import { afterEach, expect, it, spyOn } from "bun:test";
import type { DatabaseOperations } from "@clankermux/database";
import { usageCache } from "@clankermux/providers";
import { createAccountForceResetRateLimitHandler } from "../accounts";

const ids: string[] = [];
function freshId(label: string): string {
	const id = `force-reset-deadline-${label}-${Date.now()}-${ids.length}`;
	ids.push(id);
	return id;
}

let fetchSpy: ReturnType<typeof spyOn> | null = null;
afterEach(() => {
	fetchSpy?.mockRestore();
	fetchSpy = null;
	for (const id of ids.splice(0)) {
		usageCache.stopPolling(id);
		usageCache.delete(id);
	}
});

function dbOps(id: string): DatabaseOperations {
	return {
		getAdapter: () => ({
			get: async () => ({
				id,
				name: "Claude",
				provider: "anthropic",
				access_token: "raw-token",
			}),
		}),
		forceResetAccountRateLimit: async () => true,
	} as unknown as DatabaseOperations;
}

function usageResponse(): Response {
	const at = new Date(Date.now() + 3_600_000).toISOString();
	return new Response(
		JSON.stringify({
			five_hour: { utilization: 10, resets_at: at },
			seven_day: { utilization: 10, resets_at: at },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

it("skips the direct usage read while the shared deadline stands", async () => {
	const id = freshId("held");
	fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(usageResponse());
	usageCache.noteRateLimited(id, Date.now() + 10 * 60_000);
	const response = await createAccountForceResetRateLimitHandler(dbOps(id))(
		{} as Request,
		id,
	);
	const body = (await response.json()) as { usagePollTriggered: boolean };
	expect(response.status).toBe(200);
	expect(fetchSpy).not.toHaveBeenCalled();
	expect(body.usagePollTriggered).toBe(false);
});

it("still reads usage directly for an unpolled account without a deadline", async () => {
	const id = freshId("free");
	fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(usageResponse());
	const response = await createAccountForceResetRateLimitHandler(dbOps(id))(
		{} as Request,
		id,
	);
	const body = (await response.json()) as { usagePollTriggered: boolean };
	expect(fetchSpy).toHaveBeenCalledTimes(1);
	expect(body.usagePollTriggered).toBe(true);
});
