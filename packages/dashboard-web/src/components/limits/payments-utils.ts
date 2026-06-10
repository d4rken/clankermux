import type { PaymentsSummaryPerAccount } from "@clankermux/types";

/**
 * Format a plan-value / amortized-spend ratio as "N.N×"; em-dash when the
 * ratio is unavailable (no subscription prices configured).
 */
export function formatValueRatio(ratio: number | null | undefined): string {
	if (ratio == null || !Number.isFinite(ratio)) return "—";
	return `${ratio.toFixed(1)}×`;
}

/**
 * Map account name → amortized monthly subscription cost, for joining the
 * payments summary onto the analytics per-account performance rows (which
 * carry only the account *name*, not the id). Accounts without a configured
 * price are omitted so callers can render an em-dash for them.
 */
export function amortizedMonthlyByAccountName(
	perAccount: PaymentsSummaryPerAccount[],
): Map<string, number> {
	const byName = new Map<string, number>();
	for (const entry of perAccount) {
		if (entry.priceUsd == null) continue;
		byName.set(
			entry.accountName,
			(byName.get(entry.accountName) ?? 0) + entry.amortizedMonthlyUsd,
		);
	}
	return byName;
}
