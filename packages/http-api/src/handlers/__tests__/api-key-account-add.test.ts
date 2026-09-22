import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { DatabaseOperations } from "@clankermux/database";
import { DatabaseFactory, ensureSchema } from "@clankermux/database";
import { registerPollingRestarter } from "@clankermux/proxy";
import { mockFetch, tempDbTracker } from "@clankermux/test-support";
import {
	API_KEY_PROVIDERS,
	createApiKeyAccountAddHandler,
} from "../api-key-account-add";

const tmpDb = tempDbTracker("test-api-key-account-add");

function post(body: unknown): Request {
	return new Request("http://localhost/api/accounts/x", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("createApiKeyAccountAddHandler", () => {
	let dbOps: DatabaseOperations;
	let fetchSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			mockFetch(async () => new Response(null, { status: 401 })),
		);
		DatabaseFactory.initialize(tmpDb.next());
		dbOps = DatabaseFactory.getInstance();
		// A fresh database no longer gets accounts.model_mappings; an upgraded
		// one still carries it. Add it back here, because that is the database
		// where writing to it would still be possible — and where the handler
		// must leave it alone.
		dbOps
			.getAdapter()
			.getSQLiteDb()
			.run("ALTER TABLE accounts ADD COLUMN model_mappings TEXT");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		// reset() closes the singleton connection before the files go away.
		try {
			DatabaseFactory.reset();
		} finally {
			tmpDb.cleanup();
		}
	});

	function row(name: string) {
		return dbOps
			.getAdapter()
			.getSQLiteDb()
			.query<
				{
					provider: string;
					api_key: string;
					refresh_token: string | null;
					access_token: string | null;
					custom_endpoint: string | null;
					model_mappings: string | null;
				},
				[string]
			>(
				`SELECT provider, api_key, refresh_token, access_token,
				        custom_endpoint, model_mappings
				 FROM accounts WHERE name = ?`,
			)
			.get(name);
	}

	describe("provider identity", () => {
		it("stores only actual Devin session expiry, leaving opaque tokens undated", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.devin,
			);
			const jwt = `header.${Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString("base64url")}.signature`;
			for (const [name, apiKey, expiresAt] of [
				["dated", jwt, 2_000_000_000_000],
				["opaque", "opaque-session", null],
			] as const) {
				const response = await handler(post({ name, apiKey }));
				expect(response.status).toBe(200);
				const body = await response.json();
				expect(body.account.tokenExpiresAt).toBe(
					expiresAt ? new Date(expiresAt).toISOString() : null,
				);
				expect(
					dbOps
						.getAdapter()
						.getSQLiteDb()
						.query("SELECT expires_at FROM accounts WHERE name=?")
						.get(name),
				).toEqual({ expires_at: expiresAt });
			}
		});
		it("stores Devin session tokens only in api_key and ignores retired model mappings", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.devin,
			);
			const response = await handler(
				post({
					name: "devin-free",
					apiKey: "session-private",
					modelMappings: { opus: "swe-2-high" },
				}),
			);
			expect(response.status).toBe(200);
			expect(row("devin-free")).toMatchObject({
				provider: "devin",
				api_key: "session-private",
				access_token: null,
				refresh_token: null,
				custom_endpoint: null,
				model_mappings: null,
			});
			expect(await response.text()).not.toContain("session-private");
		});
		it("writes the spec's provider string, not the spec key", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.openai,
			);

			const res = await handler(
				post({
					name: "acct",
					apiKey: "k",
					customEndpoint: "https://example.test/v1",
				}),
			);

			expect(res.status).toBe(200);
			expect(row("acct")?.provider).toBe("openai-compatible");
		});

		it("returns customEndpoint in the response account", async () => {
			// The OpenAI-compatible handler reported this; dropping it would change
			// the HTTP contract for any client not re-fetching the account list.
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.openai,
			);

			const res = await handler(
				post({
					name: "acct",
					apiKey: "k",
					customEndpoint: "https://example.test/v1",
				}),
			);
			const data = (await res.json()) as {
				account: { customEndpoint: string | null };
			};

			expect(data.account.customEndpoint).toBe("https://example.test/v1");
		});

		it("reports a null customEndpoint for providers without one", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.kilo,
			);

			const res = await handler(post({ name: "acct", apiKey: "k" }));
			const data = (await res.json()) as {
				account: { customEndpoint: string | null };
			};

			expect(data.account.customEndpoint).toBeNull();
		});

		it("stores a Grok key under its own provider with no endpoint", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.grok,
			);

			const res = await handler(post({ name: "grok-acct", apiKey: "xai-key" }));

			expect(res.status).toBe(200);
			expect(row("grok-acct")).toMatchObject({
				provider: "grok",
				api_key: "xai-key",
				refresh_token: "xai-key",
				access_token: "xai-key",
				custom_endpoint: null,
			});
		});

		it("uses the spec's label in the success message", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.zai,
			);

			const res = await handler(post({ name: "acct", apiKey: "k" }));
			const data = (await res.json()) as { message: string };

			expect(data.message).toBe("z.ai account 'acct' added successfully");
		});
	});

	describe("api key source", () => {
		it("requires apiKey when the spec reads it from the body", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.kilo,
			);

			const res = await handler(post({ name: "acct" }));
			const data = (await res.json()) as { error: string };

			expect(res.status).toBe(400);
			expect(data.error).toContain("apiKey is required");
		});

		it("trims surrounding whitespace from the key", async () => {
			// The key is mirrored into refresh_token/access_token, so a pasted key
			// with stray whitespace would authenticate as garbage.
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.ollamaCloud,
			);

			await handler(post({ name: "acct", apiKey: "  secret\n" }));

			const stored = row("acct");
			expect(stored?.api_key).toBe("secret");
			expect(stored?.refresh_token).toBe("secret");
		});

		it("substitutes the fixed key without requiring one in the body", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.ollama,
			);

			const res = await handler(post({ name: "acct" }));

			expect(res.status).toBe(200);
			expect(row("acct")?.api_key).toBe("ollama");
		});
	});

	describe("token mirroring", () => {
		it("mirrors the key into both token columns when the spec says so", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.zai,
			);

			await handler(post({ name: "acct", apiKey: "secret" }));

			const stored = row("acct");
			expect(stored?.refresh_token).toBe("secret");
			expect(stored?.access_token).toBe("secret");
		});

		it("leaves both token columns NULL for providers that opt out", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.openrouter,
			);

			await handler(post({ name: "acct", apiKey: "secret" }));

			const stored = row("acct");
			expect(stored?.api_key).toBe("secret");
			expect(stored?.refresh_token).toBeNull();
			expect(stored?.access_token).toBeNull();
		});
	});

	describe("custom endpoint", () => {
		it("rejects a missing endpoint when the spec requires one", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.openai,
			);

			const res = await handler(post({ name: "acct", apiKey: "k" }));

			expect(res.status).toBe(400);
		});

		it("accepts a missing endpoint when the spec makes it optional", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.anthropicCompatible,
			);

			const res = await handler(post({ name: "acct", apiKey: "k" }));

			expect(res.status).toBe(200);
			expect(row("acct")?.custom_endpoint).toBeNull();
		});

		it("rejects a malformed endpoint URL", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.anthropicCompatible,
			);

			const res = await handler(
				post({ name: "acct", apiKey: "k", customEndpoint: "not-a-url" }),
			);

			expect(res.status).toBe(400);
		});

		it("refuses a body endpoint for a provider that pins its own", async () => {
			// ZaiProvider.buildUrl discards the account, so an endpoint accepted
			// here could never take effect. Refusing beats accepting-and-dropping:
			// a 200 that quietly ignores what the operator asked for is the same
			// defect as storing a value nothing reads.
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.zai,
			);

			const res = await handler(
				post({
					name: "acct",
					apiKey: "k",
					customEndpoint: "https://mirror.example.com",
				}),
			);

			expect(res.status).toBe(400);
			expect(row("acct")).toBeNull();
		});

		it("creates the account when such a provider is sent no endpoint", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.zai,
			);

			const res = await handler(post({ name: "acct", apiKey: "k" }));

			expect(res.status).toBe(200);
			expect(row("acct")?.custom_endpoint).toBeNull();
		});

		it("writes the fixed endpoint when the spec supplies one", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.ollamaCloud,
			);

			await handler(post({ name: "acct", apiKey: "k" }));

			expect(row("acct")?.custom_endpoint).toBe("https://ollama.com");
		});

		it("never lets a body value reach a fixed endpoint", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.ollamaCloud,
			);

			const res = await handler(
				post({
					name: "acct",
					apiKey: "k",
					customEndpoint: "https://attacker.test",
				}),
			);

			expect(res.status).toBe(400);
			expect(row("acct")).toBeNull();
		});

		describe("MiMo regional base URLs", () => {
			function mimoHandler() {
				return createApiKeyAccountAddHandler(dbOps, API_KEY_PROVIDERS.mimo);
			}

			it.each([
				["cn", "https://token-plan-cn.xiaomimimo.com/anthropic"],
				["sgp", "https://token-plan-sgp.xiaomimimo.com/anthropic"],
				["ams", "https://token-plan-ams.xiaomimimo.com/anthropic"],
			])("stores the %s region verbatim", async (region, endpoint) => {
				const res = await mimoHandler()(
					post({
						name: `mimo-${region}`,
						apiKey: "tp-key",
						customEndpoint: endpoint,
					}),
				);

				expect(res.status).toBe(200);
				expect(row(`mimo-${region}`)?.custom_endpoint).toBe(endpoint);
			});

			it("leaves the column NULL when no region is named", async () => {
				// MimoProvider supplies Singapore at request time; writing it here
				// would freeze today's default into every account row.
				const res = await mimoHandler()(
					post({ name: "mimo-default", apiKey: "tp-key" }),
				);

				expect(res.status).toBe(200);
				expect(row("mimo-default")?.custom_endpoint).toBeNull();
			});

			it("mirrors the Token Plan key into both token columns", async () => {
				await mimoHandler()(post({ name: "mimo-key", apiKey: "tp-key" }));

				expect(row("mimo-key")).toMatchObject({
					provider: "mimo",
					api_key: "tp-key",
					refresh_token: "tp-key",
					access_token: "tp-key",
				});
			});

			it.each([
				[
					"a query string",
					"https://token-plan-sgp.xiaomimimo.com/anthropic?x=1",
				],
				["a fragment", "https://token-plan-sgp.xiaomimimo.com/anthropic#frag"],
				[
					"embedded credentials",
					"https://user:pw@token-plan-sgp.xiaomimimo.com/anthropic",
				],
				["a non-http scheme", "ftp://token-plan-sgp.xiaomimimo.com/anthropic"],
			])("rejects %s with a 400", async (_case, endpoint) => {
				// Each of these parses as a URL, so only the shape check stops it —
				// and it has to be a 400, not the 500 a bare Error would produce.
				const res = await mimoHandler()(
					post({
						name: "mimo-bad",
						apiKey: "tp-key",
						customEndpoint: endpoint,
					}),
				);

				expect(res.status).toBe(400);
				expect(row("mimo-bad")).toBeNull();
			});

			it("leaves the other body-endpoint providers unconstrained", async () => {
				// Operators may already have such a value stored for these, so the
				// constraint belongs to the mimo spec rather than to readEndpoint.
				const res = await createApiKeyAccountAddHandler(
					dbOps,
					API_KEY_PROVIDERS.anthropicCompatible,
				)(
					post({
						name: "anth-query",
						apiKey: "k",
						customEndpoint: "https://mirror.example.com/v1?tenant=7",
					}),
				);

				expect(res.status).toBe(200);
				expect(row("anth-query")?.custom_endpoint).toBe(
					"https://mirror.example.com/v1?tenant=7",
				);
			});
		});

		it("writes NULL for providers with no endpoint", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.kilo,
			);

			await handler(post({ name: "acct", apiKey: "k" }));

			expect(row("acct")?.custom_endpoint).toBeNull();
		});
	});

	describe("retired model mappings", () => {
		it("does not persist retired mappings", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.kilo,
			);

			const res = await handler(
				post({
					name: "acct",
					apiKey: "k",
					modelMappings: { "claude-sonnet-5": "claude-opus-5" },
				}),
			);

			expect(res.status).toBe(200);
			expect(row("acct")?.model_mappings).toBeNull();
		});

		it("stores SQL NULL — not the string 'null' — when mappings are absent", async () => {
			// Regression: ollama and ollama-cloud previously ran
			// JSON.stringify(validated) unguarded, so an absent/invalid mapping
			// wrote the 4-character string "null" into the column.
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.ollama,
			);

			await handler(post({ name: "acct" }));

			const stored = row("acct");
			expect(stored?.model_mappings).toBeNull();
			expect(stored?.model_mappings).not.toBe("null");
		});

		it("ignores obsolete invalid mappings", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.openai,
			);

			const res = await handler(
				post({
					name: "acct",
					apiKey: "k",
					customEndpoint: "https://example.test/v1",
					modelMappings: { "": "" },
				}),
			);

			expect(res.status).toBe(200);
		});

		it("ignores an obsolete non-object modelMappings", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.kilo,
			);

			const res = await handler(
				post({ name: "acct", apiKey: "k", modelMappings: "nope" }),
			);

			expect(res.status).toBe(200);
		});

		it("ignores modelMappings for a provider that does not support them", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.minimax,
			);

			const res = await handler(
				post({
					name: "acct",
					apiKey: "k",
					modelMappings: { "claude-sonnet-5": "claude-opus-5" },
				}),
			);

			expect(res.status).toBe(200);
			expect(row("acct")?.model_mappings).toBeNull();
		});
	});

	describe("shared validation", () => {
		it("requires a name", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.kilo,
			);

			const res = await handler(post({ apiKey: "k" }));
			const data = (await res.json()) as { error: string };

			expect(res.status).toBe(400);
			expect(data.error).toContain("name is required");
		});

		it("defaults priority to 0", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.kilo,
			);

			const res = await handler(post({ name: "acct", apiKey: "k" }));
			const data = (await res.json()) as { account: { priority: number } };

			expect(data.account.priority).toBe(0);
		});

		it("rejects a duplicate account name", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.kilo,
			);

			expect((await handler(post({ name: "dup", apiKey: "k" }))).status).toBe(
				200,
			);
			expect(
				(await handler(post({ name: "dup", apiKey: "k" }))).status,
			).not.toBe(200);
		});
	});

	describe("spec table", () => {
		it("has a unique provider string per entry", () => {
			const providers = Object.values(API_KEY_PROVIDERS).map((s) => s.provider);
			expect(new Set(providers).size).toBe(providers.length);
		});
	});

	/**
	 * These assert at the HANDLER boundary on purpose. Testing
	 * `primeUsagePollingForNewAccount` directly cannot catch the bug this fixes:
	 * the helper was already correct, and what was missing was the CALL from
	 * this handler. Delete that call and only these tests go red.
	 */
	describe("usage polling priming", () => {
		// The restarter registry has no unregister hook and
		// `restartUsagePollingForAccount` fans out to every entry, so register
		// exactly one for this file and reset its recorder per test.
		let primed: string[] = [];
		let primingThrows = false;
		beforeEach(() => {
			primed = [];
			primingThrows = false;
			registerPollingRestarter("api-key-account-add-test", async (id) => {
				if (primingThrows) throw new Error("restarter exploded");
				primed.push(id);
				return true;
			});
		});

		it("primes a new Z.AI account exactly once, after the row exists", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.zai,
			);
			const response = await handler(post({ name: "zai-1", apiKey: "k" }));
			expect(response.status).toBe(200);
			const { account } = (await response.json()) as {
				account: { id: string };
			};
			// Primed with the id of a row that already exists: the restarter looks
			// the account up and would find nothing if this ran before the insert.
			expect(primed).toEqual([account.id]);
			expect(row("zai-1")?.provider).toBe("zai");
		});

		it("primes a new Kilo account", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.kilo,
			);
			const response = await handler(post({ name: "kilo-1", apiKey: "k" }));
			expect(response.status).toBe(200);
			expect(primed).toHaveLength(1);
		});

		it("does not prime a provider with no pollable usage window", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.openai,
			);
			const response = await handler(
				post({
					name: "oai-1",
					apiKey: "k",
					customEndpoint: "https://oai.example/v1",
				}),
			);
			expect(response.status).toBe(200);
			expect(primed).toEqual([]);
		});

		it("still creates the account when priming fails", async () => {
			primingThrows = true;
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.zai,
			);
			const response = await handler(post({ name: "zai-2", apiKey: "k" }));
			// Priming is best-effort: a poller that will not start is a worse
			// dashboard, not a failed account creation.
			expect(response.status).toBe(200);
			expect(row("zai-2")?.provider).toBe("zai");
		});

		it("does not prime when creation is rejected", async () => {
			const handler = createApiKeyAccountAddHandler(
				dbOps,
				API_KEY_PROVIDERS.zai,
			);
			// Missing apiKey — validation refuses before any row is written.
			const response = await handler(post({ name: "zai-3" }));
			expect(response.status).not.toBe(200);
			expect(primed).toEqual([]);
		});
	});
});

/**
 * Databases created before c20d32c3 (2026-06-23) — including every database at
 * the supported migration floor, and this deployment's own — have
 * `accounts.auto_pause_on_overage_enabled INTEGER DEFAULT 0`, where a fresh
 * install has DEFAULT 1. No ALTER can change an existing column's default, so
 * an INSERT that leaves the column out creates accounts with overage
 * auto-pause OFF there and ON here, forever.
 */
describe("createApiKeyAccountAddHandler on a database with the old default", () => {
	let dbOps: DatabaseOperations;
	let legacyDbPath: string;

	/**
	 * Build the accounts table from the CURRENT DDL with only the default
	 * reverted, then let DatabaseFactory open it: `CREATE TABLE IF NOT EXISTS`
	 * leaves the existing table, and its default, alone.
	 */
	function seedLegacyDefaultDb(): void {
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

		const db = new Database(legacyDbPath, { create: true });
		db.run(legacy);
		db.close();
	}

	beforeEach(() => {
		legacyDbPath = tmpDb.next();
		seedLegacyDefaultDb();
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
			.getAdapter()
			.getSQLiteDb()
			.query<{ dflt_value: string | null }, []>(
				`SELECT dflt_value FROM pragma_table_xinfo('accounts')
				 WHERE name = 'auto_pause_on_overage_enabled'`,
			)
			.get();
		// Without this the test would pass for the wrong reason.
		expect(columnDefault?.dflt_value).toBe("0");

		const handler = createApiKeyAccountAddHandler(
			dbOps,
			API_KEY_PROVIDERS.kilo,
		);
		const res = await handler(post({ name: "acct", apiKey: "k" }));
		expect(res.status).toBe(200);

		const stored = dbOps
			.getAdapter()
			.getSQLiteDb()
			.query<{ auto_pause_on_overage_enabled: number }, [string]>(
				`SELECT auto_pause_on_overage_enabled FROM accounts WHERE name = ?`,
			)
			.get("acct");
		expect(stored?.auto_pause_on_overage_enabled).toBe(1);
	});
});
