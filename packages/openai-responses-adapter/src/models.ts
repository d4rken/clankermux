// Fallback model list for GET /v1/models, in OpenAI's Models-list shape.
//
// This is NOT what the Codex CLI reads. Codex asks the same route for something
// else entirely: its models-manager fetches `<base_url>/models?client_version=X`
// and deserializes a single-field envelope, `{"models": [...]}`, whose entries
// carry ~34 keys each — reasoning levels, context window, and the model's own
// `base_instructions` system prompt. It is served the genuine per-account
// catalog by `CodexModelCatalogCache` (packages/proxy); this list is only what
// the server falls back to when no Codex account can produce one.
//
// An earlier version of this comment claimed "clients only read `id`". That was
// wrong, and it is why the stub shipped: Codex could not parse the reply, logged
// `failed to load models cache`, and silently fell back to the catalog compiled
// into its own binary — so the endpoint looked like it worked for a month.
//
// The list remains ADVISORY for the OpenAI-format clients that do read it
// (opencode, ohmypi). The proxy forwards whatever model name the client sets
// straight through to the selected account's backend (see request-translator.ts
// — no gpt-* → Claude-family remap), so a model absent from this list still
// works as long as the upstream accepts it. Keep it to the CURRENTLY-SERVED
// Codex models (per the codex-cli models cache, 2026-06-09); retired slugs
// (gpt-5-codex, gpt-5.3-codex) were dropped.
const CODEX_MODELS = [
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-5.5",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.3-codex-spark",
] as const;

// Fixed creation timestamp. Nothing reads it meaningfully; a constant keeps the
// response stable and avoids spurious churn.
const MODEL_CREATED = 1_700_000_000;

/**
 * Handle `GET /v1/models` in the OpenAI Models-list shape.
 *
 * Serves OpenAI-format clients, and backs the Codex catalog path when the pool
 * has no Codex account to read a real catalog from. Either way the route
 * answers 200 rather than 400ing through the proxy pipeline.
 */
export function handleModelsRequest(): Response {
	const body = {
		object: "list",
		data: CODEX_MODELS.map((id) => ({
			id,
			object: "model",
			created: MODEL_CREATED,
			owned_by: "clankermux",
		})),
	};
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}
