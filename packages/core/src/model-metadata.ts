import type {
	ClientModelCost,
	ClientModelCostTier,
	ClientModelMetadata,
} from "@clankermux/types";
import { PROVIDER_NAMES } from "@clankermux/types";
import { resolveModelMaxContextWindow } from "./model-mappings";
import { type CatalogueLookupResult, lookupCatalogueEntry } from "./pricing";

type CatalogueEntry = NonNullable<CatalogueLookupResult["entry"]>;

/**
 * Largest context an Anthropic route can actually use through this proxy.
 *
 * The 1M window is beta-gated: the API enforces 200k unless
 * `anthropic-beta: context-1m-2025-08-07` is sent, and nothing here sends it.
 * Publishing the catalogue's 1_000_000 would hand a client a window its
 * requests would be rejected for filling.
 */
const ANTHROPIC_REACHABLE_CONTEXT = 200_000;

const INPUT_MODALITIES = ["text", "image"] as const;
type InputModality = (typeof INPUT_MODALITIES)[number];

export {
	type ModelCachePolicyRoute,
	reduceModelCachePolicies,
	resolveModelCachePolicy,
} from "./model-cache-policy";
export {
	reduceModelCacheRetentions,
	resolveModelCacheRetention,
} from "./model-cache-retention";

export interface ModelMetadataRequest {
	targetModel: string;
	/** Distinct providers of eligible accounts that need catalogue metadata. */
	providers: string[];
	/** Normalized native metadata for each eligible account with discovery. */
	discoveredMetadata?: ClientModelMetadata[];
	/** True when any eligible account's permissions are `unknown`. */
	unresolvedRoutes?: boolean;
}

/**
 * What can be said about one published alias, given every route that may serve
 * it.
 *
 * A field survives only when EVERY eligible route substantiates it, reduced
 * to the value that holds for all of them: the smallest window, the logical AND
 * of `reasoning`, the shared modalities, one common rate card. A client picks
 * the route it is given, not the best one, so a figure that is only true of some
 * routes is not true of the alias.
 */
export async function resolveClientModelMetadata(
	request: ModelMetadataRequest,
): Promise<ClientModelMetadata> {
	const providers = [...new Set(request.providers)];
	const discoveredMetadata = request.discoveredMetadata ?? [];
	// No route is evidence of nothing, not evidence of defaults — and an account
	// whose permissions have never been read cannot be counted out.
	if (
		request.unresolvedRoutes ||
		(providers.length === 0 && discoveredMetadata.length === 0)
	)
		return {};
	const candidates = await Promise.all(
		providers.map(async (provider) => {
			const { entry } = await lookupCatalogueEntry(
				request.targetModel,
				provider,
			);
			return candidateFor(request.targetModel, provider, entry);
		}),
	);
	return reduceClientModelMetadata([...candidates, ...discoveredMetadata]);
}

function candidateFor(
	targetModel: string,
	provider: string,
	entry: CatalogueEntry | null,
): ClientModelMetadata {
	const limit = entry?.limit;
	const metadata: ClientModelMetadata = {};
	const contextWindow = contextWindowFor(targetModel, provider, entry);
	if (contextWindow !== undefined) metadata.contextWindow = contextWindow;
	const maxOutputTokens = tokenCount(limit?.output);
	if (maxOutputTokens !== undefined) metadata.maxOutputTokens = maxOutputTokens;
	if (typeof entry?.reasoning === "boolean")
		metadata.reasoning = entry.reasoning;
	const inputModalities = modalitiesFrom(entry?.modalities?.input);
	if (inputModalities) metadata.inputModalities = inputModalities;
	const cost = costFrom(entry?.cost);
	if (cost) metadata.cost = cost;
	return metadata;
}

function contextWindowFor(
	targetModel: string,
	provider: string,
	entry: CatalogueEntry | null,
): number | undefined {
	// Codex subscriptions are not the API product models.dev describes: Astra's
	// live catalog reports 872k on the pool accounts while models.dev publishes
	// the API window. The verified ceiling is the one routing admits.
	if (provider === PROVIDER_NAMES.CODEX)
		return tokenCount(resolveModelMaxContextWindow(targetModel));
	const context = tokenCount(entry?.limit?.context);
	if (
		provider === PROVIDER_NAMES.ANTHROPIC ||
		provider === PROVIDER_NAMES.CLAUDE_CONSOLE_API
	)
		return context === undefined
			? undefined
			: Math.min(context, ANTHROPIC_REACHABLE_CONTEXT);
	// `limit.input` is the input-token ceiling where models.dev publishes one,
	// and a client's context accounting is about what it may send.
	return tokenCount(entry?.limit?.input) ?? context;
}

/**
 * A catalogue entry is unvalidated JSON — the load-time check proves one entry
 * somewhere carries a usable rate and nothing about this one — so every value is
 * checked here, and an invalid one drops its own field rather than the batch.
 */
function tokenCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: undefined;
}

function rate(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

function modalitiesFrom(value: unknown): InputModality[] | undefined {
	if (!Array.isArray(value)) return undefined;
	// pdf/audio/video are dropped: Pi and Oh My Pi model only these two.
	const known = INPUT_MODALITIES.filter((modality) => value.includes(modality));
	return known.length ? [...known] : undefined;
}

function costFrom(value: unknown): ClientModelCost | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const input = rate(raw.input);
	const output = rate(raw.output);
	// A half-published rate card prices nothing: both sides or neither.
	if (input === undefined || output === undefined) return undefined;
	const cacheRead = rate(raw.cache_read);
	const cacheWrite = rate(raw.cache_write);
	const tiers = tiersFrom(raw.tiers);
	return {
		input,
		output,
		...(cacheRead === undefined ? {} : { cacheRead }),
		...(cacheWrite === undefined ? {} : { cacheWrite }),
		...(tiers ? { tiers } : {}),
	};
}

function tiersFrom(value: unknown): ClientModelCostTier[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const tiers: ClientModelCostTier[] = [];
	for (const candidate of value) {
		if (!candidate || typeof candidate !== "object") continue;
		const raw = candidate as Record<string, unknown> & {
			tier?: { type?: unknown; size?: unknown };
		};
		if (raw.tier?.type !== "context") continue;
		const inputTokensAbove = tokenCount(raw.tier?.size);
		const input = rate(raw.input);
		const output = rate(raw.output);
		if (inputTokensAbove === undefined) continue;
		if (input === undefined || output === undefined) continue;
		const cacheRead = rate(raw.cache_read);
		const cacheWrite = rate(raw.cache_write);
		tiers.push({
			inputTokensAbove,
			input,
			output,
			...(cacheRead === undefined ? {} : { cacheRead }),
			...(cacheWrite === undefined ? {} : { cacheWrite }),
		});
	}
	tiers.sort((a, b) => a.inputTokensAbove - b.inputTokensAbove);
	return tiers.length ? tiers : undefined;
}

export function reduceClientModelMetadata(
	candidates: ClientModelMetadata[],
): ClientModelMetadata {
	if (!candidates.length) return {};
	const metadata: ClientModelMetadata = {};
	const windows = candidates.map((c) => c.contextWindow);
	if (windows.every((w) => w !== undefined))
		metadata.contextWindow = Math.min(...windows);
	const outputs = candidates.map((c) => c.maxOutputTokens);
	if (outputs.every((o) => o !== undefined))
		metadata.maxOutputTokens = Math.min(...outputs);
	const reasoning = candidates.map((c) => c.reasoning);
	if (reasoning.every((r) => r !== undefined))
		metadata.reasoning = reasoning.every((r) => r);
	const modalities = candidates.map((c) => c.inputModalities);
	if (modalities.every((m) => m !== undefined)) {
		const shared = INPUT_MODALITIES.filter((modality) =>
			modalities.every((m) => m.includes(modality)),
		);
		// No shared modality is not "accepts nothing" — it is no evidence at all,
		// and `input: []` would be a claim no route supports.
		if (shared.length) metadata.inputModalities = [...shared];
	}
	const costs = candidates.map((c) => c.cost);
	// Blending two rate cards produces a number matching no real bill, so a
	// disagreement drops the cost entirely. Catalogue costs have a consistent
	// field order from `costFrom`; differently ordered native costs conservatively
	// drop the rate card as well.
	if (
		costs.every((c) => c !== undefined) &&
		new Set(costs.map((c) => JSON.stringify(c))).size === 1
	)
		metadata.cost = costs[0];
	return metadata;
}
