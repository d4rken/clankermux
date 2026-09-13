/**
 * The upstream model catalogues this proxy can read, behind one instance.
 *
 * It owns no HTTP shapes and no curation: what it holds is Anthropic's own
 * listing, the Codex catalogue and the bundled Codex ids, so the callers that
 * need a baseline share one set of caches rather than each holding their own.
 *
 * `ClientService` is the only consumer. It builds a new client's suggested
 * catalogue from these, and replays them once per database for the
 * pre-2026.9.52 backfill. Live `GET /v1/models` traffic never comes here — it
 * answers from the asking client's own saved catalogue.
 */

import type {
	AnthropicModelCatalogSnapshot,
	CodexModelCatalogEntry,
} from "@clankermux/proxy";

export interface ModelCatalogServiceDeps {
	/** Anthropic's live listing, with the bundled registry as its floor. */
	anthropicCatalog: { get(): Promise<AnthropicModelCatalogSnapshot> };
	/**
	 * The Codex catalogue. Takes the API key because entitlement is
	 * per-subscription: a pinned key must be shown a catalogue from inside its
	 * own pin.
	 */
	codexCatalog: {
		get(apiKeyId: string | null): Promise<CodexModelCatalogEntry | null>;
	};
	/** The Codex model ids this build ships with. */
	staticModelIds: readonly string[];
}

export class ModelCatalogService {
	private readonly deps: ModelCatalogServiceDeps;

	constructor(deps: ModelCatalogServiceDeps) {
		this.deps = deps;
	}

	/** Anthropic's listing. */
	getAnthropicCatalog(): Promise<AnthropicModelCatalogSnapshot> {
		return this.deps.anthropicCatalog.get();
	}

	/** The Codex catalogue for one API key. */
	getCodexCatalog(
		apiKeyId: string | null,
	): Promise<CodexModelCatalogEntry | null> {
		return this.deps.codexCatalog.get(apiKeyId);
	}

	/** The Codex model ids this build ships with. */
	get staticModelIds(): readonly string[] {
		return this.deps.staticModelIds;
	}
}
