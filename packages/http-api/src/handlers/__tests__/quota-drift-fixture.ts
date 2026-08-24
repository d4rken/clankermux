/**
 * Deterministic quota-drift dataset: usage snapshots plus the request traffic
 * that produced them.
 *
 * Deliberately NOT named *.test.ts so bun's runner doesn't pick it up.
 *
 * Every timestamp is an ABSOLUTE constant anchored to FIXTURE_NOW, and the
 * percentages are generated FORWARD from the request stream (`pct` accumulates
 * `w · eqTokens / 1e6` and resets on the 5h boundary), so the dataset has a
 * known generating model rather than being a plausible-looking table. That is
 * what lets a test compare the compute path's segments against the core builder
 * run on the same samples and get an exact match.
 *
 * Two details exist to catch specific mistakes:
 *
 *  - `observed_at` is deliberately OFFSET from `sampled_at` by an alternating
 *    lag. A compute path that placed segment boundaries on `sampled_at` would
 *    still look sane, and would still fit — it would just be silently wrong by
 *    the cache age. The offset makes the choice observable.
 *  - the reported 5h reset carries a sub-second jitter, as the live database
 *    does. A run-splitting rule that tested `resetAt !== prevResetAt` instead of
 *    the 60s tolerance would shred every run here.
 */
import type { Database } from "bun:sqlite";
import type { QuotaWindowKind, WindowSample } from "@clankermux/core";

/** Frozen wall clock for the fixture. 2026-03-15T12:00:00.000Z. */
export const FIXTURE_NOW = Date.UTC(2026, 2, 15, 12, 0, 0, 0);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FIVE_HOUR_MS = 5 * HOUR;

/** Sampler cadence the fixture imitates. */
const SAMPLE_STEP_MS = 2 * MINUTE;
/** History depth. */
const SPAN_MS = 3 * DAY;

export const ACCOUNT_MAX_A = "qd-acct-max-a";
export const ACCOUNT_MAX_B = "qd-acct-max-b";
export const ACCOUNT_CODEX = "qd-acct-codex";
/** Anthropic account whose snapshots recorded NO tier — the `assumed` case. */
export const ACCOUNT_ASSUMED = "qd-acct-assumed";
/** Present in `accounts`, with ZERO snapshots. Must be absent from the payload. */
export const ACCOUNT_NO_SNAPSHOTS = "qd-acct-silent";

/** Cohort keys the fixture is expected to produce. */
export const COHORT_MAX = "anthropic|max|20x";
export const COHORT_ASSUMED = "anthropic|pro|";
export const COHORT_CODEX = "codex|pro|";

export interface FixtureSample {
	sampledAt: number;
	observedAt: number | null;
	fiveHourPct: number | null;
	fiveHourReset: number | null;
	sevenDayPct: number | null;
	sevenDayReset: number | null;
	planTier: string | null;
	rateLimitTier: string | null;
}

export interface FixtureRequest {
	id: string;
	timestamp: number;
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
}

export interface FixtureAccount {
	id: string;
	provider: string;
	/** Today's value on the accounts row — the `assumed` fallback. */
	identityPlanTier: string | null;
	identityRateLimitTier: string | null;
	/** Tier written onto each snapshot row, or null to force the fallback. */
	samplePlanTier: string | null;
	sampleRateLimitTier: string | null;
	samples: FixtureSample[];
	requests: FixtureRequest[];
}

/** Deterministic PRNG so the dataset is byte-stable across runs. */
function lcg(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

/** The 5h window boundary at or after `t`, with the live sub-second jitter. */
function fiveHourResetAt(t: number, jitter: number): number {
	return Math.ceil((t + 1) / FIVE_HOUR_MS) * FIVE_HOUR_MS + jitter;
}

interface ModelSpec {
	/** Raw model id as `requests.model` holds it (dates included). */
	id: string;
	/** Points of the 5h window per 1M eq-tokens. */
	fiveHourWeight: number;
	/** Points of the 7d window per 1M eq-tokens. */
	sevenDayWeight: number;
	/** Rough eq-token scale of one request. */
	scale: number;
}

const ANTHROPIC_MODELS: ModelSpec[] = [
	{
		id: "claude-opus-5-20260101",
		fiveHourWeight: 3.2,
		sevenDayWeight: 0.19,
		scale: 90_000,
	},
	{
		id: "claude-sonnet-5",
		fiveHourWeight: 0.9,
		sevenDayWeight: 0.05,
		scale: 140_000,
	},
];

const CODEX_MODELS: ModelSpec[] = [
	{
		id: "gpt-5.6-codex-2026-02-10",
		fiveHourWeight: 2.1,
		sevenDayWeight: 0.14,
		scale: 110_000,
	},
];

/**
 * Generate one account's snapshot + request history.
 *
 * Every sample step issues one request, then reports the percentages the
 * accumulated exposure implies. The 5h percentage resets when the window rolls;
 * the 7d reset sits beyond the fixture's span, so the weekly series is one
 * uninterrupted run.
 */
function generateAccount(opts: {
	id: string;
	provider: string;
	models: ModelSpec[];
	seed: number;
	identityPlanTier: string | null;
	identityRateLimitTier: string | null;
	samplePlanTier: string | null;
	sampleRateLimitTier: string | null;
}): FixtureAccount {
	const rand = lcg(opts.seed);
	const samples: FixtureSample[] = [];
	const requests: FixtureRequest[] = [];
	const start = FIXTURE_NOW - SPAN_MS;
	const sevenDayReset = FIXTURE_NOW + 4 * DAY;

	let fivePct = 0;
	let sevenPct = 0;
	let currentWindow = Math.floor(start / FIVE_HOUR_MS);
	let seq = 0;

	for (let t = start; t <= FIXTURE_NOW; t += SAMPLE_STEP_MS) {
		const windowIndex = Math.floor(t / FIVE_HOUR_MS);
		if (windowIndex !== currentWindow) {
			currentWindow = windowIndex;
			fivePct = 0;
		}

		// One request per step, placed 30s into the interval so it can never sit
		// exactly on a boundary by accident (the boundary case is asserted
		// explicitly in the test instead).
		const model = opts.models[Math.floor(rand() * opts.models.length)];
		const magnitude = 0.4 + rand();
		const inputTokens = Math.round(model.scale * magnitude * 0.35);
		const cacheReadInputTokens = Math.round(model.scale * magnitude * 3);
		const cacheCreationInputTokens = Math.round(model.scale * magnitude * 0.2);
		const outputTokens = Math.round(model.scale * magnitude * 0.08);
		requests.push({
			id: `${opts.id}-r${seq}`,
			timestamp: t + 30_000,
			model: model.id,
			inputTokens,
			outputTokens,
			cacheReadInputTokens,
			cacheCreationInputTokens,
		});
		seq++;

		// The provider's own weighting, applied to the SAME exposure the fit will
		// reconstruct from the request rows.
		const eq =
			inputTokens +
			cacheCreationInputTokens * 1.25 +
			cacheReadInputTokens * 0.1 +
			outputTokens * 5;
		fivePct = Math.min(100, fivePct + (model.fiveHourWeight * eq) / 1e6);
		sevenPct = Math.min(100, sevenPct + (model.sevenDayWeight * eq) / 1e6);

		// The reading is observed BEFORE the tick records it: the sampler accepts
		// any cache entry younger than its freshness bound. Alternating lag keeps
		// the effective clock distinct from sampled_at without reordering.
		const lagMs = seq % 2 === 0 ? 30_000 : 45_000;
		samples.push({
			sampledAt: t + SAMPLE_STEP_MS,
			observedAt: t + SAMPLE_STEP_MS - lagMs,
			fiveHourPct: fivePct,
			fiveHourReset: fiveHourResetAt(t, (seq % 3) * 400),
			sevenDayPct: sevenPct,
			sevenDayReset: sevenDayReset,
			planTier: opts.samplePlanTier,
			rateLimitTier: opts.sampleRateLimitTier,
		});
	}

	return {
		id: opts.id,
		provider: opts.provider,
		identityPlanTier: opts.identityPlanTier,
		identityRateLimitTier: opts.identityRateLimitTier,
		samplePlanTier: opts.samplePlanTier,
		sampleRateLimitTier: opts.sampleRateLimitTier,
		samples,
		requests,
	};
}

export const FIXTURE_ACCOUNTS: FixtureAccount[] = [
	generateAccount({
		id: ACCOUNT_MAX_A,
		provider: "anthropic",
		models: ANTHROPIC_MODELS,
		seed: 11,
		identityPlanTier: "max",
		identityRateLimitTier: "20x",
		samplePlanTier: "max",
		sampleRateLimitTier: "20x",
	}),
	generateAccount({
		id: ACCOUNT_MAX_B,
		provider: "anthropic",
		models: ANTHROPIC_MODELS,
		seed: 29,
		identityPlanTier: "max",
		identityRateLimitTier: "20x",
		samplePlanTier: "max",
		sampleRateLimitTier: "20x",
	}),
	generateAccount({
		id: ACCOUNT_CODEX,
		provider: "codex",
		models: CODEX_MODELS,
		seed: 47,
		identityPlanTier: "pro",
		// Codex reports no rate-limit tier — a real null, not a gap.
		identityRateLimitTier: null,
		samplePlanTier: "pro",
		sampleRateLimitTier: null,
	}),
	generateAccount({
		id: ACCOUNT_ASSUMED,
		provider: "anthropic",
		models: ANTHROPIC_MODELS,
		seed: 83,
		identityPlanTier: "pro",
		identityRateLimitTier: null,
		// Snapshots predating the per-sample tier columns: the tier can only be
		// inferred from today's accounts row, which is the `assumed` case.
		samplePlanTier: null,
		sampleRateLimitTier: null,
	}),
];

/** Look up one generated account. */
export function fixtureAccount(id: string): FixtureAccount {
	const account = FIXTURE_ACCOUNTS.find((a) => a.id === id);
	if (!account) throw new Error(`unknown fixture account: ${id}`);
	return account;
}

/**
 * The samples for one account/window in the shape the CORE builder consumes,
 * on the same effective clock (`observedAt ?? sampledAt`) the compute path uses.
 *
 * This is the reference side of the anti-drift comparison: a test feeds these
 * to `buildSegments` directly and requires the compute path's segments to match
 * boundary for boundary.
 */
export function fixtureWindowSamples(
	account: FixtureAccount,
	window: QuotaWindowKind,
): WindowSample[] {
	return account.samples.map((s) => ({
		accountId: account.id,
		sampledAt: s.observedAt ?? s.sampledAt,
		pct: window === "five_hour" ? s.fiveHourPct : s.sevenDayPct,
		resetAt: window === "five_hour" ? s.fiveHourReset : s.sevenDayReset,
	}));
}

/**
 * Seed the dataset into a schema-initialized database, plus one account that
 * has no snapshots at all (`ACCOUNT_NO_SNAPSHOTS`).
 */
export function seedQuotaDriftFixture(db: Database): void {
	const insertAccount = db.prepare(
		`INSERT INTO accounts (id, name, provider, created_at,
			identity_plan_tier, identity_rate_limit_tier)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	);
	const insertSnapshot = db.prepare(
		`INSERT INTO usage_snapshots (
			account_id, provider, sampled_at, five_hour_pct, five_hour_reset,
			seven_day_pct, seven_day_reset, observed_at, plan_tier, rate_limit_tier
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const insertRequest = db.prepare(
		`INSERT INTO requests (
			id, timestamp, method, path, account_used, status_code, success,
			response_time_ms, failover_attempts, model, total_tokens, cost_usd,
			input_tokens, cache_read_input_tokens, cache_creation_input_tokens,
			output_tokens, billing_type
		) VALUES (?, ?, 'POST', '/v1/messages', ?, 200, 1, 800, 0, ?, ?, 0.01, ?, ?, ?, ?, 'plan')`,
	);

	db.transaction(() => {
		for (const account of FIXTURE_ACCOUNTS) {
			insertAccount.run(
				account.id,
				account.id,
				account.provider,
				FIXTURE_NOW - 90 * DAY,
				account.identityPlanTier,
				account.identityRateLimitTier,
			);
			for (const s of account.samples) {
				insertSnapshot.run(
					account.id,
					account.provider,
					s.sampledAt,
					s.fiveHourPct,
					s.fiveHourReset,
					s.sevenDayPct,
					s.sevenDayReset,
					s.observedAt,
					s.planTier,
					s.rateLimitTier,
				);
			}
			for (const r of account.requests) {
				insertRequest.run(
					r.id,
					r.timestamp,
					account.id,
					r.model,
					r.inputTokens +
						r.outputTokens +
						r.cacheReadInputTokens +
						r.cacheCreationInputTokens,
					r.inputTokens,
					r.cacheReadInputTokens,
					r.cacheCreationInputTokens,
					r.outputTokens,
				);
			}
		}
		insertAccount.run(
			ACCOUNT_NO_SNAPSHOTS,
			ACCOUNT_NO_SNAPSHOTS,
			"anthropic",
			FIXTURE_NOW - 90 * DAY,
			"max",
			"20x",
		);
	})();
}
