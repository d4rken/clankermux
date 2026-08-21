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
 * Format a real-money USD amount with grouping and exactly 2 decimals:
 * 200 -> "$200.00", 1234.5 -> "$1,234.50". Use for ledger/subscription
 * payments and for aggregates of token cost; keep `formatCost` (4 decimals)
 * for single-request figures, where a sub-cent difference is the whole point.
 *
 * An amount whose magnitude is nonzero but rounds to nothing reads as
 * "<$0.01" rather than "$0.00". Several callers pass money derived from token
 * costs — cache savings, a month's token spend, one account's API overage —
 * where a few tenths of a cent is a real charge, and rendering it as a flat
 * zero is not a rounding, it is a different claim. Exact zero still reads
 * "$0.00", and nothing at or above a cent changes value.
 *
 * Negatives read "-$12.30" and "-<$0.01": the cache-keepalive net tile goes
 * negative and colours itself red when it does, so the sign is load-bearing.
 */
export function formatUsd(amount: number): string {
	// Sign outside the symbol, and the guard applied to the magnitude, so a
	// negative behaves as the mirror of a positive rather than as a separate
	// case. Formatting the signed value directly puts the minus INSIDE
	// ("$-12.30") and leaves -0.004 rendering as "$-0.00" — a nonzero net cost
	// shown as nothing, which is the same defect this guard exists to stop.
	// Object.is picks up a negative zero, which is a zero and must not wear a
	// sign.
	const sign = amount < 0 ? "-" : "";
	const magnitude = Object.is(amount, -0) ? 0 : Math.abs(amount);
	if (magnitude > 0 && magnitude < 0.005) return `${sign}<$0.01`;
	return `${sign}$${magnitude.toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;
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
 * Format tokens per second with 1 decimal place. When `approximate` is true
 * (the value came from the total-duration fallback rather than the streaming
 * window) the result is prefixed with a tilde, e.g. "~36.0 tok/s".
 */
export function formatTokensPerSecond(
	tokensPerSecond?: number | null,
	approximate?: boolean,
): string {
	if (!tokensPerSecond || tokensPerSecond === 0) return "0 tok/s";
	const formatted = `${tokensPerSecond.toFixed(1)} tok/s`;
	return approximate ? `~${formatted}` : formatted;
}

/**
 * Compact token-count formatting for chip labels: 1500 -> "1.5k", 8000 -> "8k",
 * 32000 -> "32k", 1000000 -> "1M". Values under 1000 stay plain numbers.
 */
function formatCompactCount(n: number): string {
	const trim = (s: string) => s.replace(/\.0$/, "");
	if (n >= 1_000_000) return `${trim((n / 1_000_000).toFixed(1))}M`;
	if (n >= 1_000) {
		const thousands = n / 1_000;
		return thousands < 10
			? `${trim(thousands.toFixed(1))}k`
			: `${Math.round(thousands)}k`;
	}
	return `${n}`;
}

/**
 * Format a per-request reasoning-effort value for display:
 *   - "thinking:<budget_tokens>" (Anthropic) -> "32k thinking"
 *   - "thinking" (Anthropic, no budget)      -> "thinking"
 *   - anything else (raw OpenAI effort)      -> unchanged, e.g. "high"
 */
export function formatReasoningEffort(value: string): string {
	const match = value.match(/^thinking:(\d+)$/);
	if (match) return `${formatCompactCount(Number(match[1]))} thinking`;
	return value;
}

/**
 * Format billing type label
 */
export function formatBillingType(billingType?: string): string {
	if (billingType === "plan") return "Plan";
	if (billingType === "overage") return "Overage";
	return "API";
}
