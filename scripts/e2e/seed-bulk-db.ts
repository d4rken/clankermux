#!/usr/bin/env bun
/**
 * Builds the throwaway database the bulk-catalogue end-to-end run drives.
 *
 * Everything here is invented. The instance that serves the run is a real
 * ClankerMux pointed at this file's output instead of anyone's live database,
 * inside a network namespace with no route off loopback.
 *
 * The three clients are shaped so the interesting paths are all reachable:
 * two generic clients on every account (the batch), and one Claude Code client
 * pinned to a single account, which refuses catalogue entries the other two
 * accept.
 *
 * Usage:
 *   bun scripts/e2e/seed-bulk-db.ts --db /tmp/…/e2e.db
 */

import { Database } from "bun:sqlite";
import {
	AuthRepository,
	BunSqlAdapter,
	CLIENT_CATALOGUE_BACKFILL_MARKER,
	runMigrations,
} from "@clankermux/database";
import type { Account, ClientProfile } from "@clankermux/types";
// Deep imports rather than the package barrels: both barrels pull in the whole
// server surface, which starts timers, so a seeding run would do all its work
// and then never exit. The root tsconfig typechecks this file, so a move or a
// rename on either side fails here rather than at run time.
import { modelPermissionScope } from "../../packages/proxy/src/account-model-permissions";
import { scryptPasswordHasher } from "../../packages/http-api/src/services/session-auth-service";

/** Guards a database of invented accounts that lives for one run. */
export const E2E_PASSWORD = "bulk-catalogue-e2e";

/** The ID the run adds to both selected clients. Only discovery offers it. */
export const SUGGESTED_MODEL = "shared-model";
/** The ID only the first selected client starts with. */
export const ALPHA_MODEL = "alpha-model";
/** The ID the run types by hand: no client and no discovery offers it. */
export const CUSTOM_ALIAS = "alpha-model[1m]";

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDbPath(argv: string[]): string {
	const index = argv.indexOf("--db");
	const value = index === -1 ? undefined : argv[index + 1];
	if (value === undefined) {
		console.error("Usage: bun scripts/e2e/seed-bulk-db.ts --db <path>");
		process.exit(1);
	}
	return value;
}

const ACCOUNTS = [
	{ id: "acct-one", name: "Local One" },
	{ id: "acct-two", name: "Local Two" },
];

function seedAccounts(db: Database, now: number): void {
	const insert = db.prepare(`
		INSERT INTO accounts (
			id, name, provider, api_key, created_at, last_used, request_count,
			total_requests, priority, paused, auto_refresh_enabled,
			auto_fallback_enabled, billing_type
		) VALUES (?, ?, 'ollama', ?, ?, NULL, 0, 0, 0, 0, 0, 0, 'api')
	`);
	for (const account of ACCOUNTS)
		insert.run(account.id, account.name, `mock-key-${account.id}`, now - DAY_MS);
}

/**
 * One completed permission discovery, so `/api/clients/suggestions` offers
 * {@link SUGGESTED_MODEL} without the instance reaching any upstream. The scope
 * is the service's own hash of the account's identity: a row under any other
 * scope reads as stale and is discarded.
 */
function seedDiscovery(db: Database, now: number): void {
	const account = db
		.query("SELECT * FROM accounts WHERE id=?")
		.get("acct-one") as Account;
	db.prepare(
		`INSERT INTO account_model_permissions
		   (account_id, scope, generation, completeness, discovered_ids, manual_ids,
		    last_success_at, last_attempt_at, last_error)
		 VALUES (?, ?, 1, 'known-complete', ?, '[]', ?, ?, NULL)`,
	).run(
		account.id,
		modelPermissionScope(account),
		JSON.stringify([SUGGESTED_MODEL]),
		now,
		now,
	);
}

const CLIENTS: {
	id: string;
	name: string;
	pinnedAccountId: string | null;
	profile: Omit<ClientProfile, "apiKeyId">;
}[] = [
	{
		id: "alpha",
		name: "Alpha",
		pinnedAccountId: null,
		profile: {
			application: "generic",
			revision: 1,
			notices: [],
			catalogues: {
				anthropic: { models: [], defaultModel: null },
				openai: {
					models: [
						{
							id: ALPHA_MODEL,
							displayName: "Alpha model",
							targetModel: ALPHA_MODEL,
							accountIds: null,
						},
					],
					defaultModel: null,
				},
				codex: { models: [], defaultModel: null },
			},
		},
	},
	{
		id: "bravo",
		name: "Bravo",
		pinnedAccountId: null,
		profile: {
			application: "generic",
			revision: 1,
			notices: [],
			catalogues: {
				anthropic: { models: [], defaultModel: null },
				openai: { models: [], defaultModel: null },
				codex: { models: [], defaultModel: null },
			},
		},
	},
	{
		id: "charlie",
		name: "Charlie",
		pinnedAccountId: "acct-two",
		profile: {
			application: "claude-code",
			revision: 1,
			notices: [],
			catalogues: {
				anthropic: { models: [], defaultModel: null },
				openai: { models: [], defaultModel: null },
				codex: { models: [], defaultModel: null },
			},
		},
	},
];

/**
 * The clients and the marker row. `ClientRepository.bootstrap()` runs at every
 * boot and, while the marker is absent, inserts one profile per API key, which
 * collides with the rows written here and takes the instance down before it
 * serves anything.
 */
function seedClients(db: Database, now: number): void {
	const insertKey = db.prepare(`
		INSERT INTO api_keys (
			id, name, hashed_key, prefix_last_8, created_at, last_used, usage_count,
			is_active, pinned_account_id, pinned_providers
		) VALUES (?, ?, ?, ?, ?, NULL, 0, 1, ?, NULL)
	`);
	const insertProfile = db.prepare(`
		INSERT INTO client_profiles (api_key_id, application, revision, catalogues, notices)
		VALUES (?, ?, ?, ?, ?)
	`);
	for (const client of CLIENTS) {
		insertKey.run(
			client.id,
			client.name,
			`sha256$${client.id}-not-a-real-hash`,
			client.id.slice(0, 8).padEnd(8, "0"),
			now - DAY_MS,
			client.pinnedAccountId,
		);
		insertProfile.run(
			client.id,
			client.profile.application,
			client.profile.revision,
			JSON.stringify(client.profile.catalogues),
			JSON.stringify(client.profile.notices),
		);
	}
	db.prepare(
		"INSERT INTO strategies (name, config, updated_at) VALUES (?, ?, ?)",
	).run(CLIENT_CATALOGUE_BACKFILL_MARKER, "{}", now);
}

async function main(): Promise<void> {
	const dbPath = parseDbPath(process.argv.slice(2));
	const now = Date.now();
	const db = new Database(dbPath, { create: true });
	db.run("PRAGMA journal_mode = WAL");
	runMigrations(db);

	seedAccounts(db, now);
	seedDiscovery(db, now);
	seedClients(db, now);

	const auth = new AuthRepository(new BunSqlAdapter(db));
	const { verifier, params } = await scryptPasswordHasher.hash(E2E_PASSWORD);
	await auth.setPassword(verifier, params, now);
	db.close();

	console.log(
		`seeded ${dbPath}: ${ACCOUNTS.length} accounts, ${CLIENTS.length} clients`,
	);
}

// Only when invoked directly: the run script imports the model IDs above, and
// an unguarded call would re-seed the database out from under the instance.
if (import.meta.main) await main();
