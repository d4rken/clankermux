// The banked-reset claim URL is built from the organization uuid, so every
// Anthropic identity producer must carry it out of its payload.
import { afterEach, describe, expect, it } from "bun:test";
import { makeAccount } from "@clankermux/test-support";
import { AnthropicOAuthProvider } from "../oauth";
import { fetchAnthropicProfile } from "../profile";
import { AnthropicProvider } from "../provider";

const ORG_UUID = "5d1c2a9e-3b7f-4c21-8e6a-0f4b9d7c2e18";

function jsonFetch(body: Record<string, unknown>): typeof fetch {
	return (async () =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		})) as unknown as typeof fetch;
}

const TOKEN_FIELDS = {
	access_token: "access",
	refresh_token: "sk-ant-ort01-NEW",
	expires_in: 28_800,
};

describe("Anthropic organization uuid capture", () => {
	const origFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = origFetch;
	});

	it("carries it out of the code exchange", async () => {
		globalThis.fetch = jsonFetch({
			...TOKEN_FIELDS,
			account: { uuid: "acct", email_address: "a@example.com" },
			organization: { uuid: ORG_UUID, name: "Org" },
		});
		const provider = new AnthropicOAuthProvider();
		const result = await provider.exchangeCode(
			"code#state",
			"verifier",
			provider.getOAuthConfig("claude-oauth"),
		);
		expect(result.identity?.organizationUuid).toBe(ORG_UUID);
	});

	it("carries it out of the refresh envelope", async () => {
		globalThis.fetch = jsonFetch({
			...TOKEN_FIELDS,
			organization: { uuid: ORG_UUID },
		});
		const result = await new AnthropicProvider().refreshToken(
			makeAccount({ provider: "anthropic", refresh_token: "sk-ant-ort01-OLD" }),
			"client-id",
		);
		expect(result.identity?.organizationUuid).toBe(ORG_UUID);
	});

	it("reports null from a refresh envelope that omits it", async () => {
		globalThis.fetch = jsonFetch({
			...TOKEN_FIELDS,
			account: { uuid: "acct" },
		});
		const result = await new AnthropicProvider().refreshToken(
			makeAccount({ provider: "anthropic", refresh_token: "sk-ant-ort01-OLD" }),
			"client-id",
		);
		expect(result.identity?.organizationUuid).toBeNull();
	});

	it("carries it out of the profile", async () => {
		globalThis.fetch = jsonFetch({
			account: { uuid: "acct" },
			organization: { uuid: ORG_UUID, organization_type: "claude_max" },
		});
		const identity = await fetchAnthropicProfile("token");
		expect(identity?.organizationUuid).toBe(ORG_UUID);
	});
});
