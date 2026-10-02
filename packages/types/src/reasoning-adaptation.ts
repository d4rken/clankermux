import { decodeAuditRecord, encodeAuditRecord } from "./attempt-audit-codec";

/**
 * What one dispatch did to the client's reasoning effort, carried from the
 * provider that serialized the upstream body to the attempt row that records it.
 *
 * Three fields rather than a boolean, because "we changed it" is only half the
 * story and the other half is what the client asked for in the first place:
 *
 * - `requested` — the CLIENT's intent, expressed in the outgoing vocabulary.
 *   NULL means the client expressed no reasoning effort at all, which is NOT
 *   the same as expressing one that survived unchanged.
 * - `effective` — the effort actually serialized upstream. NULL means none was
 *   sent, so the backend applies whatever default it has. We never fill this in
 *   with a guess at that default: recording one would put a value in the row
 *   that neither the client nor the proxy ever chose.
 * - `reason` — why the two differ, NULL when they do not. `requested` NULL with
 *   a non-NULL `effective` is the proxy-supplied case and carries
 *   {@link REASONING_EFFORT_PROXY_DEFAULT}.
 *
 * Distinct from `requests.reasoning_effort`, which is REQUEST-level intent in a
 * different vocabulary (`thinking:24000` from an Anthropic-shaped body). One
 * request can dispatch several attempts against different backends, each of
 * which can legitimately end up with a different effective effort, so the
 * request row cannot hold this.
 */
export interface ReasoningEffortAdaptation {
	readonly requested: string | null;
	readonly effective: string | null;
	readonly reason: string | null;
}

/** The target backend does not accept the requested value for the target model. */
export const REASONING_EFFORT_BACKEND_CLAMP = "chatgpt_backend_clamp";
/** The target model's own effort profile has no such level. */
export const REASONING_EFFORT_TARGET_MODEL_PROFILE = "target_model_profile";
/** The client asked for nothing and the proxy picked the value it sent. */
export const REASONING_EFFORT_PROXY_DEFAULT = "proxy_default";
/** Separator for a difference that several mechanisms contributed to. */
export const REASONING_EFFORT_REASON_SEPARATOR = "+";

/**
 * Per-attempt channel from `transformRequestBody` to the attempt row. A header
 * rather than a side-channel keyed on the Request object: the request is
 * rebuilt several times between the provider transform and the dispatch
 * (native-flag strip, cache_control pre-strip, cache_control retry), each
 * rebuild carries the headers over unchanged, and the outbound sweep in
 * request-handler.ts removes every `x-clankermux-*` header before the fetch, so
 * this never reaches a backend.
 *
 * It is an ORDINARY inbound header name, so proxy-operations.ts deletes it from
 * the client's headers before the transform for the same reason it deletes the
 * synthetic-response markers: only the provider may set it.
 */
export const REASONING_EFFORT_ADAPTATION_HEADER =
	"x-clankermux-reasoning-effort";

const KEYS = ["requested", "effective", "reason"] as const;

/**
 * Encode for the header, or null when there is nothing to record (no effort
 * requested, none sent, nothing adapted) and the header should stay absent.
 */
export function encodeReasoningEffortAdaptation(
	adaptation: ReasoningEffortAdaptation,
): string | null {
	return encodeAuditRecord(KEYS, adaptation);
}

/** Inverse of {@link encodeReasoningEffortAdaptation}; null on anything unreadable. */
export function decodeReasoningEffortAdaptation(
	value: string | null | undefined,
): ReasoningEffortAdaptation | null {
	return decodeAuditRecord(KEYS, value);
}

/** Read the adaptation a provider attached to an outgoing request. */
export function readReasoningEffortAdaptation(
	headers: Headers,
): ReasoningEffortAdaptation | null {
	return decodeReasoningEffortAdaptation(
		headers.get(REASONING_EFFORT_ADAPTATION_HEADER),
	);
}

/**
 * Set the header, or remove it when there is nothing to record. Always one or
 * the other: a client can send this header name itself, and a provider that
 * only ever set it would let a forged value survive onto the attempt row.
 */
export function applyReasoningEffortAdaptation(
	headers: Headers,
	adaptation: ReasoningEffortAdaptation,
): void {
	const encoded = encodeReasoningEffortAdaptation(adaptation);
	if (encoded === null) headers.delete(REASONING_EFFORT_ADAPTATION_HEADER);
	else headers.set(REASONING_EFFORT_ADAPTATION_HEADER, encoded);
}
