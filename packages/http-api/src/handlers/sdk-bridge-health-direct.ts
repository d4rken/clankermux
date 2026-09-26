import {
	type SdkBridgeHealthErrorRow,
	type SdkBridgeHealthFailureRow,
	type SdkBridgeHealthGroupRow,
	type SdkBridgeHealthInnerRow,
	type SdkBridgeHealthMetric,
	type SdkBridgeHealthPercentileRow,
	SdkBridgeTurnRepository,
} from "@clankermux/database";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import {
	isSdkBridgeTurnStatus,
	SDK_BRIDGE_HEALTH_MESSAGE_MAX_CHARS,
	SDK_BRIDGE_HEALTH_RECENT_FAILURES,
	SDK_BRIDGE_HISTORY_MODES,
	SDK_BRIDGE_REBUILD_REASONS,
	SDK_BRIDGE_TURN_KINDS,
	SDK_BRIDGE_TURN_STATUSES,
	type SdkBridgeHealthResponse,
	type SdkBridgeHealthSplit,
	type SdkBridgeHistoryMode,
	type SdkBridgeInnerSummary,
	type SdkBridgePercentiles,
	type SdkBridgeRebuildReason,
	type SdkBridgeTurnKind,
	type SdkBridgeTurnStatus,
	sdkBridgeFailureRateRole,
} from "@clankermux/types";
import type { APIContext } from "../types";
import { getRangeConfig } from "./range-config";
import { normalizeRange } from "./usage-history-shared";

const log = new Logger("SdkBridgeHealthHandler");

/** The repository's health reads; tests pin `now`. */
export interface SdkBridgeHealthSources {
	countHealthGroups(sinceMs: number): Promise<SdkBridgeHealthGroupRow[]>;
	countHealthErrors(
		sinceMs: number,
		statuses: readonly SdkBridgeTurnStatus[],
	): Promise<SdkBridgeHealthErrorRow[]>;
	healthPercentiles(
		sinceMs: number,
		metric: SdkBridgeHealthMetric,
		scope?: {
			kind?: SdkBridgeTurnKind;
			statuses?: readonly SdkBridgeTurnStatus[];
		},
	): Promise<SdkBridgeHealthPercentileRow>;
	sumHealthInnerUsage(sinceMs: number): Promise<SdkBridgeHealthInnerRow[]>;
	listHealthFailures(
		sinceMs: number,
		statuses: readonly SdkBridgeTurnStatus[],
		limit: number,
	): Promise<SdkBridgeHealthFailureRow[]>;
	now?(): number;
}

/** What the card lists as errors: the failures, and the refusals beside them. */
const ERROR_STATUSES = SDK_BRIDGE_TURN_STATUSES.filter(
	(s) => sdkBridgeFailureRateRole(s) === "failure" || s === "rejected",
);

/** Turns that ran a Claude Code process and ended; their tool rounds are final. */
const ENDED_WITH_PROCESS = SDK_BRIDGE_TURN_STATUSES.filter(
	(s) => s !== "running" && s !== "released" && s !== "rejected",
);

function zeroRecord<K extends string>(keys: readonly K[]): Record<K, number> {
	return Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
}

function percentiles(row: SdkBridgeHealthPercentileRow): SdkBridgePercentiles {
	return { samples: row.samples, p50: row.p50, p95: row.p95 };
}

function emptySplit(key: string | null, name: string | null) {
	return {
		key,
		name,
		total: 0,
		completed: 0,
		failures: 0,
		finished: 0,
		rejected: 0,
		aborted: 0,
		costUsd: 0,
	} satisfies SdkBridgeHealthSplit;
}

function sortSplits(splits: Iterable<SdkBridgeHealthSplit>) {
	// Most rows first; the key breaks ties so the order holds between polls,
	// with the rows that recorded no key last.
	return [...splits].sort(
		(a, b) =>
			b.total - a.total ||
			(a.key === null ? 1 : 0) - (b.key === null ? 1 : 0) ||
			(a.key ?? "").localeCompare(b.key ?? ""),
	);
}

export async function computeSdkBridgeHealth(
	sources: SdkBridgeHealthSources,
	range: string,
): Promise<SdkBridgeHealthResponse> {
	const { windowMs } = getRangeConfig(range);
	const nowMs = sources.now?.() ?? Date.now();
	const sinceMs = windowMs === null ? 0 : nowMs - windowMs;

	const [
		groups,
		errors,
		spawn,
		firstEvent,
		duration,
		toolRounds,
		inner,
		fails,
	] = await Promise.all([
		sources.countHealthGroups(sinceMs),
		sources.countHealthErrors(sinceMs, ERROR_STATUSES),
		sources.healthPercentiles(sinceMs, "spawn_ms"),
		sources.healthPercentiles(sinceMs, "first_event_ms"),
		sources.healthPercentiles(sinceMs, "duration_ms"),
		sources.healthPercentiles(sinceMs, "tool_round_count", {
			kind: "turn",
			statuses: ENDED_WITH_PROCESS,
		}),
		sources.sumHealthInnerUsage(sinceMs),
		sources.listHealthFailures(
			sinceMs,
			ERROR_STATUSES,
			SDK_BRIDGE_HEALTH_RECENT_FAILURES,
		),
	]);

	const byStatus = zeroRecord(SDK_BRIDGE_TURN_STATUSES);
	const byKind = zeroRecord(SDK_BRIDGE_TURN_KINDS);
	const byHistoryMode = zeroRecord(SDK_BRIDGE_HISTORY_MODES);
	const byRebuildReason = zeroRecord(SDK_BRIDGE_REBUILD_REASONS);
	const harnesses = new Map<string | null, SdkBridgeHealthSplit>();
	const accounts = new Map<string | null, SdkBridgeHealthSplit>();
	let total = 0;

	for (const row of groups) {
		total += row.count;
		if (Object.hasOwn(byKind, row.kind))
			byKind[row.kind as SdkBridgeTurnKind] += row.count;
		if (Object.hasOwn(byHistoryMode, row.historyMode))
			byHistoryMode[row.historyMode as SdkBridgeHistoryMode] += row.count;
		if (
			row.rebuildReason !== null &&
			Object.hasOwn(byRebuildReason, row.rebuildReason)
		)
			byRebuildReason[row.rebuildReason as SdkBridgeRebuildReason] += row.count;

		let harness = harnesses.get(row.clientHarness);
		if (!harness) {
			harness = emptySplit(row.clientHarness, null);
			harnesses.set(row.clientHarness, harness);
		}
		let account = accounts.get(row.accountId);
		if (!account) {
			account = emptySplit(row.accountId, row.accountName);
			accounts.set(row.accountId, account);
		}
		for (const split of [harness, account]) split.total += row.count;

		if (!isSdkBridgeTurnStatus(row.status)) continue;
		byStatus[row.status] += row.count;
		const role = sdkBridgeFailureRateRole(row.status);
		for (const split of [harness, account]) {
			if (role !== "excluded") split.finished += row.count;
			if (role === "failure") split.failures += row.count;
			if (row.status === "completed") split.completed += row.count;
			if (row.status === "rejected") split.rejected += row.count;
			if (row.status === "aborted") split.aborted += row.count;
		}
	}

	const innerTotal: SdkBridgeInnerSummary = {
		requestCount: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		costUsd: 0,
	};
	for (const row of inner) {
		innerTotal.requestCount += row.requestCount;
		innerTotal.inputTokens += row.inputTokens;
		innerTotal.outputTokens += row.outputTokens;
		innerTotal.cacheReadInputTokens += row.cacheReadInputTokens;
		innerTotal.cacheCreationInputTokens += row.cacheCreationInputTokens;
		innerTotal.costUsd += row.costUsd;
		const harness = harnesses.get(row.clientHarness);
		if (harness) harness.costUsd += row.costUsd;
		const account = accounts.get(row.accountId);
		if (account) account.costUsd += row.costUsd;
	}

	let failures = 0;
	let finished = 0;
	for (const status of SDK_BRIDGE_TURN_STATUSES) {
		const role = sdkBridgeFailureRateRole(status);
		if (role === "failure") failures += byStatus[status];
		if (role !== "excluded") finished += byStatus[status];
	}

	return {
		range,
		windowStartsAt: sinceMs,
		windowEndsAt: nowMs,
		total,
		byStatus,
		byKind,
		failureRate: {
			failures,
			finished,
			rate: finished === 0 ? null : failures / finished,
		},
		errors: errors.flatMap((row) =>
			isSdkBridgeTurnStatus(row.status) ? [{ ...row, status: row.status }] : [],
		),
		timings: {
			spawnMs: percentiles(spawn),
			firstEventMs: percentiles(firstEvent),
			durationMs: percentiles(duration),
		},
		toolRounds: { ...percentiles(toolRounds), total: toolRounds.total },
		byHistoryMode,
		byRebuildReason,
		byHarness: sortSplits(harnesses.values()),
		byAccount: sortSplits(accounts.values()),
		inner: innerTotal,
		recentFailures: fails.flatMap((row) =>
			isSdkBridgeTurnStatus(row.status)
				? [
						{
							...row,
							kind: row.kind === "side_request" ? "side_request" : "turn",
							status: row.status,
							errorMessage:
								row.errorMessage?.slice(
									0,
									SDK_BRIDGE_HEALTH_MESSAGE_MAX_CHARS,
								) ?? null,
						},
					]
				: [],
		),
	};
}

export function createSdkBridgeHealthHandlerFromSources(
	sources: SdkBridgeHealthSources,
) {
	return async (params: URLSearchParams): Promise<Response> => {
		try {
			return jsonResponse(
				await computeSdkBridgeHealth(
					sources,
					normalizeRange(params.get("range")),
				),
			);
		} catch (error) {
			log.error("SDK bridge health error:", error);
			return errorResponse(
				InternalServerError("Failed to fetch SDK bridge health data"),
			);
		}
	};
}

/**
 * Built from the adapter, never `context.dbOps.sdkBridgeTurns`: the analytics
 * worker's context carries only `getAdapter()`.
 */
export function createSdkBridgeHealthHandler(context: APIContext) {
	return createSdkBridgeHealthHandlerFromSources(
		new SdkBridgeTurnRepository(context.dbOps.getAdapter()),
	);
}
