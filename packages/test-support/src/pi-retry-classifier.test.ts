import { describe, expect, it } from "bun:test";
import {
	piFailedErrorMessage,
	piHttpErrorMessage,
	piRetries,
} from "./pi-retry-classifier";

describe("pi's retry verdict", () => {
	it("retries a status-like number anywhere in an HTTP error", () => {
		expect(
			piRetries(
				piHttpErrorMessage(400, {
					message: "The result for tool call toolu_1 is 500,001 characters",
					type: "invalid_request_error",
					code: "sdk_bridge_tool_result_too_large",
				}),
			),
		).toBe(true);
		expect(
			piRetries(
				piHttpErrorMessage(400, {
					message: "Bad request",
					type: "invalid_request_error",
				}),
			),
		).toBe(false);
		expect(
			piRetries(
				piHttpErrorMessage(502, { message: "Bad gateway", type: "api_error" }),
			),
		).toBe(true);
	});

	it("reads a failed stream by its code: server_error is retried, api_error is not", () => {
		const message = "The upstream model call failed";
		expect(
			piRetries(piFailedErrorMessage({ code: "server_error", message })),
		).toBe(true);
		expect(
			piRetries(piFailedErrorMessage({ code: "api_error", message })),
		).toBe(false);
		expect(piFailedErrorMessage({})).toBe("unknown: no message");
	});

	it("never retries quota or billing exhaustion, whatever else the text holds", () => {
		expect(piRetries("server_error: billing limit reached (500)")).toBe(false);
	});
});
