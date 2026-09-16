/**
 * Builds a throwaway database for QA of the Analytics → Clients tab.
 *
 *   bun scripts/qa/seed-client-analytics.ts --db /tmp/qa-clients.db [--seed 7] [--now <ms>]
 *
 * Seeds API KEYS, CLIENT PROFILES and REQUESTS — and deliberately no accounts.
 * That is what keeps an instance pointed at this database from reaching any
 * provider: the model-catalogue cache fetches only for accounts it can list, so
 * an account-free database has nothing to fetch for.
 *
 * Every harness-label path the tab can render is present, because each one
 * looks like a plain label on screen and only the seeded data says which is
 * which:
 *
 *   observed            client_harness set from the request's own headers
 *   inferred (session)  no harness, but a Claude Code session key
 *   inferred (declared) neither, under a non-generic client profile
 *   unknown             neither, under a generic profile
 *
 * Plus the two shapes that are easy to get wrong and impossible to notice: one
 * key used by TWO harnesses (the "+N" rollup), and one key whose observed
 * harness contradicts its configured application (the mismatch badge).
 */

import { Database } from "bun:sqlite";
import {
	AuthRepository,
	BunSqlAdapter,
	CLIENT_CATALOGUE_BACKFILL_MARKER,
	runMigrations,
} from "@clankermux/database";
// Deep import rather than the `@clankermux/http-api` barrel, which pulls in the
// whole server surface and starts timers — the process would then never exit on
// its own after seeding. Same reasoning as scripts/readme-media/seed-mock-db.ts.
import { scryptPasswordHasher } from "../../packages/http-api/src/services/session-auth-service";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How much history the 7d default range has to draw. */
const HISTORY_MS = 7 * DAY_MS;

/** Total request rows spread over {@link HISTORY_MS}. */
const REQUEST_COUNT = 400;

/**
 * The management password the QA instance runs behind.
 *
 * Not a secret: it guards a throwaway database of invented traffic. It is set
 * at all because a deployment with no password renders a red "Management API
 * unprotected" notice in the sidebar, which would sit over every screenshot.
 */
const QA_PASSWORD = "qa-client-analytics";

const CLAUDE_CODE_UA = "claude-cli/2.1.270 (external, cli)";
const CODEX_UA = "codex_cli_rs/0.104.0";
const OPENCODE_UA = "opencode/0.4.2";

const MODELS = ["claude-opus-4-8", "claude-sonnet-5", "gpt-5-codex"] as const;

/**
 * How one key's requests are generated.
 *
 * `harnessMix` is the whole point of the fixture: each entry is a share of the
 * key's requests and the exact (user-agent, harness, session key) triple those
 * rows carry, so every label path below is produced by data rather than by a
 * special case in the tab.
 */
interface KeySpec {
	id: string;
	name: string;
	/** The configured application written to client_profiles. */
	application: string;
	/** Share of REQUEST_COUNT this key generates. */
	share: number;
	/** Cache behaviour, as multiples of the uncached input tokens. */
	cacheReadFactor: number;
	cacheCreationFactor: number;
	/** Share of this key's rows written with a NULL cost. */
	unpricedShare: number;
	harnessMix: Array<{
		share: number;
		userAgent: string | null;
		harness: string | null;
		/** A Claude Code session key, which is the second inference tier. */
		session: boolean;
	}>;
}

const KEYS: KeySpec[] = [
	// Observed claude-code, with a slice of older rows that predate the capture
	// and fall back to session identity: a MIXED group, which must still be
	// marked inferred.
	{
		id: "qa-key-laptop",
		name: "laptop",
		application: "claude-code",
		share: 0.3,
		cacheReadFactor: 6,
		cacheCreationFactor: 0.4,
		unpricedShare: 0,
		harnessMix: [
			{
				share: 0.75,
				userAgent: CLAUDE_CODE_UA,
				harness: "claude-code",
				session: true,
			},
			{ share: 0.25, userAgent: null, harness: null, session: true },
		],
	},
	// The declared/detected mismatch, and the cache-churn case: it writes cache
	// entries it almost never reads back, which is exactly what the churn column
	// exists to surface.
	{
		id: "qa-key-batch",
		name: "batch-runner",
		application: "claude-code",
		share: 0.2,
		cacheReadFactor: 0.05,
		cacheCreationFactor: 3,
		unpricedShare: 0,
		harnessMix: [
			{ share: 1, userAgent: CODEX_UA, harness: "codex", session: false },
		],
	},
	// Nothing observed and no session: resolved purely from the configured
	// application. Its models are the ones most likely to lack pricing, so it
	// also carries the unpriced rows.
	{
		id: "qa-key-codex",
		name: "codex-cli",
		application: "codex",
		share: 0.2,
		cacheReadFactor: 2,
		cacheCreationFactor: 0.8,
		unpricedShare: 0.4,
		harnessMix: [
			{ share: 1, userAgent: null, harness: null, session: false },
		],
	},
	// One key, two observed harnesses — the "+N" rollup.
	{
		id: "qa-key-shared",
		name: "shared-workstation",
		application: "opencode",
		share: 0.2,
		cacheReadFactor: 3,
		cacheCreationFactor: 0.6,
		unpricedShare: 0,
		harnessMix: [
			{
				share: 0.7,
				userAgent: OPENCODE_UA,
				harness: "opencode",
				session: false,
			},
			{
				share: 0.3,
				userAgent: CLAUDE_CODE_UA,
				harness: "claude-code",
				session: false,
			},
		],
	},
	// A generic profile declares nothing, so these rows stay Unknown. Without
	// this key the tab never renders its unknown state.
	{
		id: "qa-key-misc",
		name: "misc-scripts",
		application: "generic",
		share: 0.1,
		cacheReadFactor: 0.5,
		cacheCreationFactor: 0.2,
		unpricedShare: 0.5,
		harnessMix: [
			{ share: 1, userAgent: null, harness: null, session: false },
		],
	},
];

interface Args {
	dbPath: string;
	seed: number;
	now: number;
}

function parseArgs(argv: string[]): Args {
	let dbPath = "";
	let seed = 7;
	let now = Date.now();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--db") dbPath = argv[++i] ?? "";
		else if (arg === "--seed") seed = Number(argv[++i]);
		else if (arg === "--now") now = Number(argv[++i]);
	}
	if (!dbPath) throw new Error("--db <path> is required");
	if (!Number.isFinite(seed) || !Number.isFinite(now)) {
		throw new Error("--seed and --now must be numbers");
	}
	return { dbPath, seed, now };
}

/** mulberry32 — deterministic so two QA runs describe the same traffic. */
function makeRng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** The empty per-format catalogue shape the client repository parses back. */
const EMPTY_CATALOGUES = JSON.stringify({
	anthropic: { models: [], defaultModel: null },
	openai: { models: [], defaultModel: null },
	codex: { models: [], defaultModel: null },
});

function seedKeys(db: Database, now: number): void {
	const insertKey = db.prepare(`
		INSERT INTO api_keys (
			id, name, hashed_key, prefix_last_8, created_at, last_used, usage_count,
			is_active, pinned_account_id, pinned_providers
		) VALUES (?, ?, ?, ?, ?, ?, 0, 1, NULL, NULL)
	`);
	const insertProfile = db.prepare(`
		INSERT INTO client_profiles (api_key_id, application, revision, catalogues, notices)
		VALUES (?, ?, 1, ?, '[]')
	`);
	for (const key of KEYS) {
		insertKey.run(
			key.id,
			key.name,
			`sha256$${key.id}-not-a-real-hash`,
			key.id.slice(-8),
			now - 30 * DAY_MS,
			now - HOUR_MS,
		);
		insertProfile.run(key.id, key.application, EMPTY_CATALOGUES);
	}
	// The marker says "the catalogue backfill already happened". Without it
	// ClientRepository.bootstrap() runs at boot and inserts one profile per API
	// key, colliding with the rows above on the primary key and taking the QA
	// instance down before it serves anything.
	db.prepare(
		"INSERT INTO strategies (name, config, updated_at) VALUES (?, ?, ?)",
	).run(CLIENT_CATALOGUE_BACKFILL_MARKER, "{}", now);
}

/** Pick the harness variant whose cumulative share covers `roll`. */
function pickVariant(key: KeySpec, roll: number): KeySpec["harnessMix"][number] {
	let cumulative = 0;
	for (const variant of key.harnessMix) {
		cumulative += variant.share;
		if (roll < cumulative) return variant;
	}
	return key.harnessMix[key.harnessMix.length - 1];
}

function seedRequests(db: Database, now: number, rng: () => number): number {
	const insert = db.prepare(`
		INSERT INTO requests (
			id, timestamp, method, path, account_used, status_code, success,
			error_message, response_time_ms, failover_attempts, model, requested_model,
			total_tokens, cost_usd, cost_source, input_tokens, cache_read_input_tokens,
			cache_creation_input_tokens, output_tokens, billing_type, api_key_id,
			api_key_name, client_user_agent, client_harness, session_key,
			context_system_chars, context_tools_chars, context_tool_count,
			context_messages_chars, context_message_count
		) VALUES (?, ?, 'POST', '/v1/messages', NULL, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?,
			?, ?, ?, 'plan', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);

	let written = 0;
	const write = db.transaction(() => {
		for (const key of KEYS) {
			const count = Math.round(REQUEST_COUNT * key.share);
			for (let i = 0; i < count; i++) {
				const variant = pickVariant(key, rng());
				const model = MODELS[Math.floor(rng() * MODELS.length)];
				const timestamp = now - Math.floor(rng() * HISTORY_MS);
				const inputTokens = 400 + Math.floor(rng() * 1600);
				const cacheReadTokens = Math.round(
					inputTokens * key.cacheReadFactor * (0.7 + rng() * 0.6),
				);
				const cacheCreationTokens = Math.round(
					inputTokens * key.cacheCreationFactor * (0.7 + rng() * 0.6),
				);
				const outputTokens = 80 + Math.floor(rng() * 500);
				const success = rng() > 0.05;
				const unpriced = rng() < key.unpricedShare;
				const costUsd = unpriced
					? null
					: Number(
							(
								(inputTokens * 3 +
									cacheReadTokens * 0.3 +
									cacheCreationTokens * 3.75 +
									outputTokens * 15) /
								1_000_000
							).toFixed(6),
						);
				// Context columns on most rows but not all, so the tab's covered-only
				// denominator is exercised rather than assumed to be every row.
				const covered = rng() > 0.15;
				written++;
				insert.run(
					`qa-${key.id}-${i}`,
					timestamp,
					success ? 200 : 429,
					success ? 1 : 0,
					success ? null : "rate_limited",
					300 + Math.floor(rng() * 4000),
					model,
					model,
					inputTokens + cacheReadTokens + cacheCreationTokens + outputTokens,
					costUsd,
					unpriced ? null : "estimated",
					inputTokens,
					cacheReadTokens,
					cacheCreationTokens,
					outputTokens,
					key.id,
					key.name,
					variant.userAgent,
					variant.harness,
					variant.session ? `${key.id}:session-${i % 7}` : null,
					covered ? 1200 + Math.floor(rng() * 2000) : null,
					covered ? 4000 + Math.floor(rng() * 9000) : null,
					covered ? 8 + Math.floor(rng() * 20) : null,
					covered ? 10_000 + Math.floor(rng() * 60_000) : null,
					covered ? 4 + Math.floor(rng() * 40) : null,
				);
			}
		}
	});
	write();

	db.run(`
		UPDATE api_keys SET
			usage_count = (SELECT COUNT(*) FROM requests WHERE api_key_id = api_keys.id),
			last_used   = (SELECT MAX(timestamp) FROM requests WHERE api_key_id = api_keys.id)
	`);
	return written;
}

async function main(): Promise<void> {
	const { dbPath, seed, now } = parseArgs(process.argv.slice(2));
	const rng = makeRng(seed);

	const db = new Database(dbPath, { create: true });
	db.run("PRAGMA journal_mode = WAL");
	runMigrations(db);

	seedKeys(db, now);
	const requests = seedRequests(db, now, rng);

	const auth = new AuthRepository(new BunSqlAdapter(db));
	const { verifier, params } = await scryptPasswordHasher.hash(QA_PASSWORD);
	await auth.setPassword(verifier, params, now);

	const harnesses = db
		.query<{ label: string; rows: number }, []>(
			`SELECT COALESCE(client_harness, '(none observed)') AS label, COUNT(*) AS rows
			 FROM requests GROUP BY 1 ORDER BY rows DESC`,
		)
		.all();
	db.close();

	console.log(
		`seeded ${dbPath}: ${KEYS.length} keys, ${requests} requests over 7 days`,
	);
	for (const row of harnesses) {
		console.log(`  observed harness ${row.label}: ${row.rows}`);
	}
	console.log(`management password: ${QA_PASSWORD}`);
}

await main();
