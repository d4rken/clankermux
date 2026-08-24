import type { Config } from "@clankermux/config";
import {
	accountWideExhaustion,
	isAccountAvailable,
	normalizeAnthropicUsage,
} from "@clankermux/core";
import type { DatabaseOperations } from "@clankermux/database";
import { Logger } from "@clankermux/logger";
import { USAGE_CACHE_TTL_MS, usageCache } from "@clankermux/providers";
import {
	getProviderOverloadSnapshot,
	getProviderOverloadUntil,
} from "@clankermux/proxy";
import type {
	Account,
	AnthropicUsageData,
	FullUsageData,
	RateLimitCause,
} from "@clankermux/types";
import { isUsablePrediction } from "@clankermux/types";
import { resolveRateLimitPresentation } from "../handlers/accounts";
import { buildPredictionsForAccounts } from "./build-account-predictions-for";

const log = new Logger("PublicSnapshot");

/**
 * Providers whose accounts report 5h/weekly usage windows. Only these can be
 * "stale": everything else never had a reading for a reading to go stale.
 */
const WINDOWED_PROVIDERS = new Set(["anthropic", "codex"]);

/** One usage window, flattened for a consumer that cannot nest further. */
export interface PublicLimitSnapshot {
	/** Normalized window class; `weekly_scoped` is per-model-family. */
	kind: "session" | "weekly_all" | "weekly_scoped" | "other";
	pct: number | null;
	resetsAt: number | null;
	/** Human label — the scoped model's display name, or the window's own name. */
	label: string | null;
}

/** One account, reduced to what a widget can render. */
export interface PublicAccountSnapshot {
	id: string;
	name: string;
	provider: string;
	paused: boolean;
	pauseReason: string | null;
	/** The resolved rate-limit cause, before it is mapped to the public enum. */
	cause: RateLimitCause;
	utilizationPct: number | null;
	fiveHourPct: number | null;
	fiveHourResetsAt: number | null;
	sevenDayPct: number | null;
	sevenDayResetsAt: number | null;
	willExhaustBeforeReset: boolean;
	rateLimitResetAt: number | null;
	providerOverloadedUntil: number | null;
	/**
	 * The provider-WIDE overload bucket (`family === null`), which gates every
	 * model family at once. Separated from `providerOverloadedUntil` (the max
	 * across all buckets) so a device can tell "the provider is down" from "one
	 * model family is cooling off" without walking a third array level.
	 */
	providerWideOverloadedUntil: number | null;
	stale: boolean;
	limits: PublicLimitSnapshot[];
}

/** Pool rollup, mirroring `/health`'s but with epoch-ms timestamps. */
export interface PublicPoolSnapshot {
	configured: number;
	routable: number;
	paused: number;
	rateLimited: number;
	usageExhausted: number;
	nextAvailableAt: number | null;
}

/** Cross-account usage aggregate. Each field is null when nothing supplies it. */
export interface PublicUsageAggregate {
	fiveHourPct: number | null;
	sevenDayPct: number | null;
	worstAccountPct: number | null;
}

/** Everything both public responses are built from. */
export interface PublicSnapshot {
	now: number;
	pool: PublicPoolSnapshot;
	usage: PublicUsageAggregate;
	accounts: PublicAccountSnapshot[];
	/** True when ANY windowed account's reading is missing or past the routing TTL. */
	stale: boolean;
}

/**
 * Clamp a reported utilization into the 0..100 the wire contract promises.
 *
 * Providers do emit values outside it (over-100 during an overage, and a
 * non-finite value when a payload is malformed). A device that treats the
 * number as a bar width has no way to render either, so NaN/Infinity collapse
 * to null ("unknown") and out-of-range values are clamped rather than dropped —
 * 103% used is still "full", and reporting null there would read as "no data".
 */
export function clampPct(value: number | null | undefined): number | null {
	if (value == null || typeof value !== "number" || !Number.isFinite(value)) {
		return null;
	}
	const clamped = Math.min(100, Math.max(0, value));
	// One decimal: enough for a bar, short enough not to inflate the payload.
	return Math.round(clamped * 10) / 10;
}

function parseResetMs(resetsAt: string | null | undefined): number | null {
	if (!resetsAt) return null;
	const ms = Date.parse(resetsAt);
	return Number.isFinite(ms) ? ms : null;
}

function normalizeLimitKind(kind: string): PublicLimitSnapshot["kind"] {
	switch (kind) {
		case "session":
		case "weekly_all":
		case "weekly_scoped":
			return kind;
		default:
			return "other";
	}
}

/**
 * The windows a device renders, flattened from whichever payload form the
 * provider sent. The flat `five_hour`/`seven_day` keys and the generic
 * `limits[]` array describe the same windows, so emitting both would show the
 * same bar twice; `limits[]` wins when present because it is the form Anthropic
 * is moving to and it carries the per-family entries the flat keys never had.
 */
function buildLimits(
	usage: AnthropicUsageData | null,
	now: number,
): PublicLimitSnapshot[] {
	if (!usage) return [];
	const entries = usage.limits ?? [];
	if (entries.length > 0) {
		return entries.map((entry) => ({
			kind: normalizeLimitKind(entry.kind),
			pct: clampPct(entry.percent),
			resetsAt: parseResetMs(entry.resets_at),
			label: entry.scope?.model?.display_name ?? entry.group ?? null,
		}));
	}
	const flat: PublicLimitSnapshot[] = [];
	const normalized = normalizeAnthropicUsage(usage, now);
	if (normalized.session) {
		flat.push({
			kind: "session",
			pct: clampPct(normalized.session.utilization),
			resetsAt: normalized.session.resetMs,
			label: "5-hour",
		});
	}
	if (normalized.weeklyAll) {
		flat.push({
			kind: "weekly_all",
			pct: clampPct(normalized.weeklyAll.utilization),
			resetsAt: normalized.weeklyAll.resetMs,
			label: "Weekly",
		});
	}
	const oauthApps = usage.seven_day_oauth_apps;
	if (oauthApps && typeof oauthApps.utilization === "number") {
		flat.push({
			kind: "weekly_all",
			pct: clampPct(oauthApps.utilization),
			resetsAt: parseResetMs(oauthApps.resets_at),
			label: "Weekly (Claude Code)",
		});
	}
	return flat;
}

/**
 * The mean over the accounts that actually HAVE the window.
 *
 * The denominator is what matters here and it is deliberately not the account
 * count: an account with no 5-hour window (a Codex account, whose rolling 5h
 * window OpenAI retired) contributes no evidence, and dividing by it would drag
 * every average toward zero as a pool gains non-windowed accounts. Null when no
 * account supplies the window at all — "unknown", never 0.
 */
function meanOfPresent(values: Array<number | null>): number | null {
	const present = values.filter((v): v is number => v !== null);
	if (present.length === 0) return null;
	const sum = present.reduce((a, b) => a + b, 0);
	return Math.round((sum / present.length) * 10) / 10;
}

function maxOfPresent(values: Array<number | null>): number | null {
	const present = values.filter((v): v is number => v !== null);
	return present.length === 0 ? null : Math.max(...present);
}

/** The columns the public read model needs, and no others. */
interface PublicAccountRow {
	id: string;
	name: string;
	provider: string | null;
	paused: 0 | 1;
	pause_reason: string | null;
	rate_limited_until: number | null;
	rate_limited_reason: string | null;
	rate_limit_reset: number | null;
	rate_limit_status: string | null;
	rate_limited: 0 | 1;
}

/**
 * The read-only snapshot both `/public/v1/*` responses are built from.
 *
 * Two constraints shape this and neither is negotiable:
 *
 *  - NO PROVIDER I/O. A widget GET must never cause an upstream call. The
 *    management accounts handler kicks off background refreshes (Codex reset
 *    credits) and is therefore unusable here; the usage cache is read through
 *    `peekWithAge`, which neither evicts nor refetches.
 *  - NO SECOND SET OF RULES. Exhaustion, rate-limit presentation, overload
 *    buckets and the prediction all come from the same pure helpers the
 *    management and health views use. Reimplementing any of them here would
 *    give a device an answer that quietly disagrees with the dashboard.
 */
export function createPublicSnapshotReader(
	dbOps: DatabaseOperations,
	_config: Config,
) {
	return async (now: number = Date.now()): Promise<PublicSnapshot> => {
		const rows = await dbOps.getAdapter().query<PublicAccountRow>(
			`
				SELECT
					id,
					name,
					provider,
					COALESCE(paused, 0) as paused,
					pause_reason,
					rate_limited_until,
					rate_limited_reason,
					rate_limit_reset,
					rate_limit_status,
					CASE WHEN rate_limited_until > ? THEN 1 ELSE 0 END as rate_limited
				FROM accounts
				ORDER BY name ASC
			`,
			[now],
		);

		// ONE non-evicting read per account, reused everywhere below, so the whole
		// response describes one consistent moment. `peekWithAge` keeps serving a
		// reading past the routing TTL and reports its true age, which is what lets
		// `stale` be a fact about the data rather than a refusal to show it.
		const readings = new Map(
			rows.map((row) => [row.id, usageCache.peekWithAge(row.id)] as const),
		);
		/** The ROUTING-fresh view: anything modelling "now" must use this one. */
		const routingFresh = new Map(
			rows.map((row) => {
				const entry = readings.get(row.id);
				return [
					row.id,
					entry && entry.ageMs <= USAGE_CACHE_TTL_MS ? entry.data : null,
				] as const;
			}),
		);

		// Best-effort and DB-only: the shared service reads stored usage snapshots
		// and regresses them. On any failure every account simply gets no
		// prediction, exactly as `/api/accounts` and `/api/runway` do.
		const predictions = await buildPredictionsForAccounts(
			dbOps,
			rows.map((row) => ({ id: row.id, provider: row.provider ?? null })),
			routingFresh,
			now,
		).catch((error) => {
			log.debug(
				`Public snapshot prediction failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return new Map();
		});

		const accounts: PublicAccountSnapshot[] = rows.map((row) => {
			const provider = row.provider || "anthropic";
			const windowed = WINDOWED_PROVIDERS.has(provider);
			const entry = readings.get(row.id) ?? null;
			const usage = (entry?.data ?? null) as AnthropicUsageData | null;
			const fresh = (routingFresh.get(row.id) ??
				null) as AnthropicUsageData | null;

			// An account we expect a reading from, whose reading is missing or past
			// the ROUTING freshness bar. Non-windowed providers never had one, so
			// they are not stale — they are simply not a usage source.
			const stale =
				windowed && (entry === null || entry.ageMs > USAGE_CACHE_TTL_MS);

			const normalized = windowed
				? normalizeAnthropicUsage(usage, now)
				: { session: null, weeklyAll: null, weeklyScoped: [] };

			// Same two-view split as `/api/accounts`: the weekly windows move over
			// days so a display-horizon reading is honest evidence for them, while
			// the 5h session moves fast enough that a half-hour-old 100% is not.
			const exhaustion = windowed
				? accountWideExhaustion(usage, now, fresh)
				: { exhausted: false, binding: null, resetMs: null };
			const accountWideExhausted =
				exhaustion.exhausted && exhaustion.binding !== null
					? { resetMs: exhaustion.resetMs, binding: exhaustion.binding }
					: null;

			const presentation = resolveRateLimitPresentation(
				{
					rate_limit_status: row.rate_limit_status,
					rate_limit_reset: row.rate_limit_reset,
					rate_limited: row.rate_limited,
					rate_limited_until: row.rate_limited_until,
					rate_limited_reason: row.rate_limited_reason,
				},
				now,
				accountWideExhausted,
			);

			const overloadBuckets = getProviderOverloadSnapshot(provider, now);
			const providerWide = overloadBuckets.find(
				(bucket) => bucket.family === null,
			);

			const prediction = predictions.get(row.id);
			const fiveHourUsable = isUsablePrediction(
				prediction?.fiveHour,
				normalized.session?.resetMs ?? null,
			);
			const sevenDayUsable = isUsablePrediction(
				prediction?.sevenDay,
				normalized.weeklyAll?.resetMs ?? null,
			);
			const willExhaustBeforeReset =
				(fiveHourUsable &&
					prediction?.fiveHour?.willExhaustBeforeReset === true) ||
				(sevenDayUsable &&
					prediction?.sevenDay?.willExhaustBeforeReset === true);

			const fiveHourPct = clampPct(normalized.session?.utilization ?? null);
			const sevenDayPct = clampPct(normalized.weeklyAll?.utilization ?? null);

			return {
				id: row.id,
				name: row.name,
				provider,
				paused: row.paused === 1,
				pauseReason: row.pause_reason ?? null,
				cause: presentation.cause,
				// The representative account-wide utilization: the worse of the two
				// account-wide windows. Family-scoped windows are deliberately
				// excluded — one spent family is not the account.
				utilizationPct: maxOfPresent([fiveHourPct, sevenDayPct]),
				fiveHourPct,
				fiveHourResetsAt: normalized.session?.resetMs ?? null,
				sevenDayPct,
				sevenDayResetsAt: normalized.weeklyAll?.resetMs ?? null,
				willExhaustBeforeReset,
				rateLimitResetAt: presentation.resetMs,
				providerOverloadedUntil: getProviderOverloadUntil(provider, now),
				providerWideOverloadedUntil: providerWide?.until ?? null,
				stale,
				limits: buildLimits(windowed ? usage : null, now),
			};
		});

		// The pool rollup. Built from the same fields `/health` uses, so a widget
		// and a container health check cannot report different pools. `Account` is
		// only partially populated here — `isAccountAvailable` reads paused and the
		// cooldown lock, and nothing else.
		const availability = rows.map((row) =>
			isAccountAvailable(
				{
					paused: row.paused === 1,
					rate_limited_until: row.rate_limited_until,
				} as Account,
				now,
			),
		);
		let routable = 0;
		let usageExhausted = 0;
		const recoveryTimes: number[] = [];
		accounts.forEach((account, index) => {
			if (!availability[index]) return;
			const exhausted = account.cause === "usage_exhausted" && !account.paused;
			if (exhausted) {
				usageExhausted++;
				if (account.rateLimitResetAt !== null) {
					recoveryTimes.push(account.rateLimitResetAt);
				}
				return;
			}
			routable++;
		});
		const earliestLock = rows.reduce<number | null>((min, row) => {
			if (row.paused === 1) return min;
			const until = row.rate_limited_until;
			if (!until || until < now) return min;
			return min === null ? Number(until) : Math.min(min, Number(until));
		}, null);
		if (earliestLock !== null) recoveryTimes.push(earliestLock);

		const pool: PublicPoolSnapshot = {
			configured: rows.length,
			routable,
			paused: accounts.filter((a) => a.paused).length,
			rateLimited: rows.filter(
				(row) =>
					row.paused !== 1 &&
					row.rate_limited_until != null &&
					Number(row.rate_limited_until) >= now,
			).length,
			usageExhausted,
			nextAvailableAt:
				recoveryTimes.length > 0 ? Math.min(...recoveryTimes) : null,
		};

		return {
			now,
			pool,
			usage: {
				fiveHourPct: meanOfPresent(accounts.map((a) => a.fiveHourPct)),
				sevenDayPct: meanOfPresent(accounts.map((a) => a.sevenDayPct)),
				worstAccountPct: maxOfPresent(accounts.map((a) => a.utilizationPct)),
			},
			accounts,
			stale: accounts.some((a) => a.stale),
		};
	};
}

export type PublicSnapshotReader = ReturnType<
	typeof createPublicSnapshotReader
>;
