/**
 * Builds the throwaway database the README screenshots are captured from.
 *
 * The instance that serves those captures is a REAL ClankerMux — real handlers,
 * real aggregation, real dashboard bundle — pointed at this synthetic database
 * instead of anyone's live one. Everything here is invented (see
 * `./mock-data.ts`); nothing reads the user's config directory or real DB.
 *
 * Usage:
 *   bun scripts/readme-media/seed-mock-db.ts --db /tmp/…/mock.db [--seed 20260901]
 */

import { Database } from "bun:sqlite";
import {
	AuthRepository,
	BunSqlAdapter,
	runMigrations,
} from "@clankermux/database";
// Deep import rather than the `@clankermux/http-api` barrel. The barrel pulls
// in the whole server surface, which starts timers: the import itself is fast,
// but the process then never exits on its own, so a seeding run appears to hang
// after it has already done all its work. This module is self-contained
// (node:crypto plus database types) and is the single definition of the stored
// verifier format, so reaching for it directly also beats re-implementing the
// hash here and letting the two drift. tsconfig.json typechecks this file, so a
// move or rename on the other side fails loudly rather than at capture time.
import { scryptPasswordHasher } from "../../packages/http-api/src/services/session-auth-service";
import {
	MOCK_ACCOUNTS,
	MOCK_API_KEYS,
	MOCK_COMBOS,
	MOCK_PROJECTS,
	makeRng,
} from "./mock-data";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How much history the figures show. The charts default to shorter ranges. */
const HISTORY_MS = 7 * DAY_MS;

/** Cadence of the synthetic usage series behind the sawtooth chart. */
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Total requests spread over {@link HISTORY_MS}. Sized so the densest default
 * view still has a curve to draw: the Analytics traffic tab opens on a 1-hour
 * range, which at a few hundred requests per week is a handful of lonely
 * spikes.
 */
const REQUEST_COUNT = 26000;

/**
 * Per-model rates in USD per million tokens, used only to make the cost column
 * internally consistent with the token columns. These are invented alongside
 * everything else; the real catalogue is fetched at runtime and is not
 * available to a network-isolated capture instance.
 */
const RATES: Record<string, { in: number; out: number; cacheRead: number }> = {
	"claude-opus-5": { in: 15, out: 75, cacheRead: 1.5 },
	"claude-sonnet-5": { in: 3, out: 15, cacheRead: 0.3 },
	"claude-haiku-4.5": { in: 1, out: 5, cacheRead: 0.1 },
	"claude-fable-5": { in: 0.8, out: 4, cacheRead: 0.08 },
	"gpt-5.6-sol": { in: 2.5, out: 10, cacheRead: 0.25 },
	"gpt-5.4-mini": { in: 0.4, out: 1.6, cacheRead: 0.04 },
	"glm-4.6": { in: 0.6, out: 2.2, cacheRead: 0.06 },
};

/** Weights for which project a request is attributed to. */
const PROJECT_WEIGHTS = [0.34, 0.27, 0.18, 0.13, 0.08];

interface Args {
	dbPath: string;
	seed: number;
	now: number;
}

function parseArgs(argv: string[]): Args {
	let dbPath = "";
	let seed = 20260901;
	let now = Date.now();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--db") dbPath = argv[++i] ?? "";
		else if (arg === "--seed") seed = Number(argv[++i]);
		else if (arg === "--now") now = Number(argv[++i]);
	}
	if (!dbPath) {
		throw new Error("--db <path> is required");
	}
	if (!Number.isFinite(seed) || !Number.isFinite(now)) {
		throw new Error("--seed and --now must be numbers");
	}
	return { dbPath, seed, now };
}

/** Pick an index from a weight vector. Weights need not sum to exactly 1. */
function pickWeighted(rng: () => number, weights: readonly number[]): number {
	const total = weights.reduce((a, b) => a + b, 0);
	let r = rng() * total;
	for (let i = 0; i < weights.length; i++) {
		r -= weights[i];
		if (r <= 0) return i;
	}
	return weights.length - 1;
}

/**
 * Relative traffic intensity at a moment, so the request series has a shape a
 * reader recognizes — busy on weekday afternoons, near-idle overnight — rather
 * than the flat noise a uniform sample produces.
 */
function diurnalWeight(ts: number): number {
	const d = new Date(ts);
	const hour = d.getUTCHours();
	const day = d.getUTCDay();
	const weekend = day === 0 || day === 6;
	// Peak late morning through early evening UTC.
	const shape = Math.exp(-((hour - 14) ** 2) / 26);
	return (weekend ? 0.35 : 1) * (0.08 + shape);
}

function seedAccounts(db: Database, now: number): void {
	const insert = db.prepare(`
		INSERT INTO accounts (
			id, name, provider, api_key, refresh_token, access_token, expires_at,
			created_at, last_used, request_count, total_requests, priority,
			paused, auto_refresh_enabled, auto_fallback_enabled,
			billing_type, identity_email, identity_organization_name,
			identity_plan_tier, identity_captured_at, refresh_token_issued_at,
			renewal_anchor, renewal_cadence, renewal_price_usd_micros
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	for (const account of MOCK_ACCOUNTS) {
		const oauth = account.provider === "anthropic" || account.provider === "codex";
		insert.run(
			account.id,
			account.name,
			account.provider,
			oauth ? null : `mock-key-${account.id}`,
			oauth ? `mock-refresh-${account.id}` : null,
			oauth ? `mock-access-${account.id}` : null,
			// Far-future expiry: the capture instance must never attempt a token
			// refresh, which is a network call to a real provider.
			oauth ? now + 90 * DAY_MS : null,
			now - 120 * DAY_MS,
			now - 4 * 60 * 1000,
			0,
			0,
			account.priority,
			account.paused ? 1 : 0,
			// Auto-refresh OFF for the same reason as the expiry above.
			0,
			0,
			// `plan` / `api` / `overage` are the only values the app writes or
			// reads. Anything else counts as token-billed in the spend split
			// (payments-summary-direct.ts: COALESCE(billing_type,'api') != 'plan'),
			// so a plausible-looking "subscription" would silently move a
			// subscription account's whole cost into the token column.
			oauth ? "plan" : "api",
			account.email,
			account.organization,
			account.planTier,
			account.planTier ? now - 30 * DAY_MS : null,
			// Refresh-token health is derived from this timestamp against a 90-day
			// ceiling, falling back to created_at. Left unset, a 120-day-old
			// created_at reads as an expired refresh token and every OAuth card
			// wears a red "Token expired" chip.
			oauth ? now - 3 * DAY_MS : null,
			// Subscription renewal, which is what the amortized-cost figures divide
			// the ledger by. Anchored a few days out so the renewal chip reads as
			// upcoming rather than overdue.
			account.monthlyUsd == null
				? null
				: new Date(now + 5 * DAY_MS).toISOString().slice(0, 10),
			account.monthlyUsd == null ? null : "monthly",
			account.monthlyUsd == null ? null : account.monthlyUsd * 1_000_000,
		);
	}
}

function seedApiKeys(db: Database, now: number): void {
	const insert = db.prepare(`
		INSERT INTO api_keys (id, name, hashed_key, prefix_last_8, created_at, last_used, usage_count, is_active)
		VALUES (?, ?, ?, ?, ?, ?, ?, 1)
	`);
	for (const key of MOCK_API_KEYS) {
		insert.run(
			key.id,
			key.name,
			`sha256$${key.id}-not-a-real-hash`,
			key.last8,
			now - 60 * DAY_MS,
			now - 6 * 60 * 1000,
			0,
		);
	}
}

function seedCombos(db: Database, now: number): void {
	const insertCombo = db.prepare(`
		INSERT INTO combos (id, name, description, enabled, created_at, updated_at)
		VALUES (?, ?, ?, 1, ?, ?)
	`);
	const insertSlot = db.prepare(`
		INSERT INTO combo_slots (id, combo_id, account_id, model, priority, enabled)
		VALUES (?, ?, ?, ?, ?, 1)
	`);
	for (const combo of MOCK_COMBOS) {
		insertCombo.run(combo.id, combo.name, combo.description, now - 40 * DAY_MS, now - 3 * DAY_MS);
	}
	const slots: Array<[string, string, string, number]> = [
		["combo-frontline", "acct-aurora", "claude-opus-5", 0],
		["combo-frontline", "acct-borealis", "claude-sonnet-5", 1],
		["combo-frontline", "acct-dune", "glm-4.6", 2],
		["combo-bulk", "acct-borealis", "claude-haiku-4.5", 0],
		["combo-bulk", "acct-cinder", "gpt-5.4-mini", 1],
	];
	slots.forEach(([comboId, accountId, model, priority], i) => {
		insertSlot.run(`slot-${i}`, comboId, accountId, model, priority);
	});
	db.run(
		`UPDATE combo_family_assignments SET combo_id = 'combo-frontline', enabled = 1 WHERE family IN ('opus','sonnet')`,
	);
}

function seedPayments(db: Database, now: number): void {
	const insert = db.prepare(`
		INSERT INTO account_payments (
			id, account_id, account_name, kind, paid_date, paid_at_ms,
			amount_usd_micros, recorded_at, source
		) VALUES (?, ?, ?, 'subscription', ?, ?, ?, ?, 'manual')
	`);
	let n = 0;
	for (const account of MOCK_ACCOUNTS) {
		if (account.monthlyUsd == null) continue;
		// Three months of subscription history each, so the value-per-dollar
		// figures on Overview and Limits have something to divide by. Stepped by
		// CALENDAR month, not by 30 days: subtracting 30 days from the 31st lands
		// in the same calendar month, and "Spend this month" would then count one
		// account's subscription twice.
		for (let monthsAgo = 0; monthsAgo < 3; monthsAgo++) {
			const due = new Date(now);
			// Clamp the day first, so stepping back from e.g. the 31st cannot
			// overflow a short month into the one after it.
			due.setUTCDate(Math.min(due.getUTCDate(), 28));
			due.setUTCMonth(due.getUTCMonth() - monthsAgo);
			const paidAt = due.getTime();
			const date = due.toISOString().slice(0, 10);
			insert.run(
				`payment-${n++}`,
				account.id,
				account.name,
				date,
				paidAt,
				account.monthlyUsd * 1_000_000,
				paidAt,
			);
		}
	}
}

/**
 * The 5-hour and weekly utilization series behind the Limits sawtooth. The 5h
 * window is generated as a real sawtooth (climb, reset, climb) rather than
 * noise, because the reset discontinuity is the whole point of that chart.
 */
function seedUsageSnapshots(db: Database, now: number, rng: () => number): void {
	const insert = db.prepare(`
		INSERT OR REPLACE INTO usage_snapshots (
			account_id, provider, sampled_at, five_hour_pct, five_hour_reset,
			seven_day_pct, seven_day_reset, observed_at, plan_tier
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	const scoped = db.prepare(`
		INSERT OR REPLACE INTO usage_scoped_snapshots (
			account_id, sampled_at, family, display_name, pct, reset_at
		) VALUES (?, ?, ?, ?, ?, ?)
	`);

	// Weekly windows all reset at the same wall-clock moment, a few days out.
	const weeklyReset = now + 3 * DAY_MS + 7 * HOUR_MS;
	const weeklyStart = weeklyReset - 7 * DAY_MS;

	const insertAll = db.transaction(() => {
		for (const account of MOCK_ACCOUNTS) {
			if (account.fiveHourPct == null || account.sevenDayPct == null) continue;
			const finalFive = account.fiveHourPct * 100;
			const finalSeven = account.sevenDayPct * 100;

			// Anchor the 5h sawtooth so the LAST sample lands on the account's
			// stated utilization: the screenshot and the chart must agree.
			const currentWindowStart =
				now - account.fiveHourPct * 5 * HOUR_MS;

			// Per-window peak, so consecutive windows are not identical copies.
			const windowPeak = (index: number) =>
				45 + ((Math.sin(index * 2.399) + 1) / 2) * 50;

			let previousFive = 0;
			for (let ts = now - HISTORY_MS; ts <= now; ts += SNAPSHOT_INTERVAL_MS) {
				// Which 5-hour window this sample falls in, and how far into it. The
				// reset instant is that window's OWN end, not a single value reused
				// for the whole week: a sample from six days ago claiming a reset
				// three days from now describes a window no five-hour window can
				// have, and the prediction code reads reset boundaries as lifecycle
				// events.
				const windowIndex = Math.floor(
					(ts - currentWindowStart) / (5 * HOUR_MS),
				);
				const windowStart = currentWindowStart + windowIndex * 5 * HOUR_MS;
				const fiveHourReset = windowStart + 5 * HOUR_MS;
				const phase = (ts - windowStart) / (5 * HOUR_MS);

				// Utilization only ever climbs inside a window and drops to near
				// zero at the boundary — that discontinuity is what the sawtooth
				// chart is for. Consumption is diurnally weighted, but as an
				// increment: scaling the LEVEL by a wandering factor would make the
				// series fall inside a window, which reads as a reset that did not
				// happen.
				const startOfWindow = phase < SNAPSHOT_INTERVAL_MS / (5 * HOUR_MS);
				if (startOfWindow) previousFive = rng() * 3;
				const climb =
					(SNAPSHOT_INTERVAL_MS / (5 * HOUR_MS)) *
					windowPeak(windowIndex) *
					diurnalWeight(ts) *
					(0.6 + rng() * 0.9);
				previousFive = Math.min(99, previousFive + climb);

				// Same treatment for the weekly window. HISTORY_MS is seven days and
				// the current weekly window opened four days ago, so the oldest
				// samples belong to the PREVIOUS week and must carry that week's
				// reset, not this one's.
				const weekIndex = Math.floor((ts - weeklyStart) / (7 * DAY_MS));
				const weekStart = weeklyStart + weekIndex * 7 * DAY_MS;
				const weekPhase = (ts - weekStart) / (7 * DAY_MS);
				const sevenPct = Math.min(
					99,
					// The previous week ran hotter, so the series does not look like
					// one ramp cut in half.
					(weekIndex === 0 ? finalSeven : finalSeven * 1.25) * weekPhase,
				);

				const isLast = ts + SNAPSHOT_INTERVAL_MS > now;
				insert.run(
					account.id,
					account.provider,
					ts,
					isLast ? finalFive : Number(previousFive.toFixed(2)),
					fiveHourReset,
					isLast ? finalSeven : Number(sevenPct.toFixed(2)),
					weekStart + 7 * DAY_MS,
					ts,
					account.planTier,
				);
			}

			// Per-family weekly windows, the axis the account-wide series cannot
			// show. Only the Anthropic accounts have these.
			if (account.provider !== "anthropic") continue;
			const families: Array<[string, string, number]> = account.id === "acct-aurora"
				? [
						["opus", "Claude Opus 5", finalSeven * 1.12],
						["sonnet", "Claude Sonnet 5", finalSeven * 0.58],
					]
				: [
						["sonnet", "Claude Sonnet 5", finalSeven * 0.81],
						["fable", "Claude Fable 5", finalSeven * 0.36],
					];
			for (let ts = now - HISTORY_MS; ts <= now; ts += SNAPSHOT_INTERVAL_MS * 6) {
				// Per-sample weekly window, for the reason given above.
				const weekIndex = Math.floor((ts - weeklyStart) / (7 * DAY_MS));
				const weekStart = weeklyStart + weekIndex * 7 * DAY_MS;
				const weekPhase = (ts - weekStart) / (7 * DAY_MS);
				const scopedReset = weekStart + 7 * DAY_MS;
				for (const [family, displayName, target] of families) {
					scoped.run(
						account.id,
						ts,
						family,
						displayName,
						Number(Math.min(99, target * weekPhase).toFixed(2)),
						scopedReset,
					);
				}
			}
		}
	});
	insertAll();
}

function seedRequests(db: Database, now: number, rng: () => number): void {
	const insertRequest = db.prepare(`
		INSERT INTO requests (
			id, timestamp, method, path, account_used, status_code, success,
			error_message, response_time_ms, failover_attempts, model, requested_model,
			prompt_tokens, completion_tokens, total_tokens, cost_usd,
			output_tokens_per_second, input_tokens, cache_read_input_tokens,
			cache_creation_input_tokens, output_tokens, project,
			project_attribution_source, billing_type, api_key_id, api_key_name,
			usage_finalized_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	const insertRouting = db.prepare(`
		INSERT INTO request_routing (
			request_id, strategy, decision, affinity_scope, affinity_key_hash,
			selected_account_id, previous_account_id, candidates_count,
			failover_attempts, failover_reason, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);

	const accountWeights = MOCK_ACCOUNTS.map((a) => a.share);
	const activeAccounts = MOCK_ACCOUNTS.filter((a) => !a.paused);

	// A handful of long-lived client sessions, so the active-sessions panel has
	// overlapping bands instead of one line per request.
	const sessions = Array.from({ length: 18 }, (_, i) => ({
		hash: `sess${(i + 1).toString(16).padStart(2, "0")}${"0".repeat(24)}`,
		scope: i % 3 === 0 ? "codex_thread" : i % 5 === 0 ? "project" : "claude_session",
		startedAt: now - HISTORY_MS + rng() * HISTORY_MS,
	}));

	// Rejection-sample the timestamps against the diurnal shape so the density
	// follows the curve rather than being uniform. At REQUEST_COUNT the busy-hour
	// rate is high enough that the last five minutes — all the Overview Live
	// Activity panel plots — fill up on their own. An extra synthetic burst there
	// would only show up on the Analytics traffic chart as a cliff at the
	// right-hand edge, which reads as a data artefact because it is one.
	const timestamps: number[] = [];
	for (let i = 0; i < REQUEST_COUNT; i++) {
		let ts = now - rng() * HISTORY_MS;
		for (let attempt = 0; attempt < 24; attempt++) {
			const candidate = now - rng() * HISTORY_MS;
			if (rng() < diurnalWeight(candidate)) {
				ts = candidate;
				break;
			}
			ts = candidate;
		}
		timestamps.push(ts);
	}
	timestamps.sort((a, b) => a - b);

	const insertAll = db.transaction(() => {
		for (let i = 0; i < timestamps.length; i++) {
			const ts = timestamps[i];

			const accountIdx = pickWeighted(rng, accountWeights);
			const account = MOCK_ACCOUNTS[accountIdx].paused
				? activeAccounts[Math.floor(rng() * activeAccounts.length)]
				: MOCK_ACCOUNTS[accountIdx];
			const model = account.models[Math.floor(rng() * account.models.length)];
			const rate = RATES[model] ?? RATES["glm-4.6"];

			const inputTokens = Math.round(400 + rng() * 3600);
			const cacheRead = Math.round(rng() < 0.78 ? 8000 + rng() * 110000 : 0);
			const cacheCreation = Math.round(rng() < 0.3 ? 500 + rng() * 7000 : 0);
			const outputTokens = Math.round(80 + rng() * 2600);
			const promptTokens = inputTokens + cacheRead + cacheCreation;
			const totalTokens = promptTokens + outputTokens;
			const costUsd =
				(inputTokens * rate.in +
					cacheCreation * rate.in * 1.25 +
					cacheRead * rate.cacheRead +
					outputTokens * rate.out) /
				1_000_000;

			const roll = rng();
			const rateLimited = roll > 0.985;
			const failed = !rateLimited && roll > 0.972;
			const statusCode = rateLimited ? 429 : failed ? 500 : 200;
			const success = statusCode === 200;
			const responseMs = Math.round(
				success ? 1200 + rng() * 26000 : 300 + rng() * 2500,
			);
			const tps = success ? Number((outputTokens / (responseMs / 1000)).toFixed(2)) : null;

			const project = MOCK_PROJECTS[pickWeighted(rng, PROJECT_WEIGHTS)];
			const apiKey = MOCK_API_KEYS[Math.floor(rng() * MOCK_API_KEYS.length)];
			const failoverAttempts = rng() > 0.94 ? 1 : 0;

			const id = `req-${i.toString().padStart(5, "0")}`;
			insertRequest.run(
				id,
				Math.round(ts),
				"POST",
				"/v1/messages",
				account.id,
				statusCode,
				success ? 1 : 0,
				rateLimited
					? "rate_limit_error: 5-hour limit reached"
					: failed
						? "api_error: upstream returned 500"
						: null,
				responseMs,
				failoverAttempts,
				success ? model : null,
				model,
				success ? promptTokens : 0,
				success ? outputTokens : 0,
				success ? totalTokens : 0,
				success ? Number(costUsd.toFixed(6)) : 0,
				tps,
				success ? inputTokens : 0,
				success ? cacheRead : 0,
				success ? cacheCreation : 0,
				success ? outputTokens : 0,
				project,
				"cwd_root",
				// Same three-value vocabulary as the account column above: traffic
				// on a subscription account is `plan` value, not token spend.
				account.provider === "openrouter" || account.provider === "ollama"
					? "api"
					: "plan",
				apiKey.id,
				apiKey.name,
				success ? Math.round(ts) : null,
			);

			// Attach the request to whichever synthetic session was already
			// running at that moment; sessions the timestamp precedes are skipped.
			const candidates = sessions.filter((s) => s.startedAt <= ts);
			const session = candidates.length
				? candidates[Math.floor(rng() * candidates.length)]
				: null;
			insertRouting.run(
				id,
				"session",
				failoverAttempts > 0 ? "failover" : "selected",
				session ? session.scope : null,
				session ? session.hash : null,
				account.id,
				failoverAttempts > 0 ? MOCK_ACCOUNTS[0].id : null,
				activeAccounts.length,
				failoverAttempts,
				failoverAttempts > 0 ? "rate_limited" : null,
				Math.round(ts - responseMs),
			);
		}
	});
	insertAll();

	// Denormalized counters the account cards read directly.
	db.run(`
		UPDATE accounts SET
			total_requests = (SELECT COUNT(*) FROM requests WHERE account_used = accounts.id),
			request_count  = (SELECT COUNT(*) FROM requests WHERE account_used = accounts.id),
			last_used      = (SELECT MAX(timestamp) FROM requests WHERE account_used = accounts.id)
	`);
	db.run(`
		UPDATE api_keys SET
			usage_count = (SELECT COUNT(*) FROM requests WHERE api_key_id = api_keys.id),
			last_used   = (SELECT MAX(timestamp) FROM requests WHERE api_key_id = api_keys.id)
	`);
}

/**
 * The management password the capture instance runs behind.
 *
 * Not a secret: it guards a throwaway database of invented accounts that lives
 * for the length of one capture run inside a network namespace. It is set at
 * all because a deployment with NO password renders a red "Management API
 * unprotected" notice in the sidebar of every page, which would appear in all
 * eight screenshots and describe the capture rig rather than the product.
 */
export const CAPTURE_PASSWORD = "readme-capture-only";

async function main(): Promise<void> {
	const { dbPath, seed, now } = parseArgs(process.argv.slice(2));
	const rng = makeRng(seed);

	const db = new Database(dbPath, { create: true });
	db.run("PRAGMA journal_mode = WAL");
	runMigrations(db);

	seedAccounts(db, now);
	seedApiKeys(db, now);
	seedCombos(db, now);
	seedPayments(db, now);
	seedUsageSnapshots(db, now, rng);
	seedRequests(db, now, rng);

	const auth = new AuthRepository(new BunSqlAdapter(db));
	const { verifier, params } = await scryptPasswordHasher.hash(CAPTURE_PASSWORD);
	await auth.setPassword(verifier, params, now);

	const counts = db
		.query<{ requests: number; snapshots: number; scoped: number }, []>(
			`SELECT
				(SELECT COUNT(*) FROM requests) AS requests,
				(SELECT COUNT(*) FROM usage_snapshots) AS snapshots,
				(SELECT COUNT(*) FROM usage_scoped_snapshots) AS scoped`,
		)
		.get();
	db.close();

	console.log(
		`seeded ${dbPath}: ${MOCK_ACCOUNTS.length} accounts, ${counts?.requests ?? 0} requests, ` +
			`${counts?.snapshots ?? 0} usage snapshots, ${counts?.scoped ?? 0} scoped snapshots`,
	);
}

await main();
