import type { ChatField, ChatRequirements } from "@clankermux/types";

/**
 * What one destination does with a recorded Chat field:
 * - `passed`: carried on, and the destination decides what to do with it.
 * - `ignored`: accepted and dropped; the attempt records it.
 * - `refused`: the destination is excluded from the route.
 */
export type ChatFieldTreatment = "passed" | "ignored" | "refused";
export type ChatFieldCapability = Readonly<
	Record<ChatField, ChatFieldTreatment>
>;

const CODEX: ChatFieldCapability = {
	max_tokens: "ignored",
	temperature: "ignored",
	top_p: "ignored",
	stop: "refused",
	reasoning_content: "refused",
	response_format: "passed",
};
const OPENROUTER: ChatFieldCapability = {
	max_tokens: "passed",
	temperature: "passed",
	top_p: "passed",
	stop: "passed",
	reasoning_content: "passed",
	response_format: "passed",
};
// The bridge's own field policy refuses what it cannot serve, reading the
// translated Messages body the same way for Chat and Responses.
const SDK_BRIDGE: ChatFieldCapability = {
	max_tokens: "passed",
	temperature: "ignored",
	top_p: "ignored",
	stop: "passed",
	reasoning_content: "passed",
	response_format: "refused",
};

/**
 * Conversion support only; this never grants account/model permissions. Null
 * when the destination has no Chat ingress.
 *
 * `viaSdkBridge`: the attempt is served by the SDK bridge, which answers in
 * Anthropic Messages form for an official Anthropic account. A direct send to
 * one never qualifies.
 */
export function chatFieldCapability(
	provider: string,
	viaSdkBridge = false,
): ChatFieldCapability | null {
	if (viaSdkBridge) return SDK_BRIDGE;
	if (provider === "codex") return CODEX;
	if (provider === "openrouter") return OPENROUTER;
	return null;
}

/** The first recorded field the destination refuses. */
export function refusedChatField(
	capability: ChatFieldCapability,
	requirements: ChatRequirements,
): ChatField | null {
	return (
		requirements.fields.find((field) => capability[field] === "refused") ?? null
	);
}

/** The recorded fields the destination accepts without applying, in order. */
export function ignoredChatFields(
	capability: ChatFieldCapability,
	requirements: ChatRequirements,
): ChatField[] {
	return requirements.fields.filter((field) => capability[field] === "ignored");
}
