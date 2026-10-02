import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@clankermux/config";
import { DatabaseOperations } from "@clankermux/database";
import { CodexProvider } from "@clankermux/providers";
import { tempDbTracker } from "@clankermux/test-support";
import type { AccountResponse } from "@clankermux/types";
import {
	createAccountFastModeHandler,
	createAccountsListHandler,
} from "../accounts";

/**
 * The toggle end to end against a real database: the API writes the flag, the
 * account loader the proxy routes with reads it back as a boolean, and the
 * provider that account reaches sends `priority`. A flag stored but mapped
 * wrong would pass every unit test and never fire.
 */

const temp = tempDbTracker("account-fast-mode");

describe("account fast-mode toggle", () => {
	let db: DatabaseOperations;
	const toggle = (accountId: string, body: unknown) =>
		createAccountFastModeHandler(db)(
			new Request(`http://test/api/accounts/${accountId}/fast-mode`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
			accountId,
		);
	const loaded = async (id: string) =>
		(await db.getAllAccounts()).find((account) => account.id === id);

	beforeEach(async () => {
		db = new DatabaseOperations(temp.next());
		const adapter = db.getAdapter();
		for (const [id, provider, endpoint] of [
			["codex-1", "codex", null],
			["claude-1", "anthropic", null],
			["codex-custom", "codex", "https://example.test/v1/responses"],
			[
				"codex-chatgpt-custom",
				"codex",
				"https://chatgpt.com/backend-api/codex/responses",
			],
		])
			await adapter.run(
				"INSERT INTO accounts (id, name, provider, created_at, refresh_token, custom_endpoint) VALUES (?, ?, ?, ?, '', ?)",
				[id, id, provider, Date.now(), endpoint],
			);
	});

	afterEach(async () => {
		await db.dispose();
		temp.cleanup();
	});

	it("is off by default", async () => {
		expect((await loaded("codex-1"))?.codex_fast_mode_enabled).toBe(false);
	});

	it("persists, reloads as a boolean, and makes the provider send priority", async () => {
		const response = await toggle("codex-1", { enabled: 1 });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ fastModeEnabled: true });

		const account = await loaded("codex-1");
		expect(account?.codex_fast_mode_enabled).toBe(true);

		const transformed = await new CodexProvider().transformRequestBody(
			new Request("https://example.com/v1/messages", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "gpt-6-astra",
					max_tokens: 10,
					messages: [{ role: "user", content: "hello" }],
				}),
			}),
			account,
		);
		expect((await transformed.json()).service_tier).toBe("priority");

		await toggle("codex-1", { enabled: 0 });
		expect((await loaded("codex-1"))?.codex_fast_mode_enabled).toBe(false);
	});

	it("refuses non-Codex accounts, unknown accounts and a missing value", async () => {
		expect((await toggle("claude-1", { enabled: 1 })).status).toBe(400);
		expect((await toggle("nope", { enabled: 1 })).status).toBe(404);
		expect((await toggle("codex-1", {})).status).toBe(400);
		expect((await loaded("claude-1"))?.codex_fast_mode_enabled).toBe(false);
	});

	it("refuses to enable it where it cannot take effect, but always lets it be turned off", async () => {
		expect((await toggle("codex-custom", { enabled: 1 })).status).toBe(400);
		expect((await loaded("codex-custom"))?.codex_fast_mode_enabled).toBe(false);

		// A flag set while on ChatGPT, stranded by a later endpoint change.
		await db.setCodexFastModeEnabled("codex-custom", true);
		expect((await toggle("codex-custom", { enabled: 0 })).status).toBe(200);
		expect((await loaded("codex-custom"))?.codex_fast_mode_enabled).toBe(false);

		expect((await toggle("codex-chatgpt-custom", { enabled: 1 })).status).toBe(
			200,
		);
	});

	it("reports in the account list whether fast mode takes effect", async () => {
		const config = {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
		} as unknown as Config;
		const list = (await (
			await createAccountsListHandler(db, config)()
		).json()) as AccountResponse[];
		const available = Object.fromEntries(
			list.map((account) => [account.id, account.fastModeAvailable]),
		);
		expect(available).toEqual({
			"codex-1": true,
			"claude-1": false,
			"codex-custom": false,
			"codex-chatgpt-custom": true,
		});
	});
});
