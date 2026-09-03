/**
 * What the ChatGPT/Codex backend (chatgpt.com/backend-api/codex/responses)
 * accepts in a Responses body, and how to coerce a client's value into it.
 *
 * Sibling of `native-ping.ts`, whose comment records the first two rejections
 * this module encodes (verified live 2026-07, reproduced in production 2026-08):
 *  - `max_output_tokens` → 400 `{"detail":"Unsupported parameter: max_output_tokens"}`
 *  - `reasoning.effort: "minimal"` → 400 "Unsupported value: 'minimal' ...
 *    Supported values are: none, low, medium, high, xhigh"
 *
 * Three more top-level parameters were verified live against the same backend
 * on 2026-08-21 (issue #6 follow-up), each with a minimal streaming Responses
 * request that succeeds once the single field is removed:
 *  - `temperature` → 400 `{"detail":"Unsupported parameter: temperature"}`
 *  - `metadata`    → 400 `{"detail":"Unsupported parameter: metadata"}`
 *  - `user`        → 400 `{"detail":"Unsupported parameter: user"}`
 *
 * It lives in its own file rather than in `native-ping.ts` because that module
 * imports from `provider.ts`, and `provider.ts` is the consumer here — importing
 * it back would close a module cycle.
 *
 * This is deliberately NOT `resolveReasoningEffort` (@clankermux/openai-formats):
 * that resolver has no notion of `none` (it THROWS a ValidationError on it), and
 * it leaves `minimal` untouched for Codex models that fall through to the generic
 * `gpt-5` profile — exactly the value the backend rejects.
 */

/**
 * Reasoning efforts the ChatGPT/Codex backend accepts for the GPT-5.x models,
 * ascending. Verified live against gpt-5.6-sol: `minimal` and `max` 400.
 */
export const CHATGPT_BACKEND_REASONING_EFFORTS = [
	"none",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;

export type ChatGptBackendReasoningEffort =
	(typeof CHATGPT_BACKEND_REASONING_EFFORTS)[number];

/**
 * Reasoning efforts for the GPT-6 generation, ascending. Taken from the
 * `supported_reasoning_levels` of the gpt-6-astra entry in the Codex catalog
 * (codex-cli 0.153.1, openai/codex#42605): low, medium, high, xhigh, max,
 * ultra. Neither `none` nor `minimal` is listed, so those clamp UP to `low`
 * rather than being sent as-is. `max` is a real value here — the 5.x clamp
 * to `xhigh` would silently cap the model the client explicitly paid for.
 */
export const CHATGPT_BACKEND_GPT6_REASONING_EFFORTS = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
] as const;

/**
 * Every reasoning effort we know of, ascending by how much reasoning it buys —
 * including the ones some generation rejects (`minimal`, `max`, `ultra`),
 * which is precisely what lets them be clamped to a neighbour instead of being
 * sent as-is. `none` sorts below `minimal`: no reasoning at all is less than
 * the least.
 */
const KNOWN_EFFORTS_ASCENDING = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
] as const;

const ACCEPTED_GPT5 = new Set<string>(CHATGPT_BACKEND_REASONING_EFFORTS);
const ACCEPTED_GPT6 = new Set<string>(CHATGPT_BACKEND_GPT6_REASONING_EFFORTS);

/**
 * The effort set the backend accepts for `model`, in ascending order. Keyed on
 * the generation prefix so a dated variant (`gpt-6-astra-2026-09-03`) or a
 * later GPT-6 tier resolves without a table edit; an unknown or absent model
 * gets the 5.x set, which is what every Codex-served slug before GPT-6 used.
 */
export function chatGptBackendReasoningEffortsFor(
	model: string | undefined,
): readonly string[] {
	return isGpt6Model(model)
		? CHATGPT_BACKEND_GPT6_REASONING_EFFORTS
		: CHATGPT_BACKEND_REASONING_EFFORTS;
}

function isGpt6Model(model: string | undefined): boolean {
	return typeof model === "string" && model.toLowerCase().startsWith("gpt-6");
}

/**
 * Coerce a `reasoning.effort` value into something the ChatGPT/Codex backend
 * accepts for the target `model`:
 *  - an accepted value is returned unchanged (`none` is PRESERVED on 5.x — it
 *    is the cheapest accepted value there, not an absence),
 *  - a known-but-rejected value clamps to the nearest accepted value at or
 *    below it (5.x: `minimal` → `none`, `max` → `xhigh`; GPT-6 keeps `max`),
 *  - a known value below the model's floor clamps UP to that floor (GPT-6:
 *    `none`/`minimal` → `low`),
 *  - anything we do not recognise is returned untouched, so a value the backend
 *    learns to accept before we do is not silently rewritten.
 *
 * Never throws: callers sit on request paths whose contract is "never fail the
 * request over a parameter we merely wanted to fix up".
 */
export function clampChatGptBackendReasoningEffort(
	effort: string,
	model?: string,
): string {
	const accepted = isGpt6Model(model) ? ACCEPTED_GPT6 : ACCEPTED_GPT5;
	if (accepted.has(effort)) return effort;
	const rank = KNOWN_EFFORTS_ASCENDING.indexOf(
		effort as (typeof KNOWN_EFFORTS_ASCENDING)[number],
	);
	if (rank < 0) return effort;
	for (let i = rank - 1; i >= 0; i--) {
		const candidate = KNOWN_EFFORTS_ASCENDING[i];
		if (accepted.has(candidate)) return candidate;
	}
	// Below every accepted value — clamp UP to the cheapest accepted value
	// rather than sending something the backend rejects.
	return chatGptBackendReasoningEffortsFor(model)[0];
}

/**
 * Top-level Responses fields the ChatGPT/Codex backend rejects outright. See
 * the module header for the live verification behind each entry.
 *
 * This is a DENYLIST and deliberately not an allowlist, for the same reason
 * {@link clampChatGptBackendReasoningEffort} passes unrecognised efforts
 * through. The two have opposite failure modes, and they are not symmetric:
 *  - A missing denylist entry produces a LOUD upstream 400 that names the
 *    offending parameter verbatim, and closing the gap is a one-line edit here.
 *  - An over-broad allowlist SILENTLY eats a field the backend accepts, so the
 *    request succeeds with semantics the client did not ask for. Responses is
 *    an open, still-growing shape (`include`, `service_tier`, `text.verbosity`,
 *    `prompt_cache_key`, … all arrived after the fact) against an undocumented
 *    backend, so an allowlist would go stale by default rather than on purpose.
 *
 * `max_tokens` and `max_completion_tokens` are deliberately ABSENT. They are
 * Chat-Completions names, not Responses fields, and neither has been observed
 * against this backend — a client sending one has a genuine request-shape bug
 * that the backend's own error names precisely, and guessing on its behalf
 * would hide it. Add an entry only once a rejection has actually been seen.
 *
 * Two of these are a real semantic degradation, not neutral sanitation:
 * dropping `temperature` serves the request with the backend's own sampling
 * instead of the client's, and dropping `max_output_tokens` removes an output
 * cap. Stripping is still the right call, because the backend accepts NO value
 * for either — the only choice is "fail the request" or "serve the closest
 * request that works", and this adapter has consistently chosen the latter.
 * That is also exactly why every caller must gate on the request really
 * targeting this backend: on a custom endpoint the same deletes would uncap
 * spend and change sampling for a backend that likely honours both.
 * `metadata` and `user` are pure attribution/telemetry and carry no such cost.
 */
const REJECTED_TOP_LEVEL_PARAMS = [
	"max_output_tokens",
	"metadata",
	"temperature",
	"user",
] as const;

export type ChatGptBackendRejectedParam =
	(typeof REJECTED_TOP_LEVEL_PARAMS)[number];

/**
 * `reasoning.context` — ACCEPTED by this backend, and deliberately never
 * INJECTED by us. Note the distinction: on the native passthrough a
 * client-supplied `reasoning.context` reaches the backend untouched, because
 * that path forwards reasoning siblings verbatim and the sanitation below does
 * not strip it. What is ruled out here is this proxy adding the field on its
 * own.
 *
 * Verified live 2026-08-24 with the usual single-field probe: omitted → 200,
 * `"all_turns"` → 200, `"current_turn"` → 200, and a junk value → 400
 * `{"error":{"message":"Invalid value: '…'. Supported values are: 'auto',
 * 'current_turn', and 'all_turns'.","param":"reasoning.context",
 * "code":"invalid_value"}}`. Recorded here because the 200s are the surprising
 * half: this is not a field we omit because it fails.
 *
 * `context` selects a PERSISTED-REASONING policy across responses, not a
 * quality knob within one generation. The Codex CLI ships guidance saying not
 * to enable persisted reasoning merely because it exists, and that under
 * `store: false` it requires requesting and replaying
 * `reasoning.encrypted_content`.
 *
 * The TRANSLATED path structurally cannot satisfy that: it rebuilds `input`
 * from Anthropic messages, so prior reasoning items do not survive at all.
 * Injecting `all_turns` there would opt into a persistence policy with nothing
 * persistable attached. The NATIVE passthrough is different — it preserves the
 * client's `include` and its `input` array, so a client that asks for and
 * replays encrypted reasoning keeps working — but it too forces `store: false`
 * and drops `previous_response_id`, and either way the choice belongs to the
 * client that owns the conversation, not to a load balancer sitting in the
 * middle of it.
 *
 * Omitted rather than pinned to `"current_turn"` on purpose. A 200 with the
 * field absent proves only that it is optional; it does NOT prove the implicit
 * default equals any of the three named values, so pinning would be asserting
 * something unverified. Omission is also the only form that stays safe on a
 * custom Codex-compatible endpoint that has never heard of the field. Pin it
 * only behind `targetsChatGptCodexBackend` and only once a behavioural test
 * (capture and replay `reasoning.encrypted_content` across two requests) shows
 * the setting actually moves something.
 *
 * Upstream better-ccflare v3.5.66 sets `context: "all_turns"` unconditionally.
 * That is accepted, not broken — it is just unsupported by anything else in
 * that request.
 */

/** What {@link sanitizeChatGptBackendBody} actually changed, for logging. */
export interface ChatGptBackendBodySanitation {
	/** Top-level fields removed because the backend 400s on them. */
	readonly droppedParams: readonly ChatGptBackendRejectedParam[];
	/** Present only when `reasoning.effort` was rewritten. */
	readonly clampedEffort?: { readonly from: string; readonly to: string };
}

/**
 * Apply the ChatGPT/Codex backend compatibility fixes we KNOW about to a parsed
 * Responses body, IN PLACE, and report what changed so the caller can log it.
 * Deliberately not a guarantee of acceptance: the denylist above is incomplete
 * by design, so a body this returns can still be refused by a rule we have not
 * met yet — that 400 is how the next entry gets found.
 *
 * Callers MUST have established that the request really reaches that backend
 * (see `targetsChatGptCodexBackend` in `provider.ts`) — this helper knows about
 * bodies, not about accounts or endpoint selection, and applying it to a custom
 * endpoint would remove parameters that endpoint may well accept.
 *
 * Never throws for the bodies it is built for — plain objects straight out of
 * `JSON.parse` — because it sits on request paths whose contract is "never fail
 * the request over a parameter we merely wanted to fix up". It mutates in
 * place, so a frozen, sealed or proxied object is out of contract. A non-object
 * `reasoning` (string, array, null) is left exactly as the client sent it.
 */
export function sanitizeChatGptBackendBody(
	body: Record<string, unknown>,
): ChatGptBackendBodySanitation {
	const droppedParams: ChatGptBackendRejectedParam[] = [];
	for (const param of REJECTED_TOP_LEVEL_PARAMS) {
		// Presence, not truthiness: `temperature: 0` is a deliberate client choice
		// and `user: ""` is falsy, yet the backend rejects the parameter for being
		// there at all.
		if (!Object.hasOwn(body, param)) continue;
		delete body[param];
		droppedParams.push(param);
	}

	const reasoning = body.reasoning;
	if (
		typeof reasoning === "object" &&
		reasoning !== null &&
		!Array.isArray(reasoning)
	) {
		const record = reasoning as Record<string, unknown>;
		const effort = record.effort;
		if (typeof effort === "string") {
			// The body's own `model` picks the generation: on this path the client
			// names the exact backend slug and the proxy forwards it unchanged.
			const model = typeof body.model === "string" ? body.model : undefined;
			const clamped = clampChatGptBackendReasoningEffort(effort, model);
			if (clamped !== effort) {
				record.effort = clamped;
				return { droppedParams, clampedEffort: { from: effort, to: clamped } };
			}
		}
	}

	return { droppedParams };
}
