import type { ChatRequirements } from "@clankermux/types";

/**
 * Chat fields a turn served through the SDK bridge honours. Claude Code picks
 * its own output limit, sampling and stop handling, so of the recorded fields
 * only replayed reasoning passes (the bridge drops unsigned thinking from
 * history, as it does for every client).
 */
const SDK_BRIDGE_CHAT_FIELDS: ReadonlySet<string> = new Set([
	"reasoning_content",
]);

/**
 * Conversion support only; this never grants account/model permissions.
 *
 * `viaSdkBridge`: the attempt is served by the SDK bridge, which answers in
 * Anthropic Messages form for an official Anthropic account. A direct send to
 * one never qualifies.
 */
export function supportsChatIngress(
	provider: string,
	viaSdkBridge = false,
): boolean {
	return viaSdkBridge || provider === "codex" || provider === "openrouter";
}

export function unsupportedChatField(
	provider: string,
	requirements: ChatRequirements,
	viaSdkBridge = false,
): string | null {
	if (viaSdkBridge)
		return (
			requirements.fields.find((f) => !SDK_BRIDGE_CHAT_FIELDS.has(f)) ??
			(requirements.forcesToolChoice ? "tool_choice" : null)
		);
	return provider === "codex" ? (requirements.fields[0] ?? null) : null;
}
