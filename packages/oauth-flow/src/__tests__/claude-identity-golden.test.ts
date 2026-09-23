/**
 * The exact headers the console-mode API-key creation puts on the wire,
 * captured at the fetch boundary: lower-cased name and value, sorted. A change
 * here changes the identity Anthropic sees, so it must be deliberate.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { trackClientVersion } from "@clankermux/core";
import { mockFetch } from "@clankermux/test-support";
import { OAuthFlow } from "../index";

describe("Claude identity at the fetch boundary", () => {
	let fetchSpy: ReturnType<typeof spyOn> | null = null;
	afterEach(() => {
		fetchSpy?.mockRestore();
		fetchSpy = null;
	});

	it("create API key", async () => {
		trackClientVersion("claude-cli/2.1.63 (external, cli)");
		const calls: Array<[string, RequestInit | undefined]> = [];
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			mockFetch(async (input, init) => {
				calls.push([String(input), init]);
				return Response.json({ raw_key: "sk-ant-api-key" });
			}),
		);
		const flow = new OAuthFlow({} as never, {} as never) as never as {
			createAnthropicApiKey(accessToken: string): Promise<string>;
		};

		await flow.createAnthropicApiKey("tok");

		expect(calls[0]?.[0]).toBe(
			"https://api.anthropic.com/api/oauth/claude_cli/create_api_key",
		);
		expect(
			Array.from(new Headers(calls[0]?.[1]?.headers).entries()).sort(
				([a], [b]) => a.localeCompare(b),
			),
		).toEqual([
			["accept", "application/json, text/plain, */*"],
			["accept-encoding", "gzip, compress, deflate, br"],
			["authorization", "Bearer tok"],
			["user-agent", "claude-code/2.1.280"],
		]);
		expect(calls[0]?.[1]?.body).toBeUndefined();
	});
});
