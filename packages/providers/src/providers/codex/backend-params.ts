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

/** Reasoning efforts the ChatGPT/Codex backend accepts, ascending. */
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
 * Every reasoning effort we know of, ascending by how much reasoning it buys —
 * including the two the backend rejects (`minimal`, `max`), which is precisely
 * what lets them be clamped to a neighbour instead of being sent as-is.
 * `none` sorts below `minimal`: no reasoning at all is less than the least.
 */
const KNOWN_EFFORTS_ASCENDING = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

const ACCEPTED = new Set<string>(CHATGPT_BACKEND_REASONING_EFFORTS);

/**
 * Coerce a `reasoning.effort` value into something the ChatGPT/Codex backend
 * accepts:
 *  - an accepted value is returned unchanged (`none` is PRESERVED — it is the
 *    cheapest accepted value, not an absence),
 *  - a known-but-rejected value clamps to the nearest accepted value at or
 *    below it (`minimal` → `none`, `max` → `xhigh`),
 *  - anything we do not recognise is returned untouched, so a value the backend
 *    learns to accept before we do is not silently rewritten.
 *
 * Never throws: callers sit on request paths whose contract is "never fail the
 * request over a parameter we merely wanted to fix up".
 */
export function clampChatGptBackendReasoningEffort(effort: string): string {
	if (ACCEPTED.has(effort)) return effort;
	const rank = KNOWN_EFFORTS_ASCENDING.indexOf(
		effort as (typeof KNOWN_EFFORTS_ASCENDING)[number],
	);
	if (rank < 0) return effort;
	for (let i = rank - 1; i >= 0; i--) {
		const candidate = KNOWN_EFFORTS_ASCENDING[i];
		if (ACCEPTED.has(candidate)) return candidate;
	}
	// Below every accepted value (unreachable today: `none` is both accepted and
	// the floor) — clamp UP to the cheapest accepted value rather than sending
	// something the backend rejects.
	return CHATGPT_BACKEND_REASONING_EFFORTS[0];
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
			const clamped = clampChatGptBackendReasoningEffort(effort);
			if (clamped !== effort) {
				record.effort = clamped;
				return { droppedParams, clampedEffort: { from: effort, to: clamped } };
			}
		}
	}

	return { droppedParams };
}
