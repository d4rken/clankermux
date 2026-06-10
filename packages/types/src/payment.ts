/**
 * Types for the per-account payments ledger (`account_payments` table):
 * subscription renewals (auto-recorded from each account's renewal config or
 * entered manually) plus ad-hoc usage-credit purchases. Amounts are stored as
 * integer USD micros (1 USD = 1_000_000) so ledger math stays exact; the API
 * boundary speaks USD floats via the converters below.
 */

export type PaymentKind = "subscription" | "credits";
export type PaymentSource = "auto" | "manual" | "backfill";

// Database row type matching the account_payments schema
export interface AccountPaymentRow {
	id: string;
	account_id: string;
	account_name: string;
	kind: string;
	paid_date: string;
	paid_at_ms: number;
	amount_usd_micros: number;
	recorded_at: number;
	source: string;
	import_key: string | null;
	notes: string | null;
	deleted_at: number | null;
}

// API/domain model — what clients receive for a single ledger entry
export interface AccountPayment {
	id: string;
	accountId: string;
	accountName: string;
	kind: PaymentKind;
	paidDate: string;
	paidAtMs: number;
	amountUsd: number;
	recordedAt: number;
	source: PaymentSource;
	notes: string | null;
}

/** Convert a USD float to integer micros (1 USD = 1_000_000). */
export function usdToMicros(usd: number): number {
	return Math.round(usd * 1_000_000);
}

/** Convert integer micros back to a USD float. */
export function microsToUsd(micros: number): number {
	return micros / 1_000_000;
}

export function toAccountPayment(row: AccountPaymentRow): AccountPayment {
	return {
		id: row.id,
		accountId: row.account_id,
		accountName: row.account_name,
		kind: row.kind as PaymentKind,
		paidDate: row.paid_date,
		paidAtMs: row.paid_at_ms,
		amountUsd: microsToUsd(row.amount_usd_micros),
		recordedAt: row.recorded_at,
		source: row.source as PaymentSource,
		notes: row.notes,
	};
}

// ---------------------------------------------------------------------------
// Payments summary API response types (GET /api/payments/summary)
// ---------------------------------------------------------------------------

export interface PaymentsSummaryPerAccount {
	accountId: string;
	accountName: string;
	priceUsd: number | null;
	cadence: string | null;
	nextDueDate: string | null;
	amortizedMonthlyUsd: number;
	rangeLedgerUsd: number;
	rangeTokenCostUsd: number;
}

export interface PaymentsSummary {
	amortizedDailyUsd: number;
	amortizedWeeklyUsd: number;
	amortizedMonthlyUsd: number;
	currentMonth: {
		ledgerUsd: number;
		subscriptionUsd: number;
		creditsUsd: number;
		tokenCostUsd: number;
		totalUsd: number;
	};
	range: {
		from: number;
		to: number;
		days: number;
		ledgerUsd: number;
		subscriptionUsd: number;
		creditsUsd: number;
		tokenCostUsd: number;
		totalUsd: number;
		amortizedUsd: number;
		planValueUsd: number;
		valueRatio: number | null;
		overageTokenCostUsd: number;
	};
	perAccount: PaymentsSummaryPerAccount[];
	recentPayments: AccountPayment[];
}
