/**
 * `HttpClient`'s retry loop is the SECOND retry layer in front of the dashboard
 * (React Query is the first). Retrying a response the server already produced
 * multiplies load on exactly the endpoint that is struggling: a 503 from an
 * analytics worker lane means the request queued and burned a 15s soft
 * deadline, so a blind retry costs a second queue slot and a second deadline.
 *
 * Transport failures are the opposite case — nothing was answered, so the one
 * retry `retries: 1` buys is still worth taking.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { HttpError } from "@clankermux/errors";
import { HttpClient } from "../client";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

/** Replaces global fetch and returns a counter of the calls it received. */
function stubFetch(handler: () => Response | Promise<Response>): {
	calls: () => number;
} {
	let calls = 0;
	globalThis.fetch = (async () => {
		calls++;
		return await handler();
	}) as unknown as typeof fetch;
	return { calls: () => calls };
}

function errorResponse(status: number): Response {
	return new Response(JSON.stringify({ error: "boom" }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("HttpClient retry policy", () => {
	it("does not retry a 503 the server actually answered", async () => {
		const fetchStub = stubFetch(() => errorResponse(503));
		const client = new HttpClient({ retries: 1, retryDelay: 0 });

		const error = await client.get("/api/analytics").catch((e) => e);

		expect(error).toBeInstanceOf(HttpError);
		expect((error as HttpError).status).toBe(503);
		expect(fetchStub.calls()).toBe(1);
	});

	it("does not retry a 4xx either", async () => {
		const fetchStub = stubFetch(() => errorResponse(400));
		const client = new HttpClient({ retries: 1, retryDelay: 0 });

		const error = await client.get("/api/analytics").catch((e) => e);

		expect(error).toBeInstanceOf(HttpError);
		expect((error as HttpError).status).toBe(400);
		expect(fetchStub.calls()).toBe(1);
	});

	it("still retries a transport-level failure once", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			throw new TypeError("Failed to fetch");
		}) as unknown as typeof fetch;
		const client = new HttpClient({ retries: 1, retryDelay: 0 });

		const error = await client.get("/api/analytics").catch((e) => e);

		expect(error).toBeInstanceOf(TypeError);
		expect(calls).toBe(2);
	});

	it("returns the payload without retrying on success", async () => {
		const fetchStub = stubFetch(
			() =>
				new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const client = new HttpClient({ retries: 1, retryDelay: 0 });

		expect(await client.get("/api/analytics")).toEqual({ ok: true });
		expect(fetchStub.calls()).toBe(1);
	});
});
