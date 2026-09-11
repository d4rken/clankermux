import type { ChatRequirements } from "@clankermux/types";
/** Conversion support only; this never grants account/model permissions. */
export function supportsChatIngress(provider: string): boolean {
	return provider === "codex" || provider === "openrouter";
}
export function unsupportedChatField(
	provider: string,
	requirements: ChatRequirements,
): string | null {
	return provider === "codex" ? (requirements.fields[0] ?? null) : null;
}
