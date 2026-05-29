import { Logger } from "@clankermux/logger";
import { PROVIDER_NAMES } from "@clankermux/types";

const log = new Logger("ProviderOverloadCooldown");

const DEFAULT_PROVIDER_OVERLOAD_COOLDOWN_MS = 60_000;
const MAX_PROVIDER_OVERLOAD_COOLDOWN_MS = 5 * 60_000;
export const ANTHROPIC_UPSTREAM_OVERLOAD_KEY = "anthropic-upstream";

const providerOverloadedUntil = new Map<string, number>();

function normalizeUntil(candidate: number | undefined, now: number): number {
	if (candidate && Number.isFinite(candidate) && candidate > now) {
		return Math.min(candidate, now + MAX_PROVIDER_OVERLOAD_COOLDOWN_MS);
	}
	return now + DEFAULT_PROVIDER_OVERLOAD_COOLDOWN_MS;
}

export function isOfficialAnthropicProvider(provider: string): boolean {
	return (
		provider === PROVIDER_NAMES.ANTHROPIC ||
		provider === PROVIDER_NAMES.CLAUDE_CONSOLE_API
	);
}

export function getProviderOverloadKey(provider: string): string {
	return isOfficialAnthropicProvider(provider)
		? ANTHROPIC_UPSTREAM_OVERLOAD_KEY
		: provider;
}

export function applyProviderOverloadCooldown(
	provider: string,
	resetTime?: number,
): number {
	const now = Date.now();
	const overloadKey = getProviderOverloadKey(provider);
	const until = normalizeUntil(resetTime, now);
	const previous = getProviderOverloadUntil(provider, now);
	const effectiveUntil = previous ? Math.max(previous, until) : until;

	providerOverloadedUntil.set(overloadKey, effectiveUntil);
	log.warn(
		`Provider ${overloadKey} temporarily unavailable due to upstream overload until ${new Date(effectiveUntil).toISOString()}`,
	);
	return effectiveUntil;
}

export function getProviderOverloadUntil(
	provider: string,
	now = Date.now(),
): number | null {
	const overloadKey = getProviderOverloadKey(provider);
	const until = providerOverloadedUntil.get(overloadKey);
	if (!until) return null;
	if (until <= now) {
		providerOverloadedUntil.delete(overloadKey);
		return null;
	}
	return until;
}

export function isProviderOverloaded(
	provider: string,
	now = Date.now(),
): boolean {
	return getProviderOverloadUntil(provider, now) !== null;
}

export function clearProviderOverloadCooldown(provider?: string): void {
	if (provider) {
		providerOverloadedUntil.delete(getProviderOverloadKey(provider));
		return;
	}
	providerOverloadedUntil.clear();
}
