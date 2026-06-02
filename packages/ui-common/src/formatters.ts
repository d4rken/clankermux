import { TIME_CONSTANTS } from "@clankermux/core";

/**
 * Format duration in milliseconds to human-readable string
 */
export function formatDuration(ms: number): string {
	if (ms < TIME_CONSTANTS.SECOND) return `${ms}ms`;
	if (ms < TIME_CONSTANTS.MINUTE)
		return `${(ms / TIME_CONSTANTS.SECOND).toFixed(1)}s`;
	if (ms < TIME_CONSTANTS.HOUR)
		return `${(ms / TIME_CONSTANTS.MINUTE).toFixed(1)}m`;
	return `${(ms / TIME_CONSTANTS.HOUR).toFixed(1)}h`;
}

/**
 * Format tokens with locale-aware thousands separator
 */
export function formatTokens(tokens?: number): string {
	if (!tokens || tokens === 0) return "0";
	return tokens.toLocaleString();
}

/**
 * Format USD cost with 4 decimal places
 */
export function formatCost(cost?: number): string {
	if (!cost || cost === 0) return "$0.0000";
	return `$${cost.toFixed(4)}`;
}

/**
 * Format percentage with specified decimal places
 */
export function formatPercentage(value: number, decimals = 1): string {
	return `${value.toFixed(decimals)}%`;
}

/**
 * Format number with locale-aware thousands separator
 */
export function formatNumber(value: number): string {
	return value.toLocaleString();
}

/**
 * Format a byte count as a human-readable string using binary (1024) units:
 * "0 B", "512 B", "4.0 KB", "1.5 MB", "2.3 GB", … Whole bytes get no decimals;
 * larger units use `decimals` (default 1). Negative/zero/undefined → "0 B".
 */
export function formatBytes(bytes?: number, decimals = 1): string {
	if (!bytes || bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const exponent = Math.min(
		units.length - 1,
		Math.floor(Math.log(bytes) / Math.log(1024)),
	);
	const value = bytes / 1024 ** exponent;
	return `${exponent === 0 ? value : value.toFixed(decimals)} ${units[exponent]}`;
}

/**
 * Format timestamp to locale string
 */
export function formatTimestamp(timestamp: number | string): string {
	const date =
		typeof timestamp === "string" ? new Date(timestamp) : new Date(timestamp);
	return date.toLocaleString();
}

/**
 * Format tokens per second with 1 decimal place
 */
export function formatTokensPerSecond(tokensPerSecond?: number | null): string {
	if (!tokensPerSecond || tokensPerSecond === 0) return "0 tok/s";
	return `${tokensPerSecond.toFixed(1)} tok/s`;
}

/**
 * Format billing type label
 */
export function formatBillingType(billingType?: string): string {
	if (billingType === "plan") return "Plan";
	if (billingType === "overage") return "Overage";
	return "API";
}
