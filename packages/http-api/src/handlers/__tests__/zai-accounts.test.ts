import { describe, expect, it, mock } from "bun:test";
import type { DatabaseOperations } from "@clankermux/database";
import type { Account } from "@clankermux/types";
import { createZaiAccountHandlers } from "../zai-accounts";

const MINTED = "key-1.secret-1";
const post = (body: unknown) =>
	new Request("http://localhost/api/accounts/zai/login", {
		method: "POST",
		body: JSON.stringify(body),
	});
const existing = {
	id: "saved-zai",
	name: "My z.ai",
	provider: "zai",
	api_key: "old-key",
	identity_external_id: "user-1",
	priority: 4,
} as unknown as Account;

function setup(
	overrides: {
		credential?: { apiKey: string; email?: string; accountId?: string };
		account?: Account;
		expiresAt?: number;
	} = {},
) {
	const inserts: unknown[][] = [];
	const persist = mock(async () => {});
	const replace = mock(async () => true);
	const getAccount = mock(async () => overrides.account ?? existing);
	const db = {
		getAdapter: () => ({
			runWithChanges: async (_sql: string, params: unknown[]) => {
				inserts.push(params);
				return 1;
			},
			get: async () => ({
				id: "created-zai",
				name: "Subscription",
				provider: "zai",
				request_count: 0,
				total_requests: 0,
				last_used: null,
				created_at: Date.now(),
				expires_at: Date.now() + 60_000,
				paused: 0,
			}),
		}),
		setAccountIdentityFromProfile: persist,
		reconnectZaiAccount: replace,
		getAccount,
	} as unknown as DatabaseOperations;
	const exchange = mock(
		async () =>
			overrides.credential ?? {
				apiKey: MINTED,
				email: "person@example.test",
				accountId: "user-1",
			},
	);
	const createLogin = mock(() => ({
		url: "https://chat.z.ai/api/oauth/authorize?state=state-1",
		state: "state-1",
		expiresAt: overrides.expiresAt ?? Date.now() + 600_000,
	}));
	return {
		handlers: createZaiAccountHandlers(
			db,
			exchange as never,
			createLogin as never,
		),
		inserts,
		persist,
		replace,
		getAccount,
		exchange,
	};
}

describe("Z.AI account sign-in", () => {
	it("hands out a session for a valid account name and refuses an invalid one", async () => {
		const { handlers } = setup();
		const response = await handlers.login(
			post({ name: "Subscription", priority: 3 }),
		);
		expect(response.status).toBe(200);
		const login = await response.json();
		expect(login.sessionId).toBeString();
		expect(login.authUrl).toContain("chat.z.ai");
		expect(login.expiresAt).toBeGreaterThan(Date.now());
		expect((await handlers.login(post({ name: "no/slashes" }))).status).toBe(
			400,
		);
		expect((await handlers.login(post({ name: "" }))).status).toBe(400);
	});

	it("creates the account from the minted key and records the signed-in identity", async () => {
		const { handlers, inserts, persist, exchange } = setup();
		const { sessionId } = await (
			await handlers.login(post({ name: "Subscription", priority: 3 }))
		).json();
		const response = await handlers.complete(
			post({
				sessionId,
				code: "https://zcode.z.ai/cn/oauth/callback?code=c&state=s",
			}),
		);
		expect(response.status).toBe(200);
		expect(exchange).toHaveBeenCalledTimes(1);
		const params = inserts.at(-1) ?? [];
		expect(params[2]).toBe("zai");
		// api_key, refresh_token and access_token all carry the minted key.
		expect(params.slice(3, 6)).toEqual([MINTED, MINTED, MINTED]);
		expect(params[10]).toBe(3);
		expect(persist).toHaveBeenCalledWith("created-zai", {
			externalAccountId: "user-1",
			email: "person@example.test",
			organizationName: null,
			planTier: null,
			rateLimitTier: null,
		});
		expect(await response.text()).not.toContain(MINTED);
	});

	it("adds the account even when the sign-in carried no identity", async () => {
		const { handlers, persist } = setup({ credential: { apiKey: MINTED } });
		const { sessionId } = await (
			await handlers.login(post({ name: "Subscription" }))
		).json();
		expect(
			(await handlers.complete(post({ sessionId, code: "c" }))).status,
		).toBe(200);
		expect(persist).not.toHaveBeenCalled();
	});

	it("consumes a login session once, and rejects unknown or expired ones", async () => {
		const { handlers, exchange } = setup();
		const { sessionId } = await (
			await handlers.login(post({ name: "Subscription" }))
		).json();
		expect(
			(await handlers.complete(post({ sessionId, code: "c" }))).status,
		).toBe(200);
		expect(
			(await handlers.complete(post({ sessionId, code: "c" }))).status,
		).toBe(400);
		expect(exchange).toHaveBeenCalledTimes(1);
		expect(
			(await handlers.complete(post({ sessionId: "nope", code: "c" }))).status,
		).toBe(400);
		const stale = setup({ expiresAt: Date.now() - 1 });
		const expired = await (
			await stale.handlers.login(post({ name: "Subscription" }))
		).json();
		expect(
			(
				await stale.handlers.complete(
					post({ sessionId: expired.sessionId, code: "c" }),
				)
			).status,
		).toBe(400);
		expect(stale.exchange).not.toHaveBeenCalled();
	});

	it("keeps login and reconnect sessions apart", async () => {
		const { handlers, replace, exchange, inserts } = setup();
		const reconnect = await (
			await handlers.reauthStart(post({ accountId: "saved-zai" }))
		).json();
		expect(
			(
				await handlers.complete(
					post({ sessionId: reconnect.sessionId, code: "c" }),
				)
			).status,
		).toBe(400);
		expect(inserts).toEqual([]);
		const login = await (
			await handlers.login(post({ name: "Subscription" }))
		).json();
		expect(
			(
				await handlers.reauthComplete(
					post({ sessionId: login.sessionId, code: "c" }),
				)
			).status,
		).toBe(400);
		expect(replace).not.toHaveBeenCalled();
		expect(exchange).not.toHaveBeenCalled();
	});

	it("refuses to reconnect an account of another provider", async () => {
		const other = setup({
			account: { ...existing, provider: "minimax" } as Account,
		});
		const response = await other.handlers.reauthStart(
			post({ accountId: "saved-zai" }),
		);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("Z.AI account not found");
	});

	it("re-keys the target account in place", async () => {
		const { handlers, replace } = setup();
		const { sessionId } = await (
			await handlers.reauthStart(post({ accountId: "saved-zai" }))
		).json();
		const response = await handlers.reauthComplete(
			post({ sessionId, code: "c" }),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true });
		expect(replace).toHaveBeenCalledWith("saved-zai", {
			apiKey: MINTED,
			expiresAt: expect.any(Number),
			identity: {
				externalAccountId: "user-1",
				email: "person@example.test",
				organizationName: null,
				planTier: null,
				rateLimitTier: null,
			},
			expectedApiKey: "old-key",
			expectedExternalId: "user-1",
		});
	});

	it("refuses a sign-in that belongs to another Z.AI account", async () => {
		for (const credential of [
			{ apiKey: MINTED, accountId: "someone-else" },
			{ apiKey: MINTED, email: "person@example.test" },
		]) {
			const { handlers, replace } = setup({ credential });
			const { sessionId } = await (
				await handlers.reauthStart(post({ accountId: "saved-zai" }))
			).json();
			const response = await handlers.reauthComplete(
				post({ sessionId, code: "c" }),
			);
			expect(response.status).toBe(400);
			expect(await response.text()).toContain("different account");
			expect(replace).not.toHaveBeenCalled();
		}
	});

	it("accepts any sign-in for an account that never captured an identity", async () => {
		const { handlers, replace } = setup({
			account: { ...existing, identity_external_id: null } as Account,
			credential: { apiKey: MINTED, accountId: "user-9" },
		});
		const { sessionId } = await (
			await handlers.reauthStart(post({ accountId: "saved-zai" }))
		).json();
		expect(
			(await handlers.reauthComplete(post({ sessionId, code: "c" }))).status,
		).toBe(200);
		expect(replace).toHaveBeenCalledWith(
			"saved-zai",
			expect.objectContaining({
				expectedExternalId: null,
				identity: expect.objectContaining({ externalAccountId: "user-9" }),
			}),
		);
	});

	it("reports a credential that changed under the reconnect", async () => {
		const { handlers, replace } = setup();
		replace.mockResolvedValue(false);
		const { sessionId } = await (
			await handlers.reauthStart(post({ accountId: "saved-zai" }))
		).json();
		const response = await handlers.reauthComplete(
			post({ sessionId, code: "c" }),
		);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("changed during sign-in");
	});

	it("caps concurrent sessions per handler instance without affecting another", async () => {
		const { handlers } = setup();
		for (let index = 0; index < 64; index += 1)
			expect(
				(await handlers.login(post({ name: `account-${index}` }))).status,
			).toBe(200);
		const rejected = await handlers.login(post({ name: "account-65" }));
		expect(rejected.status).toBe(400);
		expect(await rejected.text()).toContain("login limit reached");
		const other = setup();
		expect(
			(await other.handlers.login(post({ name: "elsewhere" }))).status,
		).toBe(200);
	});

	it("never repeats a credential or an upstream message to the caller", async () => {
		const exchange = mock(async () => {
			throw new Error(`upstream said: invalid token ${MINTED}`);
		});
		const handlers = createZaiAccountHandlers(
			{} as DatabaseOperations,
			exchange as never,
		);
		const { sessionId } = await (
			await handlers.login(post({ name: "Subscription" }))
		).json();
		const response = await handlers.complete(post({ sessionId, code: "c" }));
		expect(response.status).toBe(400);
		const body = await response.text();
		expect(body).not.toContain(MINTED);
		expect(body).not.toContain("upstream said");
		expect(body).toContain("Z.AI account verification failed");
	});
});
