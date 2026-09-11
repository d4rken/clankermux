/** Local counting is a capability, not permission to use a model. */
export function supportsLocalTokenCounting(
	provider: string,
	customEndpoint?: string | null,
): boolean {
	return (
		provider === "devin" ||
		provider === "codex" ||
		(provider === "openrouter" && !customEndpoint)
	);
}

export const TOKEN_COUNT_SOURCE_HEADER = "x-clankermux-token-count-source";

export function localTokenCountUrl(provider: string): string {
	if (!supportsLocalTokenCounting(provider))
		throw new Error("Provider does not support local token counting");
	return `https://clankermux.local/${provider}/count_tokens`;
}

export function isLocalTokenCountUrl(value: string): boolean {
	try {
		const url = new URL(value);
		const provider = url.pathname.split("/")[1] ?? "";
		return (
			supportsLocalTokenCounting(provider) &&
			value === localTokenCountUrl(provider)
		);
	} catch {
		return false;
	}
}
