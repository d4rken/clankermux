import { HARNESS_LABEL_FOR_APPLICATION } from "@clankermux/core";
import type { ClientEfficiencyRow } from "@clankermux/types";

/**
 * Rolling the (API key × harness) payload up for display.
 *
 * The server sends sums and counts only, so every rate here is computed AFTER
 * the group is summed. Averaging the rows' own rates instead would be wrong by
 * an amount that grows with how unevenly the requests are spread: 100 requests
 * with one covered row averaging 100 tokens, combined with 10 fully covered
 * requests averaging 1,000, give 918.18 by averaging the averages against a
 * true 181.82.
 */

export type ClientGrouping = "client" | "harness";

/** One displayed row: several payload rows summed under one identity. */
export interface ClientEfficiencyGroup {
	/** React key and group identity. */
	key: string;
	/** The client's display name, or the harness name when grouping by harness. */
	label: string;
	/**
	 * The harness shown in the chip: the one with the most requests in the group
	 * (ties broken lexicographically). A group can span several, which is what
	 * `otherHarnessCount` reports rather than hiding.
	 */
	harness: string | null;
	/** Harnesses in the group beyond {@link harness}; 0 when it holds just one. */
	otherHarnessCount: number;
	/** Every harness in the group, for the chip's title attribute. */
	allHarnesses: string[];
	/** The client's configured application; null when grouping by harness. */
	declaredApplication: string | null;
	requests: number;
	successfulRequests: number;
	observedRequests: number;
	inferredSessionRequests: number;
	inferredDeclaredRequests: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	costUsd: number;
	pricedRequests: number;
	unpricedRequests: number;
	contextCoveredRequests: number;
	contextTokensSum: number;
	contextToolsCharsSum: number;
	contextSystemCharsSum: number;
	contextToolCountSum: number;
}

/** The label shown when nothing identified the harness. */
export const UNKNOWN_HARNESS_LABEL = "Unknown";

interface Accumulator extends ClientEfficiencyGroup {
	/** Requests per harness in the group, for picking the dominant one. */
	perHarness: Map<string | null, number>;
}

function emptyAccumulator(key: string, label: string): Accumulator {
	return {
		key,
		label,
		harness: null,
		otherHarnessCount: 0,
		allHarnesses: [],
		declaredApplication: null,
		requests: 0,
		successfulRequests: 0,
		observedRequests: 0,
		inferredSessionRequests: 0,
		inferredDeclaredRequests: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		costUsd: 0,
		pricedRequests: 0,
		unpricedRequests: 0,
		contextCoveredRequests: 0,
		contextTokensSum: 0,
		contextToolsCharsSum: 0,
		contextSystemCharsSum: 0,
		contextToolCountSum: 0,
		perHarness: new Map(),
	};
}

function add(target: Accumulator, row: ClientEfficiencyRow): void {
	target.requests += row.requests;
	target.successfulRequests += row.successfulRequests;
	target.observedRequests += row.observedRequests;
	target.inferredSessionRequests += row.inferredSessionRequests;
	target.inferredDeclaredRequests += row.inferredDeclaredRequests;
	target.inputTokens += row.inputTokens;
	target.outputTokens += row.outputTokens;
	target.cacheReadTokens += row.cacheReadTokens;
	target.cacheCreationTokens += row.cacheCreationTokens;
	target.costUsd += row.costUsd;
	target.pricedRequests += row.pricedRequests;
	target.unpricedRequests += row.unpricedRequests;
	target.contextCoveredRequests += row.contextCoveredRequests;
	target.contextTokensSum += row.contextTokensSum;
	target.contextToolsCharsSum += row.contextToolsCharsSum;
	target.contextSystemCharsSum += row.contextSystemCharsSum;
	target.contextToolCountSum += row.contextToolCountSum;
	target.perHarness.set(
		row.harness,
		(target.perHarness.get(row.harness) ?? 0) + row.requests,
	);
}

/** Most requests wins; ties go to the lexicographically first name, null last. */
function dominantHarness(
	perHarness: Map<string | null, number>,
): string | null {
	let best: string | null = null;
	let bestCount = -1;
	for (const [harness, count] of perHarness) {
		if (count > bestCount) {
			best = harness;
			bestCount = count;
			continue;
		}
		if (count !== bestCount) continue;
		if (best === null) best = harness;
		else if (harness !== null && harness < best) best = harness;
	}
	return best;
}

function finalize(accumulator: Accumulator): ClientEfficiencyGroup {
	const harness = dominantHarness(accumulator.perHarness);
	const names = [...accumulator.perHarness.keys()].map(
		(name) => name ?? UNKNOWN_HARNESS_LABEL,
	);
	names.sort((a, b) => a.localeCompare(b));
	const { perHarness: _perHarness, ...group } = accumulator;
	return {
		...group,
		harness,
		otherHarnessCount: Math.max(0, accumulator.perHarness.size - 1),
		allHarnesses: names,
	};
}

/**
 * Roll the payload rows up under one identity.
 *
 * Grouping by client keys on `apiKeyId` — the identity — and never on the
 * display name, so a key renamed mid-range stays one row and two keys that
 * happen to share a snapshot name stay two.
 */
export function rollUpClientEfficiency(
	rows: readonly ClientEfficiencyRow[],
	grouping: ClientGrouping,
): ClientEfficiencyGroup[] {
	const groups = new Map<string, Accumulator>();
	for (const row of rows) {
		const key =
			grouping === "client"
				? `key:${row.apiKeyId ?? ""}`
				: `harness:${row.harness ?? ""}`;
		const label =
			grouping === "client"
				? row.apiKey
				: (row.harness ?? UNKNOWN_HARNESS_LABEL);
		let accumulator = groups.get(key);
		if (!accumulator) {
			accumulator = emptyAccumulator(key, label);
			groups.set(key, accumulator);
		}
		// A configured application belongs to a key. Under harness grouping a row
		// can span several keys, so there is no single declaration to report and
		// the mismatch badge is deliberately out of reach there.
		if (grouping === "client" && accumulator.declaredApplication === null) {
			accumulator.declaredApplication = row.declaredApplication;
		}
		add(accumulator, row);
	}
	return [...groups.values()].map(finalize);
}

/** Inferred rows anywhere in the group — conservative by design. */
export function hasInferredRows(group: ClientEfficiencyGroup): boolean {
	return group.inferredSessionRequests + group.inferredDeclaredRequests > 0;
}

/** Which inference tiers contributed, in the order the chip's title names them. */
export function inferenceTiers(group: ClientEfficiencyGroup): string[] {
	const tiers: string[] = [];
	if (group.inferredSessionRequests > 0) {
		tiers.push("Inferred from session identity");
	}
	if (group.inferredDeclaredRequests > 0) {
		tiers.push("Inferred from the client's configured application");
	}
	return tiers;
}

/**
 * Does the client's OBSERVED harness contradict its configured application?
 *
 * Only a fully-observed group can contradict anything: an inferred label that
 * came from the declaration in the first place would otherwise flag itself, and
 * a session-inferred one is a guess, not a measurement. The observed harness
 * must also be a known application label — `openai` from an SDK is not a
 * competing claim about how the key is configured.
 */
export function declaredHarnessMismatch(
	group: ClientEfficiencyGroup,
): string | null {
	const declared = group.declaredApplication;
	if (!declared || declared === "generic") return null;
	if (hasInferredRows(group)) return null;
	const harness = group.harness;
	if (!harness || harness === declared) return null;
	const known = new Set(
		Object.values(HARNESS_LABEL_FOR_APPLICATION).filter(
			(label): label is string => label !== null,
		),
	);
	return known.has(harness) ? declared : null;
}

/** Share of context reads served from cache, as a percentage. */
export function cacheHitRate(group: {
	inputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
}): number | null {
	const total =
		group.inputTokens + group.cacheReadTokens + group.cacheCreationTokens;
	return total > 0 ? (group.cacheReadTokens / total) * 100 : null;
}

/**
 * Cache writes per cache read. Above ~1 the client is paying to build a cache
 * it never reads back. Null when nothing was read, where the ratio is undefined
 * rather than infinite.
 */
export function cacheChurnRatio(group: {
	cacheReadTokens: number;
	cacheCreationTokens: number;
}): number | null {
	return group.cacheReadTokens > 0
		? group.cacheCreationTokens / group.cacheReadTokens
		: null;
}

/** Cost per PRICED request; null when no row in the group carried a cost. */
export function costPerRequest(group: {
	costUsd: number;
	pricedRequests: number;
}): number | null {
	return group.pricedRequests > 0 ? group.costUsd / group.pricedRequests : null;
}

/** Any sum divided by the covered-request denominator it belongs to. */
export function perCoveredRequest(
	sum: number,
	contextCoveredRequests: number,
): number | null {
	return contextCoveredRequests > 0 ? sum / contextCoveredRequests : null;
}

/** Successful share of the group, as a percentage. */
export function successRate(group: {
	requests: number;
	successfulRequests: number;
}): number | null {
	return group.requests > 0
		? (group.successfulRequests / group.requests) * 100
		: null;
}
