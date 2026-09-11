import { describe, expect, it, mock, spyOn } from "bun:test";
import type { DatabaseOperations } from "@clankermux/database";
import { createDevinAccountHandlers } from "./devin-accounts";

const post = (body: unknown) =>
	new Request("http://localhost/api/accounts/devin", {
		method: "POST",
		body: JSON.stringify(body),
	});
describe("Devin account discovery and login", () => {
	it("persists verified Devin identity on successful creation without echoing credentials", async () => {
		const persist = mock(async () => {});
		const db = {
			getAdapter: () => ({
				runWithChanges: async () => 1,
				get: async () => ({
					id: "created-devin",
					name: "Free",
					provider: "devin",
					created_at: Date.now(),
					expires_at: Date.now() + 60000,
				}),
			}),
			setAccountIdentityFromProfile: persist,
		} as unknown as DatabaseOperations;
		const handlers = createDevinAccountHandlers(db, {
			getAccount: async () => ({
				userJwt: "private-jwt",
				endpoint: "https://server.codeium.com",
				models: [],
				usage: {
					kind: "devin",
					email: "devin@example.com",
					accountId: "devin-user-123",
					planName: "Free",
				},
			}),
		} as never);
		const response = await handlers.add(
			post({ name: "Free", apiKey: "private-token" }),
		);
		expect(response.status).toBe(200);
		expect(persist).toHaveBeenCalledWith("created-devin", {
			email: "devin@example.com",
			externalAccountId: "devin-user-123",
			planTier: "Free",
			organizationName: null,
			rateLimitTier: null,
		});
		const body = await response.text();
		expect(body).not.toContain("private-token");
		expect(body).not.toContain("private-jwt");
	});

	it("keeps successful account creation when identity persistence fails", async () => {
		const persist = mock(async () => {
			throw new Error("database temporarily unavailable");
		});
		const db = {
			getAdapter: () => ({
				runWithChanges: async () => 1,
				get: async () => ({
					id: "created-devin",
					name: "Free",
					provider: "devin",
					created_at: Date.now(),
					expires_at: Date.now() + 60000,
				}),
			}),
			setAccountIdentityFromProfile: persist,
		} as unknown as DatabaseOperations;
		const handlers = createDevinAccountHandlers(db, {
			getAccount: async () => ({
				userJwt: "private-jwt",
				endpoint: "https://server.codeium.com",
				models: [],
				usage: {
					kind: "devin",
					email: "devin@example.com",
					accountId: "devin-user-123",
					planName: "Free",
				},
			}),
		} as never);
		const response = await handlers.add(
			post({ name: "Free", apiKey: "private-token" }),
		);
		expect(response.status).toBe(200);
		expect(persist).toHaveBeenCalledWith("created-devin", {
			email: "devin@example.com",
			externalAccountId: "devin-user-123",
			planTier: "Free",
			organizationName: null,
			rateLimitTier: null,
		});
		const body = await response.text();
		expect(body).not.toContain("private-token");
		expect(body).not.toContain("private-jwt");
	});

	it("returns only safe account metadata, never JWT or token", async () => {
		const handlers = createDevinAccountHandlers(
			{} as DatabaseOperations,
			{
				getAccount: async () => ({
					userJwt: "private-jwt",
					endpoint: "https://server.codeium.com",
					models: [],
					usage: { kind: "devin" },
				}),
			} as never,
		);
		const response = await handlers.models(post({ apiKey: "private-token" }));
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).not.toContain("private-jwt");
		expect(text).not.toContain("private-token");
	});
	it("rejects missing credentials without dispatching discovery", async () => {
		const handlers = createDevinAccountHandlers(
			{} as DatabaseOperations,
			{
				getAccount: async () => {
					throw new Error("should not call");
				},
			} as never,
		);
		expect((await handlers.models(post({}))).status).toBe(400);
	});
	it("rejects account creation when Devin authentication fails", async () => {
		const handlers = createDevinAccountHandlers({} as DatabaseOperations, {
			getAccount: async () => {
				throw new Error("Devin authentication failed");
			},
		});
		const response = await handlers.add(
			post({ name: "Free", apiKey: "private-token" }),
		);
		expect(response.status).toBe(400);
		expect(await response.text()).not.toContain("private-token");
	});
	it("consumes a login session when callback validation fails", async () => {
		const handlers = createDevinAccountHandlers({} as DatabaseOperations);
		const { sessionId } = await (
			await handlers.login(post({ name: "Free" }))
		).json();
		expect(
			(
				await handlers.complete(
					post({ sessionId, callback: "code#wrong-state" }),
				)
			).status,
		).toBe(400);
		const replay = await handlers.complete(
			post({ sessionId, callback: "code#wrong-state" }),
		);
		expect(await replay.text()).toContain("expired");
	});
	it("does not disclose PKCE verifier and rejects unknown completion sessions", async () => {
		const handlers = createDevinAccountHandlers({} as DatabaseOperations);
		const start = await handlers.login(post({ name: "Free", priority: 0 }));
		const body = await start.json();
		expect(body.authUrl).toContain("code_challenge=");
		expect(body.verifier).toBeUndefined();
		expect(
			(
				await handlers.complete(
					post({ sessionId: "missing", callback: "secret" }),
				)
			).status,
		).toBe(400);
	});
});

it("lets operators disable and re-enable Devin included quota protection", async () => {
	const { createAccountAutoPauseOnOverageHandler } = await import("./accounts");
	const updates: Array<[string, boolean]> = [];
	const db = {
		getAdapter: () => ({
			get: async () => ({ name: "Free", provider: "devin" }),
		}),
		setAutoPauseOnOverageEnabled: (id: string, enabled: boolean) =>
			updates.push([id, enabled]),
	} as unknown as DatabaseOperations;
	const handler = createAccountAutoPauseOnOverageHandler(db);
	for (const enabled of [0, 1]) {
		const response = await handler(post({ enabled }), "devin-free");
		expect(response.status).toBe(200);
		expect((await response.json()).autoPauseOnOverageEnabled).toBe(
			enabled === 1,
		);
	}
	expect(updates).toEqual([
		["devin-free", false],
		["devin-free", true],
	]);
});

it("manual Devin refresh invalidates provider metadata before refreshing usage", async () => {
	const { devinClient, usageCache } = await import("@clankermux/providers");
	const { createAccountRefreshUsageHandler } = await import("./accounts");
	const invalidate = spyOn(devinClient, "invalidateAccount").mockImplementation(
		() => {},
	);
	const refresh = spyOn(usageCache, "refreshNow").mockImplementation(
		async () => {
			expect(invalidate).toHaveBeenCalledWith(
				"private-token",
				"https://server.codeium.com",
			);
			return true;
		},
	);
	try {
		const handler = createAccountRefreshUsageHandler({
			getAccount: async () => ({
				id: "devin-refresh",
				name: "Free",
				provider: "devin",
				api_key: "private-token",
				custom_endpoint: "https://server.codeium.com",
			}),
		} as unknown as DatabaseOperations);
		const response = await handler(post({}), "devin-refresh");
		expect(response.status).toBe(200);
		expect(refresh).toHaveBeenCalledWith("devin-refresh");
	} finally {
		refresh.mockRestore();
		invalidate.mockRestore();
	}
});
