/**
 * Tests for terminalForRequestError — the classifier that turns a throw from the
 * request pipeline into the right terminal Response.
 *
 * The bug it exists to fix: server.ts wrapped the ENTIRE request path
 * (authenticate + WebSocket rejection + /v1/responses + /v1/models + the proxy
 * dispatch) in one try whose catch was labelled "Authentication service error"
 * and answered 401 `authentication_error`. Two consequences:
 *
 *   - A client disconnecting mid-request throws AbortError, so an ordinary
 *     disconnect was logged at ERROR as a security-looking auth event. Every one
 *     of the 25 occurrences observed in production over three days was exactly
 *     this, byte-identical.
 *   - Any throw from the PROXY dispatch was answered 401 too. To a client still
 *     connected that reads as "your API key is bad" when the key was fine, and a
 *     well-behaved consumer may then discard or re-fetch credentials.
 *
 * The repo already settled how to classify a departed client: key on
 * `req.signal.aborted` — NOT on sniffing the error for AbortError — and return
 * the 499 terminal. See handlers/client-abort-response.ts and the proxy paths
 * that use it; this outer handler was simply never swept into that work.
 */
import { describe, expect, it } from "bun:test";
import { terminalForRequestError } from "../request-error-terminal";

/** A Request whose abort signal is in the given state. */
function makeRequest(aborted: boolean): Request {
	const controller = new AbortController();
	if (aborted) controller.abort();
	return new Request("http://localhost/v1/messages", {
		method: "POST",
		signal: controller.signal,
	});
}

async function bodyOf(response: Response): Promise<{
	type?: string;
	error?: { type?: string; message?: string };
}> {
	return (await response.json()) as never;
}

describe("terminalForRequestError", () => {
	describe("client already gone", () => {
		// The whole point: a disconnect is not an auth failure and not a server
		// error. Asserted for BOTH stages — the disconnect can land while the auth
		// service is awaited just as easily as mid-dispatch.
		for (const stage of ["auth", "dispatch"] as const) {
			it(`returns 499 for an aborted request in the ${stage} stage`, async () => {
				const response = terminalForRequestError(
					makeRequest(true),
					new Error("The connection was closed."),
					stage,
				);

				expect(response.status).toBe(499);
				expect((await bodyOf(response)).error?.type).toBe(
					"client_closed_request",
				);
			});
		}

		/**
		 * Keyed on the SIGNAL, not the error. An aborted request classifies as a
		 * disconnect whatever the error looks like — error-type sniffing is the
		 * approach this repo already rejected, because the throw that surfaces
		 * after a disconnect is not reliably an AbortError.
		 */
		it("classifies on the signal even when the error is unrelated", () => {
			const response = terminalForRequestError(
				makeRequest(true),
				new TypeError("undefined is not a function"),
				"dispatch",
			);

			expect(response.status).toBe(499);
		});

		it("classifies on the signal even when the error is not an Error", () => {
			expect(
				terminalForRequestError(makeRequest(true), "just a string", "dispatch")
					.status,
			).toBe(499);
		});
	});

	describe("client still connected", () => {
		it("returns 401 authentication_error for a genuine auth-service failure", async () => {
			const response = terminalForRequestError(
				makeRequest(false),
				new Error("auth backend unreachable"),
				"auth",
			);

			expect(response.status).toBe(401);
			const body = await bodyOf(response);
			expect(body.error?.type).toBe("authentication_error");
			expect(body.error?.message).toBe("Authentication service error");
		});

		/**
		 * The latent half of the bug. A dispatch failure is a SERVER error; calling
		 * it an authentication error misdirects the operator and lies to the client
		 * about its credentials.
		 */
		it("returns 500 — never 401 — for a dispatch failure", async () => {
			const response = terminalForRequestError(
				makeRequest(false),
				new Error("upstream exploded"),
				"dispatch",
			);

			expect(response.status).toBe(500);
			const body = await bodyOf(response);
			expect(body.error?.type).not.toBe("authentication_error");
			expect(body.error?.type).toBe("internal_error");
		});

		it("never leaks the internal error text to the client", async () => {
			const secret = "connect ECONNREFUSED 10.1.2.3:5432";
			const response = terminalForRequestError(
				makeRequest(false),
				new Error(secret),
				"dispatch",
			);

			expect(JSON.stringify(await bodyOf(response))).not.toContain(secret);
		});
	});

	it("always answers JSON so a client never has to parse an empty body", async () => {
		for (const aborted of [true, false]) {
			for (const stage of ["auth", "dispatch"] as const) {
				const response = terminalForRequestError(
					makeRequest(aborted),
					new Error("x"),
					stage,
				);
				expect(response.headers.get("Content-Type")).toBe("application/json");
				await expect(bodyOf(response)).resolves.toBeTruthy();
			}
		}
	});
});
