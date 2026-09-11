import { describe, expect, it, mock, spyOn } from "bun:test";
import type { DatabaseOperations } from "@clankermux/database";
import { usageCache } from "@clankermux/providers";
import { createDevinAccountHandlers } from "./devin-accounts";

const post = (body: unknown) =>
	new Request("http://localhost/api/accounts/devin/reauth", {
		method: "POST",
		body: JSON.stringify(body),
	});
const existing = {
	id: "saved-devin",
	name: "My account",
	provider: "devin",
	api_key: "old",
	custom_endpoint: "https://server.codeium.com",
	identity_external_id: "user-1",
	priority: 4,
};
const info = {
	userJwt: "private-jwt",
	endpoint: "https://server.codeium.com",
	models: [],
	usage: {
		kind: "devin",
		email: "user@example.test",
		accountId: "user-1",
		planName: "Free",
	},
};
function setup() {
	const replace = mock(async () => true);
	const get = mock(async () => existing);
	const verify = mock(async () => info);
	const invalidate = mock(() => {});
	const exchange = mock(async () => "new-session");
	const db = {
		getAccount: get,
		reconnectDevinAccount: replace,
	} as unknown as DatabaseOperations;
	return {
		handlers: createDevinAccountHandlers(
			db,
			{ getAccount: verify, invalidateAccount: invalidate } as never,
			exchange,
		),
		replace,
		get,
		verify,
		invalidate,
		exchange,
	};
}
describe("Devin reconnect", () => {
	it("verifies replacement session then updates the existing account without exposing credentials", async () => {
		const { handlers, replace, verify, invalidate } = setup();
		const response = await handlers.reauthToken(
			post({ accountId: "saved-devin", apiKey: "new-session" }),
		);
		expect(response.status).toBe(200);
		expect(invalidate).toHaveBeenCalledWith(
			"new-session",
			existing.custom_endpoint,
		);
		expect(verify).toHaveBeenCalledWith(
			"new-session",
			existing.custom_endpoint,
			expect.any(AbortSignal),
		);
		expect(replace).toHaveBeenCalledWith(
			"saved-devin",
			expect.objectContaining({
				apiKey: "new-session",
				expectedApiKey: "old",
				expectedEndpoint: existing.custom_endpoint,
				expectedExternalId: "user-1",
				expiresAt: null,
			}),
		);
		const body = await response.text();
		expect(body).not.toContain("new-session");
		expect(body).not.toContain("private-jwt");
	});
	it("rejects a different identity before mutation", async () => {
		const { handlers, replace, verify } = setup();
		verify.mockResolvedValue({
			...info,
			usage: { ...info.usage, accountId: "someone-else" },
		});
		const response = await handlers.reauthToken(
			post({ accountId: "saved-devin", apiKey: "new-session" }),
		);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("different");
		expect(replace).not.toHaveBeenCalled();
	});
	it("rejects missing verified identity and wrong provider", async () => {
		const first = setup();
		first.verify.mockResolvedValue({
			...info,
			usage: { ...info.usage, accountId: "" },
		});
		expect(
			(
				await first.handlers.reauthToken(
					post({ accountId: "saved-devin", apiKey: "new-session" }),
				)
			).status,
		).toBe(400);
		expect(first.replace).not.toHaveBeenCalled();
		const second = setup();
		second.get.mockResolvedValue({ ...existing, provider: "codex" });
		expect(
			(await second.handlers.reauthStart(post({ accountId: "saved-devin" })))
				.status,
		).toBe(400);
		expect(second.exchange).not.toHaveBeenCalled();
	});
	it("reports concurrent credential replacement and leaves the winner's cache intact", async () => {
		const { handlers, replace } = setup();
		replace.mockResolvedValue(false);
		const clear = spyOn(usageCache, "delete");
		try {
			const response = await handlers.reauthToken(
				post({ accountId: "saved-devin", apiKey: "new-session" }),
			);
			expect(response.status).toBe(400);
			expect(await response.text()).toContain("changed");
			expect(clear).not.toHaveBeenCalled();
		} finally {
			clear.mockRestore();
		}
	});
	it("binds the browser session to its initial account generation and consumes it once", async () => {
		const { handlers, replace, get, exchange } = setup();
		const start = await handlers.reauthStart(
			post({ accountId: "saved-devin" }),
		);
		const login = await start.json();
		expect(login.authUrl).toContain("code_challenge=");
		expect(new URL(login.authUrl).searchParams.has("redirect_uri")).toBe(false);
		expect(login.verifier).toBeUndefined();
		get.mockResolvedValue({ ...existing, api_key: "concurrent" });
		const response = await handlers.reauthComplete(
			post({ sessionId: login.sessionId, code: "private-code" }),
		);
		expect(response.status).toBe(200);
		expect(replace).toHaveBeenCalledWith(
			"saved-devin",
			expect.objectContaining({ expectedApiKey: "old" }),
		);
		expect(exchange).toHaveBeenCalledTimes(1);
		expect(exchange).toHaveBeenCalledWith(
			expect.objectContaining({ flow: "manual" }),
			"private-code",
		);
		expect(
			(
				await handlers.reauthComplete(
					post({ sessionId: login.sessionId, code: "private-code" }),
				)
			).status,
		).toBe(400);
	});
	it("does not let reconnect sessions create another account", async () => {
		const { handlers, replace, exchange } = setup();
		const login = await (
			await handlers.reauthStart(post({ accountId: "saved-devin" }))
		).json();
		expect(
			(
				await handlers.complete(
					post({ sessionId: login.sessionId, code: "private-code" }),
				)
			).status,
		).toBe(400);
		expect(replace).not.toHaveBeenCalled();
		expect(exchange).not.toHaveBeenCalled();
	});
});
