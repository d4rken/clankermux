import { expect, it, mock } from "bun:test";
import type { Account } from "@clankermux/types";
import type { ProxyContext } from "../proxy-types";
import { getValidAccessToken, refreshAccessTokenSafe } from "../token-manager";

it("rechecks disable before refreshing a previously selected account", async () => {
	const account = {
		id: "disabled",
		name: "Disabled",
		provider: "zai",
		api_key: "key",
		disabled: false,
	} as Account;
	const refreshToken = mock(() => {
		throw new Error("must not contact provider");
	});
	const ctx = {
		dbOps: { getAccount: async () => ({ ...account, disabled: true }) },
		provider: { refreshToken },
	} as unknown as ProxyContext;
	await expect(refreshAccessTokenSafe(account, ctx)).rejects.toThrow(
		"Account is disabled",
	);
	expect(refreshToken).not.toHaveBeenCalled();
});

it("rejects a disabled account before handing out an API key", async () => {
	await expect(
		getValidAccessToken({ disabled: true } as Account, {} as ProxyContext),
	).rejects.toThrow("Account is disabled");
});
