/**
 * Direct (in-process) data collector for GET /api/payments/summary.
 *
 * Runs every database read the summary needs — the potentially large
 * `requests`-table cost scans plus the small `account_payments` ledger
 * aggregates riding along for snapshot consistency — and returns the RAW
 * aggregates as JSON. In production this executes inside the shared read-only
 * dashboard worker (kind "payments-summary", see analytics-runner.ts /
 * analytics-worker.ts) so the synchronous bun:sqlite scans never block the
 * main event loop. The pure assembly (computeRenewal, amortization math) into
 * the PaymentsSummary response shape happens back on the main thread in
 * payments.ts.
 *
 * Cost predicates (over requests.cost_usd):
 *  - token-billed: COALESCE(billing_type,'api') != 'plan'
 *  - plan value:   billing_type = 'plan'
 *  - overage:      billing_type = 'overage'
 */
import { AccountPaymentRepository } from "@clankermux/database";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import type { AccountPaymentRow } from "@clankermux/types";
import type { APIContext } from "../types";
import { getRangeConfig } from "./range-config";

const log = new Logger("PaymentsSummaryDataHandler");

const ALLOWED_RANGES = ["1h", "6h", "24h", "7d", "30d", "all"] as const;
type Range = (typeof ALLOWED_RANGES)[number];
const DEFAULT_RANGE: Range = "30d";
const DAY_MS = 86_400_000;
const RECENT_PAYMENTS_LIMIT = 20;

function normalizeRange(raw: string | null): Range {
	if (raw && (ALLOWED_RANGES as readonly string[]).includes(raw)) {
		return raw as Range;
	}
	return DEFAULT_RANGE;
}

/** One window's cost splits over the requests table. */
export interface RequestCostSplits {
	/** Σ cost_usd where COALESCE(billing_type,'api') != 'plan'. */
	tokenCostUsd: number;
	/** Σ cost_usd where billing_type = 'plan'. */
	planValueUsd: number;
	/** Σ cost_usd where billing_type = 'overage'. */
	overageTokenCostUsd: number;
}

/**
 * Raw aggregates the worker returns; assembled into PaymentsSummary on the
 * main thread (payments.ts).
 */
export interface PaymentsSummaryData {
	nowMs: number;
	range: { range: Range; from: number; to: number };
	monthStartMs: number;
	currentMonth: {
		ledgerByKind: { kind: string; total_micros: number }[];
		costs: RequestCostSplits;
	};
	rangeWindow: {
		ledgerByKind: { kind: string; total_micros: number }[];
		costs: RequestCostSplits;
	};
	perAccountLedgerMicros: { account_id: string; total_micros: number }[];
	perAccountTokenCostUsd: { accountId: string; costUsd: number }[];
	/** Snapshotted names for ledger rows whose account may no longer exist. */
	ledgerAccountNames: { accountId: string; accountName: string }[];
	renewalConfigs: Array<{
		id: string;
		name: string;
		renewal_anchor: string | null;
		renewal_cadence: string | null;
		renewal_price_usd_micros: number | null;
	}>;
	recentPayments: AccountPaymentRow[];
}

export function createPaymentsSummaryDataHandler(context: APIContext) {
	const adapter = context.dbOps.getAdapter();
	const payments = new AccountPaymentRepository(adapter);

	async function requestCostSplits(
		fromMs: number,
		toMs: number,
	): Promise<RequestCostSplits> {
		const row = await adapter.get<{
			token_cost: number | null;
			plan_value: number | null;
			overage_cost: number | null;
		}>(
			`
			SELECT
				SUM(CASE WHEN COALESCE(billing_type, 'api') != 'plan' THEN COALESCE(cost_usd, 0) ELSE 0 END) as token_cost,
				SUM(CASE WHEN billing_type = 'plan' THEN COALESCE(cost_usd, 0) ELSE 0 END) as plan_value,
				SUM(CASE WHEN billing_type = 'overage' THEN COALESCE(cost_usd, 0) ELSE 0 END) as overage_cost
			FROM requests
			WHERE timestamp >= ? AND timestamp < ?
		`,
			[fromMs, toMs],
		);
		return {
			tokenCostUsd: row?.token_cost ?? 0,
			planValueUsd: row?.plan_value ?? 0,
			overageTokenCostUsd: row?.overage_cost ?? 0,
		};
	}

	return async (params: URLSearchParams): Promise<Response> => {
		try {
			const range = normalizeRange(params.get("range"));
			const now = Date.now();
			const { windowMs } = getRangeConfig(range);

			let from: number;
			if (windowMs !== null) {
				from = now - windowMs;
			} else {
				// range=all: earliest of (first request, first non-deleted payment),
				// falling back to now-30d when both are empty.
				const [reqRow, payRow] = await Promise.all([
					adapter.get<{ min_ts: number | null }>(
						"SELECT MIN(timestamp) as min_ts FROM requests",
						[],
					),
					adapter.get<{ min_ts: number | null }>(
						"SELECT MIN(paid_at_ms) as min_ts FROM account_payments WHERE deleted_at IS NULL",
						[],
					),
				]);
				const candidates = [reqRow?.min_ts, payRow?.min_ts].filter(
					(v): v is number => v != null,
				);
				from =
					candidates.length > 0 ? Math.min(...candidates) : now - 30 * DAY_MS;
			}
			const to = now;

			const monthStart = new Date(now);
			const monthStartMs = new Date(
				monthStart.getFullYear(),
				monthStart.getMonth(),
				1,
			).getTime();

			const [
				monthLedger,
				monthCosts,
				rangeLedger,
				rangeCosts,
				perAccountLedgerMicros,
				perAccountTokenRows,
				ledgerNameRows,
				renewalConfigs,
				recentPayments,
			] = await Promise.all([
				payments.sumByKindInRange(monthStartMs, to),
				requestCostSplits(monthStartMs, to),
				payments.sumByKindInRange(from, to),
				requestCostSplits(from, to),
				payments.sumByAccountInRange(from, to),
				adapter.query<{ account_used: string; cost_usd: number }>(
					`
					SELECT account_used, SUM(COALESCE(cost_usd, 0)) as cost_usd
					FROM requests
					WHERE timestamp >= ? AND timestamp < ?
						AND COALESCE(billing_type, 'api') != 'plan'
						AND account_used IS NOT NULL
					GROUP BY account_used
				`,
					[from, to],
				),
				adapter.query<{ account_id: string; account_name: string }>(
					`
					SELECT account_id, MAX(account_name) as account_name
					FROM account_payments
					WHERE deleted_at IS NULL AND paid_at_ms >= ? AND paid_at_ms < ?
					GROUP BY account_id
				`,
					[from, to],
				),
				adapter.query<{
					id: string;
					name: string;
					renewal_anchor: string | null;
					renewal_cadence: string | null;
					renewal_price_usd_micros: number | null;
				}>(
					`
					SELECT id, name, renewal_anchor, renewal_cadence, renewal_price_usd_micros
					FROM accounts
				`,
					[],
				),
				payments.findRecent(RECENT_PAYMENTS_LIMIT),
			]);

			const data: PaymentsSummaryData = {
				nowMs: now,
				range: { range, from, to },
				monthStartMs,
				currentMonth: { ledgerByKind: monthLedger, costs: monthCosts },
				rangeWindow: { ledgerByKind: rangeLedger, costs: rangeCosts },
				perAccountLedgerMicros,
				perAccountTokenCostUsd: perAccountTokenRows.map((r) => ({
					accountId: r.account_used,
					costUsd: r.cost_usd ?? 0,
				})),
				ledgerAccountNames: ledgerNameRows.map((r) => ({
					accountId: r.account_id,
					accountName: r.account_name,
				})),
				renewalConfigs,
				recentPayments,
			};
			return jsonResponse(data);
		} catch (error) {
			log.error("Payments summary data error:", error);
			return errorResponse(
				InternalServerError("Failed to fetch payments summary data"),
			);
		}
	};
}
