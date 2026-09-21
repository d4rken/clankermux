/**
 * The dispatcher's half of the give-up pacing: `handleProxy` throws, and
 * `dispatchProxyRequest` is what turns that throw into the client's 503.
 *
 * Runs in its OWN bun process, spawned by `dispatch-retry-after.test.ts`. The
 * main suite installs a `mock.module("../dispatch", …)` stub that answers every
 * call with an empty 500, which is process-wide and order-independent, so the
 * real dispatcher cannot be reached there at all. The filename deliberately
 * does not match bun's default discovery: it must only ever run when that
 * spawner names it explicitly.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { usageCache } from "@clankermux/providers";
import { dispatchProxyRequest } from "../dispatch";
import {
	makeAccount,
	makeContext,
	upstreamOnlyFetch,
} from "./fixtures/proxy-terminal-harness";
import { provisionRouting } from "./fixtures/routing-harness";

const MODEL = "claude-haiku-4-5";

function makeRequest(): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: MODEL,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
	});
}

function unauthorized() {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "authentication_error", message: "bad token" },
		}),
		{ status: 401, headers: { "content-type": "application/json" } },
	);
}

describe("dispatchProxyRequest — give-up pacing", () => {
	beforeEach(() => {
		globalThis.fetch = upstreamOnlyFetch(async () => unauthorized());
	});

	it("emits Retry-After and the non-guarantee flag from the thrown advice", async () => {
		const account = makeAccount();
		usageCache.delete(account.id);
		const ctx = makeContext([account]);
		await provisionRouting(ctx, MODEL, await ctx.dbOps.getAllAccounts());

		const req = makeRequest();
		const res = await dispatchProxyRequest(
			req,
			new URL(req.url),
			ctx,
			null,
			null,
			false,
		);

		expect(res.status).toBe(503);
		expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
		const body = (await res.json()) as {
			error: {
				type: string;
				message: string;
				availability_guaranteed: boolean;
			};
		};
		expect(body.error.type).toBe("service_unavailable_error");
		expect(body.error.message).toContain("All accounts failed");
		expect(body.error.availability_guaranteed).toBe(false);
	});

	it("leaves an error that carries no advice unpaced", async () => {
		const account = makeAccount();
		usageCache.delete(account.id);
		const ctx = makeContext([account]);
		await provisionRouting(ctx, MODEL, await ctx.dbOps.getAllAccounts());
		// A failure with no deadline anywhere in it, which must serialize exactly
		// as it did before the give-up terminals started carrying advice.
		(ctx.dbOps as unknown as Record<string, unknown>).getAllAccounts =
			async () => {
				throw new Error("db exploded");
			};

		const req = makeRequest();
		const res = await dispatchProxyRequest(
			req,
			new URL(req.url),
			ctx,
			null,
			null,
			false,
		);

		expect(res.status).toBe(500);
		expect(res.headers.get("Retry-After")).toBeNull();
		const body = (await res.json()) as {
			error: Record<string, unknown>;
		};
		expect(body.error.type).toBe("proxy_error");
		expect("availability_guaranteed" in body.error).toBe(false);
	});
});
