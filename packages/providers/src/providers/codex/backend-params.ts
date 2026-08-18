/**
 * What the ChatGPT/Codex backend (chatgpt.com/backend-api/codex/responses)
 * accepts in a Responses body, and how to coerce a client's value into it.
 *
 * Sibling of `native-ping.ts`, whose comment records the two rejections this
 * module encodes (verified live 2026-07, reproduced in production 2026-08):
 *  - `max_output_tokens` → 400 `{"detail":"Unsupported parameter: max_output_tokens"}`
 *  - `reasoning.effort: "minimal"` → 400 "Unsupported value: 'minimal' ...
 *    Supported values are: none, low, medium, high, xhigh"
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
