import { Logger } from "@clankermux/logger";

const log = new Logger("ModelsRoute");

/**
 * The parameter that tells the two clients of `GET /v1/models` apart.
 *
 * Codex's models-manager sends it on every fetch; OpenAI-format clients
 * (opencode, ohmypi) do not send it at all. Only its PRESENCE is read.
 *
 * Its VALUE is deliberately ignored. An earlier revision forwarded it upstream,
 * which was wrong twice over: it would have asked OpenAI for a catalog at a
 * version this proxy does not speak (see CODEX_MODEL_CATALOG_URL), and it made
 * a client-controlled string into a cache key, where varying it would mint an
 * unbounded number of misses — each one a fresh authenticated call to
 * chatgpt.com on a real account's OAuth bearer. Reading presence only removes
 * both problems at the source rather than validating the value.
 */
const CLIENT_VERSION_PARAM = "client_version";

export interface CodexModelCatalogBody {
	bodyText: string;
	etag: string | null;
}

export interface ModelsRouteDeps {
	/**
	 * The Codex catalog this API key may be shown, or null when the pool cannot
	 * read one. Takes the key because entitlement is per-subscription and a
	 * pinned key must not be shown a catalog from outside its pin.
	 */
	getCatalog(apiKeyId: string | null): Promise<CodexModelCatalogBody | null>;
	/** The static OpenAI Models-list reply. */
	staticModels(): Response;
}

/**
 * Answer `GET /v1/models` in whichever shape the caller actually parses.
 *
 * Codex asks for a `{"models": […]}` catalog and, when handed OpenAI's
 * `{"object":"list","data":[…]}` instead, fails to deserialize it, logs
 * `failed to load models cache`, and silently falls back to the catalog built
 * into its own binary. That silence is why this route looked healthy while
 * being useless to its only caller, and it is why every failure path here still
 * answers 200: a Codex startup must never be blocked by our inability to read a
 * catalog, it should just land back on the behaviour it had before.
 */
export async function handleModelsRoute(
	url: URL,
	deps: ModelsRouteDeps,
	apiKeyId: string | null = null,
): Promise<Response> {
	if (!url.searchParams.has(CLIENT_VERSION_PARAM)) {
		return deps.staticModels();
	}

	let catalog: CodexModelCatalogBody | null = null;
	try {
		catalog = await deps.getCatalog(apiKeyId);
	} catch (error) {
		// Defensive: the cache is written to swallow its own failures, so reaching
		// here means something unforeseen. Still not a reason to fail the request.
		log.warn(
			"Model-catalog lookup threw; serving the static list instead:",
			error instanceof Error ? error.message : String(error),
		);
	}

	if (!catalog) return deps.staticModels();

	const headers = new Headers({ "Content-Type": "application/json" });
	// Pass the upstream validator through so Codex stores a real etag rather
	// than one we invented. We do not honour inbound If-None-Match; no observed
	// client sends one, and a wrong 304 is harder to diagnose than a plain 200.
	if (catalog.etag) headers.set("ETag", catalog.etag);

	return new Response(catalog.bodyText, { status: 200, headers });
}
