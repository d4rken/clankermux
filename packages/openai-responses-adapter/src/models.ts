// Advisory model catalog for GET /v1/models.
//
// The Codex CLI probes this endpoint to populate its model picker and to
// validate the configured model. ClankerMux otherwise has no /v1/models route,
// so the probe falls through to the proxy path and 400s ("Provider cannot
// handle path: /v1/models") with noisy ERROR logs on every Codex startup.
//
// This list is ADVISORY ONLY. The proxy forwards whatever model name the client
// sets straight through to the selected account's backend (see
// request-translator.ts — no gpt-* → Claude-family remap), so a model absent
// from this list still works as long as the upstream accepts it. Keep it to the
// Codex/OpenAI models commonly routed through the proxy.
const CODEX_MODELS = [
	"gpt-5.5",
	"gpt-5.4",
	"gpt-5.3-codex",
	"gpt-5.4-mini",
	"gpt-5-codex",
] as const;

// Fixed creation timestamp. Clients only read `id`; a constant keeps the
// response stable and avoids spurious churn.
const MODEL_CREATED = 1_700_000_000;

/**
 * Handle `GET /v1/models` in the OpenAI Models-list shape so the Codex CLI's
 * model-list probe returns 200 instead of 400ing through the proxy pipeline.
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
