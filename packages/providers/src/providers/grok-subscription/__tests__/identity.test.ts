import { describe, expect, it } from "bun:test";
import { GROK_CLI_VERSION } from "../client-identity";
import {
	extractGrokSubscriptionIdentity,
	fetchGrokSubscriptionProfile,
	resolveGrokSubscriptionIdentity,
} from "../identity";

function idToken(claims: Record<string, unknown>): string {
	const encode = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "ES256" })}.${encode(claims)}.signature`;
}

/** The `/v1/user` body the live proxy returns, trimmed to what we read. */
const PROFILE = {
	userId: "user-123",
	email: "Person@Example.Test",
	firstName: "Person",
	lastName: "Example",
	teamId: null,
	teamName: null,
	organizationId: "org-9",
	organizationName: "Example Org",
	codingDataRetentionOptOut: false,
	hasGrokCodeAccess: true,
};

function jsonFetch(body: unknown, status = 200): typeof fetch {
	return (async () =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		})) as unknown as typeof fetch;
}

describe("extractGrokSubscriptionIdentity", () => {
	it("reads the subject and email claims", () => {
		expect(
			extractGrokSubscriptionIdentity(
				idToken({ sub: "user-123", email: "Person@Example.Test" }),
			),
		).toEqual({
			externalAccountId: "user-123",
			email: "person@example.test",
			organizationName: null,
			planTier: null,
			rateLimitTier: null,
		});
	});

	it("returns null for an absent, undecodable or claimless id token", () => {
		expect(extractGrokSubscriptionIdentity(null)).toBeNull();
		expect(extractGrokSubscriptionIdentity(undefined)).toBeNull();
		expect(extractGrokSubscriptionIdentity("not-a-jwt")).toBeNull();
		expect(extractGrokSubscriptionIdentity(idToken({ aud: "x" }))).toBeNull();
	});
});

describe("fetchGrokSubscriptionProfile", () => {
	it("sends the CLI identity headers with the bearer token", async () => {
		let headers: Headers | null = null;
		const fetchImpl = (async (
			_input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			headers = new Headers(init?.headers);
			return new Response(JSON.stringify(PROFILE), {
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const identity = await fetchGrokSubscriptionProfile("at-1", { fetchImpl });

		const sent = headers as unknown as Headers;
		expect(sent.get("authorization")).toBe("Bearer at-1");
		expect(sent.get("x-grok-client-version")).toBe(GROK_CLI_VERSION);
		expect(identity).toEqual({
			externalAccountId: "user-123",
			email: "person@example.test",
			organizationName: "Example Org",
			planTier: null,
			rateLimitTier: null,
		});
	});

	it("answers null rather than throwing on the 426 version gate", async () => {
		expect(
			await fetchGrokSubscriptionProfile("at-1", {
				fetchImpl: jsonFetch({ error: "outdated" }, 426),
			}),
		).toBeNull();
	});

	it("answers null on a 403", async () => {
		expect(
			await fetchGrokSubscriptionProfile("at-1", {
				fetchImpl: jsonFetch({}, 403),
			}),
		).toBeNull();
	});

	it("answers null on a malformed body", async () => {
		const fetchImpl = (async () =>
			new Response("<html>nope</html>", {
				headers: { "content-type": "text/html" },
			})) as unknown as typeof fetch;
		expect(
			await fetchGrokSubscriptionProfile("at-1", { fetchImpl }),
		).toBeNull();
	});

	it("answers null on a transport failure or timeout", async () => {
		const fetchImpl = (async () => {
			throw new Error("The operation timed out.");
		}) as unknown as typeof fetch;
		expect(
			await fetchGrokSubscriptionProfile("at-1", { fetchImpl }),
		).toBeNull();
	});
});

describe("resolveGrokSubscriptionIdentity", () => {
	it("lets the profile win and marks the capture as profile-sourced", async () => {
		const resolved = await resolveGrokSubscriptionIdentity(
			"at-1",
			idToken({ sub: "stale-id", email: "stale@example.test" }),
			{ fetchImpl: jsonFetch(PROFILE) },
		);

		expect(resolved.fromProfile).toBe(true);
		expect(resolved.hasIdentity).toBe(true);
		expect(resolved.identity.externalAccountId).toBe("user-123");
		expect(resolved.identity.email).toBe("person@example.test");
		expect(resolved.identity.organizationName).toBe("Example Org");
	});

	it("falls back to the token claims when the profile read fails", async () => {
		const resolved = await resolveGrokSubscriptionIdentity(
			"at-1",
			idToken({ sub: "user-123", email: "person@example.test" }),
			{ fetchImpl: jsonFetch({ error: "outdated" }, 426) },
		);

		expect(resolved.fromProfile).toBe(false);
		expect(resolved.hasIdentity).toBe(true);
		expect(resolved.identity.externalAccountId).toBe("user-123");
		expect(resolved.identity.organizationName).toBeNull();
	});

	it("reports nothing captured when neither source answers", async () => {
		const resolved = await resolveGrokSubscriptionIdentity("at-1", null, {
			fetchImpl: jsonFetch({}, 500),
		});

		expect(resolved.hasIdentity).toBe(false);
		expect(resolved.fromProfile).toBe(false);
	});
});
