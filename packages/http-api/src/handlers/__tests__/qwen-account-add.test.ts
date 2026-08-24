/**
 * The Qwen device-flow account-add path, on a database created before
 * `accounts.auto_pause_on_overage_enabled` flipped to DEFAULT 1 (c20d32c3,
 * 2026-06-23). Every database at or below the supported migration floor — and
 * this deployment's own — still has DEFAULT 0 there, and `ALTER TABLE ADD
 * COLUMN` cannot change an existing column's default, so an INSERT that omits
 * the column creates accounts with overage auto-pause OFF on older installs
 * and ON on fresh ones.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { DatabaseOperations } from "@clankermux/database";
import { DatabaseFactory, ensureSchema } from "@clankermux/database";
import * as qwenDeviceFlow from "@clankermux/providers/qwen";
import { tempDbTracker } from "@clankermux/test-support";

// The real module is spread back in so this mock replaces exactly the two
// network functions and nothing else — bun's mock.module is process-wide, and a
// partial replacement breaks any later test file that imports the rest.
mock.module("@clankermux/providers/qwen", () => ({
	...qwenDeviceFlow,
	initiateDeviceFlow: mock(async () => ({
		deviceCode: "device-code",
		userCode: "USER-CODE",
		verificationUri: "https://chat.qwen.ai/authorize",
		verificationUriComplete:
			"https://chat.qwen.ai/authorize?user_code=USER-CODE",
		expiresIn: 600,
		interval: 0,
		pkce: { verifier: "v", challenge: "c" },
	})),
	pollForToken: mock(async () => ({
		access_token: "access",
		refresh_token: "refresh",
		token_type: "Bearer",
		resource_url: "portal.qwen.ai",
		expires_in: 3600,
	})),
}));

const { createQwenDeviceFlowInitHandler, createQwenDeviceFlowStatusHandler } =
	await import("../oauth");

const tmpDb = tempDbTracker("test-qwen-account-add-legacy-default");

function post(body: unknown): Request {
	return new Request("http://localhost/api/oauth/qwen/init", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

/**
 * Build the accounts table from the CURRENT DDL with only the default
 * reverted, then let DatabaseFactory open it: `CREATE TABLE IF NOT EXISTS`
 * leaves the existing table, and its default, alone.
 */
function seedLegacyDefaultDb(dbPath: string): void {
	const template = new Database(":memory:");
	ensureSchema(template);
	const { sql } = template
		.prepare(
			`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accounts'`,
		)
		.get() as { sql: string };
	template.close();

	const legacy = sql.replace(
		"auto_pause_on_overage_enabled INTEGER DEFAULT 1",
		"auto_pause_on_overage_enabled INTEGER DEFAULT 0",
	);
	if (legacy === sql) {
		throw new Error(
			"accounts DDL no longer carries the DEFAULT 1 this fixture reverts",
		);
	}

	const db = new Database(dbPath, { create: true });
	db.run(legacy);
	db.close();
}

/** Wait for the handler's background polling to finish creating the account. */
async function awaitCompletion(
	status: (sessionId: string) => Response,
	sessionId: string,
): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const body = (await status(sessionId).json()) as {
			status: string;
			error?: string;
		};
		if (body.status === "complete") return;
		if (body.status === "error") throw new Error(body.error);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Qwen device flow did not complete");
}

describe("Qwen device flow account creation on a database with the old default", () => {
	let dbOps: DatabaseOperations;

	beforeEach(() => {
		const legacyDbPath = tmpDb.next();
		seedLegacyDefaultDb(legacyDbPath);
		DatabaseFactory.initialize(legacyDbPath);
		dbOps = DatabaseFactory.getInstance();
	});

	afterEach(() => {
		// reset() closes the singleton connection before the files go away.
		try {
			DatabaseFactory.reset();
		} finally {
			tmpDb.cleanup();
		}
	});

	it("enables overage auto-pause explicitly instead of inheriting the default", async () => {
		const columnDefault = dbOps
			.getDatabase()
			.query<{ dflt_value: string | null }, []>(
				`SELECT dflt_value FROM pragma_table_xinfo('accounts')
				 WHERE name = 'auto_pause_on_overage_enabled'`,
			)
			.get();
		// Without this the test would pass for the wrong reason.
		expect(columnDefault?.dflt_value).toBe("0");

		const init = createQwenDeviceFlowInitHandler(dbOps);
		const res = await init(post({ name: "qwen-acct", priority: 0 }));
		expect(res.status).toBe(200);
		const { sessionId } = (await res.json()) as { sessionId: string };

		await awaitCompletion(createQwenDeviceFlowStatusHandler(), sessionId);

		const stored = dbOps
			.getDatabase()
			.query<
				{ provider: string; auto_pause_on_overage_enabled: number },
				[string]
			>(
				`SELECT provider, auto_pause_on_overage_enabled FROM accounts WHERE name = ?`,
			)
			.get("qwen-acct");
		expect(stored?.provider).toBe("qwen");
		expect(stored?.auto_pause_on_overage_enabled).toBe(1);
	});
});
