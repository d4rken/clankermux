import { beforeEach, describe, expect, it } from "bun:test";
import { getProvider } from "../../../index";
import { GrokProvider } from "../provider";

describe("GrokProvider", () => {
	let provider: GrokProvider;

	beforeEach(() => {
		provider = new GrokProvider();
	});

	describe("name", () => {
		it("should have the correct provider name", () => {
			expect(provider.name).toBe("grok");
		});
	});

	describe("getEndpoint", () => {
		it("should return the API root without a /v1 suffix", () => {
			expect(provider.getEndpoint()).toBe("https://api.x.ai");
		});
	});

	describe("buildUrl", () => {
		it("should resolve the Anthropic messages path against the API root", () => {
			expect(provider.buildUrl("/v1/messages", "")).toBe(
				"https://api.x.ai/v1/messages",
			);
		});

		it("should preserve the query string", () => {
			expect(provider.buildUrl("/v1/messages", "?beta=true")).toBe(
				"https://api.x.ai/v1/messages?beta=true",
			);
		});
	});

	describe("prepareHeaders", () => {
		it("should replace the client's credentials with a bearer token", () => {
			const prepared = provider.prepareHeaders(
				new Headers({
					"x-api-key": "client-key",
					authorization: "Bearer client-token",
				}),
				undefined,
				"test-key",
			);

			expect(prepared.get("x-api-key")).toBeNull();
			expect(prepared.get("authorization")).toBe("Bearer test-key");
		});
	});

	describe("isStreamingResponse", () => {
		it("should detect a server-sent-event response", () => {
			expect(
				provider.isStreamingResponse(
					new Response("", {
						headers: { "content-type": "text/event-stream" },
					}),
				),
			).toBe(true);
		});
	});

	describe("registry", () => {
		it("should be registered under its provider name", () => {
			expect(getProvider("grok")).toBeInstanceOf(GrokProvider);
		});
	});
});
