import type { ChatRequirements } from "@clankermux/types";

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

/**
 * The first recorded Chat field `provider` cannot take. A turn the SDK bridge
 * serves goes through the bridge's own field policy instead, which reads the
 * translated Messages body the same way for Chat and Responses.
 */
export function unsupportedChatField(
	provider: string,
	requirements: ChatRequirements,
): string | null {
	return provider === "codex" ? (requirements.fields[0] ?? null) : null;
}
