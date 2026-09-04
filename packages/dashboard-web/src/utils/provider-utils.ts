/**
 * Utility functions for provider-specific logic in the web UI
 */
import {
	getDefaultEndpoint,
	isKnownProvider,
	PROVIDER_NAMES,
	requiresSessionDurationTracking,
} from "@clankermux/types";

/**
 * `providerDisplayName` moved to `@clankermux/core` (`provider-display.ts`).
 * Servable-class labels are derived from it and are now published on the wire,
 * so the map has to be readable from the server. Import it from core directly;
 * this module deliberately does not re-export it, so there is one path to it.
 */

/**
 * Check if a provider supports auto-fallback and auto-refresh features
 * Currently only Anthropic OAuth accounts support these features
 */
export function providerSupportsAutoFeatures(provider: string): boolean {
	return (
		provider === PROVIDER_NAMES.ANTHROPIC ||
		provider === PROVIDER_NAMES.CODEX ||
		provider === PROVIDER_NAMES.ZAI
	);
}

/**
 * Check if a provider supports custom billing type configuration
 * (anthropic-compatible and openai-compatible providers)
 */
export function providerSupportsCustomBilling(provider: string): boolean {
	return (
		provider === PROVIDER_NAMES.ANTHROPIC_COMPATIBLE ||
		provider === PROVIDER_NAMES.OPENAI_COMPATIBLE
	);
}

/**
 * Check if a provider shows quota-window usage information on the account page.
 * Anthropic and Codex show 5-hour and 7-day windows,
 * and Zai exposes time/token quota windows.
 */
/**
 * Check if a provider uses session-based usage windows (e.g. Anthropic 5h, Codex 5h).
 * Only these providers should show the session token breakdown on account cards.
 */
export function providerHasSessionWindow(provider: string): boolean {
	return requiresSessionDurationTracking(provider);
}

export function providerShowsWeeklyUsage(provider: string): boolean {
	return (
		provider === PROVIDER_NAMES.ANTHROPIC ||
		provider === PROVIDER_NAMES.CODEX ||
		provider === PROVIDER_NAMES.ZAI
	);
}

/**
 * Check if a provider shows a credit balance (USD remaining) instead of utilization windows
 */
export function providerShowsCreditsBalance(provider: string): boolean {
	return provider === PROVIDER_NAMES.KILO;
}

/**
 * Check if a provider supports custom endpoints
 */
export function providerSupportsCustomEndpoints(provider: string): boolean {
	// Most providers support custom endpoints, but we can add specific logic if needed
	return isKnownProvider(provider);
}

/**
 * Get the default endpoint for a provider
 */
export function getDefaultEndpointForProvider(provider: string): string {
	return getDefaultEndpoint(provider);
}

/**
 * Check if a given timestamp (default: now) falls within Zai peak hours.
 * Zai peak hours are 14:00–18:00 Singapore time (UTC+8).
 */
export function isZaiPeakHour(ts?: number): boolean {
	const d = new Date(ts ?? Date.now());
	// Convert to UTC+8 hour
	const utcHour = d.getUTCHours() + d.getUTCMinutes() / 60;
	const sgtHour = (utcHour + 8) % 24;
	return sgtHour >= 14 && sgtHour < 18;
}
