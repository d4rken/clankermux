/**
 * The one place that knows what models this proxy offers.
 *
 * Two surfaces read a model catalogue — the wire route that answers
 * `GET /v1/models` and the dashboard page the operator curates it on — and they
 * MUST agree: a page that shows an entry the wire route hides (or vice versa)
 * is worse than no page at all, because the operator's next move is based on
 * what it showed. So the baselines, the override rows and the composition rules
 * live here once and both surfaces are handed this same instance.
 *
 * It owns no HTTP shapes. The wire route turns this into whichever dialect's
 * envelope the client parses; the management handler turns it into the editing
 * view. What is shared is the DATA and the rules, not the presentation.
 */

import type {
	ModelOverrideDialect,
	ModelOverrideRow,
} from "@clankermux/database";
import type {
	AnthropicModelCatalogSnapshot,
	CodexModelCatalogEntry,
} from "@clankermux/proxy";
import type {
	ModelCatalogResponse,
	ModelCatalogRow,
	ModelDialect,
} from "@clankermux/types";
import { indexOverrides, type ModelOverride } from "./model-overrides";

export interface ModelCatalogServiceDeps {
	/** Anthropic's live listing, with the bundled registry as its floor. */
	anthropicCatalog: { get(): Promise<AnthropicModelCatalogSnapshot> };
	/**
	 * The Codex catalogue. Read at the UNPINNED scope for the editing view: the
	 * operator curates the pool, not one API key's pin.
	 */
	codexCatalog: {
		get(apiKeyId: string | null): Promise<CodexModelCatalogEntry | null>;
		getFetchedAt(): number | null;
	};
	/** The Codex model ids this build ships with. */
	staticModelIds: readonly string[];
	listOverrides(dialect: ModelOverrideDialect): Promise<ModelOverrideRow[]>;
	upsertOverride(input: {
		dialect: ModelOverrideDialect;
		modelId: string;
		hidden: boolean;
		custom: boolean;
		displayName: string | null;
		now: number;
	}): Promise<void>;
	removeOverride(
		dialect: ModelOverrideDialect,
		modelId: string,
	): Promise<boolean>;
	now?: () => number;
}

/** A baseline entry plus where the list it came from was obtained. */
interface Baseline {
	models: Array<{ id: string; displayName: string }>;
	source: ModelCatalogResponse["baseline"]["source"];
	fetchedAt: number | null;
}

export class ModelCatalogService {
	private readonly deps: ModelCatalogServiceDeps;
	private readonly now: () => number;

	constructor(deps: ModelCatalogServiceDeps) {
		this.deps = deps;
		this.now = deps.now ?? Date.now;
	}

	/** Anthropic's listing, for the wire route. */
	getAnthropicCatalog(): Promise<AnthropicModelCatalogSnapshot> {
		return this.deps.anthropicCatalog.get();
	}

	/** The Codex catalogue for one API key, for the wire route. */
	getCodexCatalog(
		apiKeyId: string | null,
	): Promise<CodexModelCatalogEntry | null> {
		return this.deps.codexCatalog.get(apiKeyId);
	}

	/** The Codex model ids this build ships with, for the wire route. */
	get staticModelIds(): readonly string[] {
		return this.deps.staticModelIds;
	}

	/** The curation for one dialect, in the shape the composition helpers take. */
	async listOverrides(dialect: ModelDialect): Promise<ModelOverride[]> {
		const rows = await this.deps.listOverrides(dialect);
		return rows.map(toModelOverride);
	}

	/**
	 * The editing view: the baseline with every stored override folded in.
	 *
	 * Hidden entries are PRESENT here with `hidden: true`, unlike on the wire
	 * where they are gone. An operator cannot un-hide what the page does not
	 * show, so the page's job is the opposite of the route's.
	 */
	async getCatalogView(dialect: ModelDialect): Promise<ModelCatalogResponse> {
		const [baseline, overrides] = await Promise.all([
			this.baselineFor(dialect),
			this.listOverrides(dialect),
		]);

		const index = indexOverrides(
			baseline.models.map((model) => model.id),
			overrides,
		);
		// `indexOverrides` deliberately drops the name of a hidden row, because the
		// wire never shows one. The editing view does show it, so the stored value
		// is read straight from the rows here.
		const storedNames = new Map(
			overrides
				.filter((override) => override.displayName !== null)
				.map((override) => [override.modelId, override.displayName as string]),
		);

		const rows: ModelCatalogRow[] = [];
		const seen = new Set<string>();
		for (const model of baseline.models) {
			if (seen.has(model.id)) continue;
			seen.add(model.id);
			const overrideName = storedNames.get(model.id) ?? null;
			rows.push({
				id: model.id,
				displayName: overrideName ?? model.displayName,
				source: "upstream",
				hidden: index.hidden.has(model.id),
				overrideDisplayName: overrideName,
			});
		}
		for (const addition of index.additions) {
			if (seen.has(addition.modelId)) continue;
			seen.add(addition.modelId);
			rows.push({
				id: addition.modelId,
				displayName: addition.displayName ?? addition.modelId,
				source: "custom",
				hidden: false,
				overrideDisplayName: addition.displayName,
			});
		}

		return {
			baseline: { source: baseline.source, fetchedAt: baseline.fetchedAt },
			rows,
		};
	}

	/**
	 * Write one row, or delete it when the operator has reverted every field.
	 *
	 * A row that hides nothing, adds nothing and renames nothing describes no
	 * difference from upstream, and keeping it would leave the table accumulating
	 * inert rows that mean "unchanged" — indistinguishable from a row nobody has
	 * touched, and a needless write on every render.
	 */
	async setOverride(input: {
		dialect: ModelDialect;
		modelId: string;
		hidden: boolean;
		custom: boolean;
		displayName: string | null;
	}): Promise<void> {
		if (!input.hidden && !input.custom && input.displayName === null) {
			await this.deps.removeOverride(input.dialect, input.modelId);
			return;
		}
		await this.deps.upsertOverride({ ...input, now: this.now() });
	}

	async removeOverride(
		dialect: ModelDialect,
		modelId: string,
	): Promise<boolean> {
		return this.deps.removeOverride(dialect, modelId);
	}

	private async baselineFor(dialect: ModelDialect): Promise<Baseline> {
		if (dialect === "anthropic") {
			const snapshot = await this.deps.anthropicCatalog.get();
			return {
				models: snapshot.models.map((model) => ({
					id: model.id,
					displayName: model.displayName,
				})),
				source: snapshot.source,
				fetchedAt: snapshot.fetchedAt,
			};
		}

		// The OpenAI mount serves two lists to two clients, so its baseline is
		// their UNION: hiding an entry has to be expressible for both, and an
		// operator should not have to know which client reads which list to
		// curate it.
		const models = this.deps.staticModelIds.map((id) => ({
			id,
			displayName: id,
		}));
		let source: Baseline["source"] = "static";
		let fetchedAt: number | null = null;

		let catalog: CodexModelCatalogEntry | null = null;
		try {
			catalog = await this.deps.codexCatalog.get(null);
		} catch {
			// The cache swallows its own failures; reaching here means something
			// unforeseen, and the static list is still a usable baseline.
			catalog = null;
		}
		if (catalog) {
			const parsed = parseCodexSlugs(catalog.bodyText);
			if (parsed.length > 0) {
				source = "codex-catalog";
				fetchedAt = this.deps.codexCatalog.getFetchedAt();
				const known = new Set(models.map((model) => model.id));
				for (const entry of parsed) {
					if (known.has(entry.id)) {
						// The catalogue's own name beats the slug the static list has.
						const existing = models.find((model) => model.id === entry.id);
						if (existing) existing.displayName = entry.displayName;
						continue;
					}
					known.add(entry.id);
					models.push(entry);
				}
			}
		}

		return { models, source, fetchedAt };
	}
}

function toModelOverride(row: ModelOverrideRow): ModelOverride {
	return {
		modelId: row.model_id,
		hidden: row.hidden === 1,
		custom: row.custom === 1,
		displayName: row.display_name,
		createdAt: row.created_at,
	};
}

/** Slugs and names from a Codex catalogue body; empty when it is not one. */
function parseCodexSlugs(
	bodyText: string,
): Array<{ id: string; displayName: string }> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		return [];
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return [];
	}
	const models = (parsed as { models?: unknown }).models;
	if (!Array.isArray(models)) return [];

	const entries: Array<{ id: string; displayName: string }> = [];
	for (const entry of models) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			continue;
		}
		const row = entry as { slug?: unknown; display_name?: unknown };
		if (typeof row.slug !== "string" || row.slug.length === 0) continue;
		entries.push({
			id: row.slug,
			displayName:
				typeof row.display_name === "string" && row.display_name.length > 0
					? row.display_name
					: row.slug,
		});
	}
	return entries;
}
