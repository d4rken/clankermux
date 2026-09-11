import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	DatabaseFactory,
	type DatabaseOperations,
	runMigrations,
} from "@clankermux/database";
import { tempDbTracker } from "@clankermux/test-support";
import { createAccountRefreshUsageHandler } from "../handlers/accounts";
import {
	API_KEY_PROVIDERS,
	createApiKeyAccountAddHandler,
} from "../handlers/api-key-account-add";
import {
	readOpenRouterAccountMetadata,
	refreshOpenRouterAccountMetadata,
	refreshOpenRouterAccountsOnStartup,
} from "./openrouter-account-metadata";

const tmp = tempDbTracker("openrouter-metadata");
let dbOps: DatabaseOperations;
let fetchSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
	DatabaseFactory.initialize(tmp.next());
	dbOps = DatabaseFactory.getInstance();
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () =>
		Response.json({
			data: {
				label: "redacted...key",
				creator_user_id: "user_123",
				is_free_tier: false,
				limit: 100,
				limit_remaining: 75,
				usage: 25,
			},
		}),
	);
});
afterEach(() => {
	fetchSpy.mockRestore();
	DatabaseFactory.reset();
	tmp.cleanup();
});
async function add() {
	const response = await createApiKeyAccountAddHandler(
		dbOps,
		API_KEY_PROVIDERS.openrouter,
	)(
		new Request("http://localhost/api/accounts/openrouter", {
			method: "POST",
			body: JSON.stringify({ name: "Router", apiKey: "test-secret" }),
		}),
	);
	expect(response.status).toBe(200);
	const body = await response.json();
	return body.account.id as string;
}
async function snapshot(id: string) {
	return (
		await dbOps
			.getAdapter()
			.get<{ openrouter_metadata_json: string | null }>(
				"SELECT openrouter_metadata_json FROM accounts WHERE id = ?",
				[id],
			)
	)?.openrouter_metadata_json;
}

describe("OpenRouter metadata lifecycle", () => {
	it("publishes only declared metadata fields from a stored snapshot", async () => {
		const id = await add();
		const metadata = JSON.parse((await snapshot(id)) as string);
		expect(
			readOpenRouterAccountMetadata(
				JSON.stringify({ ...metadata, unexpectedPrivateField: "private" }),
			),
		).toEqual(metadata);
	});
	it("populates a new account, refreshes without OAuth tokens, and keeps a snapshot on failure", async () => {
		const id = await add();
		const first = await snapshot(id);
		expect(JSON.parse(first as string)).toMatchObject({
			creatorUserId: "user_123",
			limitRemainingUsd: 75,
		});
		fetchSpy.mockImplementation(async () =>
			Response.json({ data: { usage: 30, limit_remaining: 70 } }),
		);
		const refresh = createAccountRefreshUsageHandler(dbOps);
		expect(
			await (await refresh(new Request("http://localhost"), id)).json(),
		).toMatchObject({ success: true });
		const updated = await snapshot(id);
		expect(JSON.parse(updated as string).usageUsd).toBe(30);
		fetchSpy.mockImplementation(
			async () => new Response("offline", { status: 503 }),
		);
		expect(
			await (await refresh(new Request("http://localhost"), id)).json(),
		).toMatchObject({ success: false });
		expect(await snapshot(id)).toBe(updated);
	});
	it("does not fail account creation when metadata is unavailable and retries existing accounts at startup", async () => {
		fetchSpy.mockImplementation(
			async () => new Response("offline", { status: 503 }),
		);
		const id = await add();
		expect(await snapshot(id)).toBeNull();
		fetchSpy.mockImplementation(async () =>
			Response.json({ data: { label: "restored" } }),
		);
		await refreshOpenRouterAccountsOnStartup(dbOps);
		expect(JSON.parse((await snapshot(id)) as string).label).toBe("restored");
	});
	it("skips other providers and custom endpoints", async () => {
		const id = await add();
		fetchSpy.mockClear();
		for (const account of [
			{ id, provider: "codex", api_key: "key" },
			{
				id,
				provider: "openrouter",
				api_key: "key",
				custom_endpoint: "https://example.test",
			},
		]) {
			expect(await refreshOpenRouterAccountMetadata(dbOps, account)).toBeNull();
		}
		expect(fetchSpy).not.toHaveBeenCalled();
	});
	it("adds the snapshot column to an existing database idempotently", () => {
		const db = dbOps.getDatabase();
		db.run("ALTER TABLE accounts DROP COLUMN openrouter_metadata_json");
		runMigrations(db);
		runMigrations(db);
		expect(
			db.query("SELECT openrouter_metadata_json FROM accounts").all(),
		).toEqual([]);
	});
});
