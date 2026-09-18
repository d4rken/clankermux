import type { ClientFormat } from "@clankermux/types";
import type { WireDialect } from "./wire-mounts";

/**
 * The parameter that tells the two OpenAI-dialect clients apart.
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

/** Bound the catalogue read so client startup cannot wait on SQLite retries. */
const CATALOGUE_READ_BUDGET_MS = 2_000;
const CATALOGUE_METADATA_READ_BUDGET_MS = 3_000;

export interface ModelsRouteDeps {
	/** Saved per-key catalogue; failures return 503 without substituting a shared list. */
	getClientCatalog(
		apiKeyId: string,
		format: ClientFormat,
		includeMetadata?: boolean,
	): Promise<Response>;
}

/**
 * Answer `GET /v1/models` from the asking client's own saved catalogue.
 *
 * THREE shapes, picked by the mount and then by the query string, because none
 * of the three clients can read another's:
 *
 *  - `/wire/anthropic` gets Anthropic's own `{"data":[{"type":"model",…}]}`
 *    listing. Claude Code's gateway model discovery reads exactly this.
 *  - `/wire/openai` with `client_version` gets the Codex `{"models":[…]}`
 *    catalog, because Codex, handed OpenAI's list shape instead, fails to
 *    deserialize it, logs `failed to load models cache`, and silently falls
 *    back to the catalog built into its own binary. That silence is why this
 *    route looked healthy while being useless to its only caller.
 *  - `/wire/openai` without it gets OpenAI's `{"object":"list","data":[…]}`.
 *
 * There is no shared fallback list. Every request here carries an authenticated
 * key, so a catalogue that cannot be read is a 503 for THAT client rather than
 * a pool-wide list it was never configured to see.
 */
export async function handleModelsRoute(
	url: URL,
	deps: ModelsRouteDeps,
	apiKeyId: string,
	dialect: WireDialect,
): Promise<Response> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			deps.getClientCatalog(
				apiKeyId,
				dialect === "anthropic"
					? "anthropic"
					: url.searchParams.has(CLIENT_VERSION_PARAM)
						? "codex"
						: "openai",
				url.searchParams.get("clankermux_metadata") === "1",
			),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Catalogue read timed out")),
					url.searchParams.get("clankermux_metadata") === "1"
						? CATALOGUE_METADATA_READ_BUDGET_MS
						: CATALOGUE_READ_BUDGET_MS,
				);
			}),
		]);
	} catch {
		return Response.json(
			{
				error: {
					message: "Client catalogue is temporarily unavailable",
					type: "server_error",
				},
			},
			{ status: 503, headers: { "Cache-Control": "private, no-store" } },
		);
	} finally {
		clearTimeout(timer);
	}
}
