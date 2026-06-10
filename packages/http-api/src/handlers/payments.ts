/**
 * Payments ledger API handlers:
 *  - GET  /api/payments/summary — spend/plan-value summary. The heavy
 *    `requests`-table cost scans run inside the shared read-only dashboard
 *    worker (kind "payments-summary", see payments-summary-direct.ts /
 *    analytics-runner.ts); this module only does pure assembly (computeRenewal,
 *    amortization math) on the returned aggregates.
 *  - POST /api/payments — manual subscription/credits entry.
 *  - POST /api/payments/seed — bulk backfill (all-or-nothing validation).
 *  - DELETE /api/payments/:id — soft delete.
 */
import { computeRenewal } from "@clankermux/core/renewal";
import type { DatabaseOperations } from "@clankermux/database";
import {
	BadRequest,
	errorResponse,
	InternalServerError,
	jsonResponse,
	NotFound,
} from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import type {
	AccountPaymentRow,
	PaymentKind,
	PaymentsSummary,
	PaymentsSummaryPerAccount,
} from "@clankermux/types";
import { microsToUsd, toAccountPayment, usdToMicros } from "@clankermux/types";
import type { APIContext } from "../types";
import { createIsolatedPaymentsSummaryDataHandler } from "./analytics-runner";
import type { PaymentsSummaryData } from "./payments-summary-direct";

const log = new Logger("PaymentsHandler");

const DAY_MS = 86_400_000;
/** Floor for range-day math so a zero-width window can't divide by zero. */
const MIN_RANGE_DAYS = 1 / 24;
/** Months are amortized at 30 days; weeks at 7 of those days. */
const AMORTIZATION_DAYS_PER_MONTH = 30;

// ---------------------------------------------------------------------------
// Shared validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate a YYYY-MM-DD payment date (zero-padded, real calendar day — same
 * idiom as the renewal handler). Returns the normalized string or null.
 */
function parsePaidDate(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const raw = value.trim();
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
	if (!match) return null;
	const y = Number(match[1]);
	const m = Number(match[2]);
	const d = Number(match[3]);
	const parsed = new Date(Date.UTC(y, m - 1, d));
	const isRealDate =
		parsed.getUTCFullYear() === y &&
		parsed.getUTCMonth() === m - 1 &&
		parsed.getUTCDate() === d;
	return isRealDate ? raw : null;
}

/** Validate a strictly-positive finite USD amount. Returns null when invalid. */
function parseAmountUsd(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return null;
	}
	return value;
}

function parseKind(value: unknown): PaymentKind | null {
	return value === "subscription" || value === "credits" ? value : null;
}

/** Local "YYYY-MM-DD" for a Date (renewal dates are local-calendar). */
function formatLocalDate(d: Date): string {
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// GET /api/payments/summary
// ---------------------------------------------------------------------------

function sumKind(
	rows: { kind: string; total_micros: number }[],
	kind: PaymentKind,
): number {
	const row = rows.find((r) => r.kind === kind);
	return microsToUsd(row?.total_micros ?? 0);
}

/** Monthly amortization for one account's price/cadence, in USD. */
function amortizedMonthlyFor(
	priceUsdMicros: number | null,
	cadence: string | null,
): number {
	if (priceUsdMicros == null || priceUsdMicros <= 0) return 0;
	const priceUsd = microsToUsd(priceUsdMicros);
	if (cadence === "monthly") return priceUsd;
	if (cadence === "yearly") return priceUsd / 12;
	return 0;
}

/** Pure assembly of the API response shape from the worker's raw aggregates. */
export function assemblePaymentsSummary(
	data: PaymentsSummaryData,
): PaymentsSummary {
	const ledgerByAccount = new Map(
		data.perAccountLedgerMicros.map((r) => [r.account_id, r.total_micros]),
	);
	const tokenCostByAccount = new Map(
		data.perAccountTokenCostUsd.map((r) => [r.accountId, r.costUsd]),
	);
	const snapshotNames = new Map(
		data.ledgerAccountNames.map((r) => [r.accountId, r.accountName]),
	);

	// Per-account: every account that has a price, plus every account (live or
	// deleted) with ledger rows in range. Deleted accounts surface under their
	// snapshotted ledger name.
	const perAccount: PaymentsSummaryPerAccount[] = [];
	const seen = new Set<string>();
	let amortizedMonthlyUsd = 0;

	for (const config of data.renewalConfigs) {
		const monthly = amortizedMonthlyFor(
			config.renewal_price_usd_micros,
			config.renewal_cadence,
		);
		amortizedMonthlyUsd += monthly;

		const hasPrice =
			config.renewal_price_usd_micros != null &&
			config.renewal_price_usd_micros > 0;
		const hasLedger = ledgerByAccount.has(config.id);
		if (!hasPrice && !hasLedger) continue;

		const renewal = computeRenewal(
			config.renewal_anchor,
			config.renewal_cadence as "monthly" | "yearly" | "none" | null,
			data.nowMs,
		);
		perAccount.push({
			accountId: config.id,
			accountName: config.name,
			priceUsd: hasPrice
				? microsToUsd(config.renewal_price_usd_micros as number)
				: null,
			cadence: config.renewal_cadence,
			nextDueDate: renewal.nextDate ? formatLocalDate(renewal.nextDate) : null,
			amortizedMonthlyUsd: monthly,
			rangeLedgerUsd: microsToUsd(ledgerByAccount.get(config.id) ?? 0),
			rangeTokenCostUsd: tokenCostByAccount.get(config.id) ?? 0,
		});
		seen.add(config.id);
	}

	// Orphaned ledger rows (account removed since payment was recorded).
	for (const [accountId, micros] of ledgerByAccount) {
		if (seen.has(accountId)) continue;
		perAccount.push({
			accountId,
			accountName: snapshotNames.get(accountId) ?? accountId,
			priceUsd: null,
			cadence: null,
			nextDueDate: null,
			amortizedMonthlyUsd: 0,
			rangeLedgerUsd: microsToUsd(micros),
			rangeTokenCostUsd: tokenCostByAccount.get(accountId) ?? 0,
		});
	}

	perAccount.sort((a, b) => a.accountName.localeCompare(b.accountName));

	const amortizedDailyUsd = amortizedMonthlyUsd / AMORTIZATION_DAYS_PER_MONTH;
	const amortizedWeeklyUsd = amortizedDailyUsd * 7;

	const monthSubscriptionUsd = sumKind(
		data.currentMonth.ledgerByKind,
		"subscription",
	);
	const monthCreditsUsd = sumKind(data.currentMonth.ledgerByKind, "credits");
	const monthLedgerUsd = monthSubscriptionUsd + monthCreditsUsd;

	const rangeSubscriptionUsd = sumKind(
		data.rangeWindow.ledgerByKind,
		"subscription",
	);
	const rangeCreditsUsd = sumKind(data.rangeWindow.ledgerByKind, "credits");
	const rangeLedgerUsd = rangeSubscriptionUsd + rangeCreditsUsd;

	const { from, to } = data.range;
	const days = Math.max((to - from) / DAY_MS, MIN_RANGE_DAYS);
	const amortizedUsd = amortizedDailyUsd * days;

	return {
		amortizedDailyUsd,
		amortizedWeeklyUsd,
		amortizedMonthlyUsd,
		currentMonth: {
			ledgerUsd: monthLedgerUsd,
			subscriptionUsd: monthSubscriptionUsd,
			creditsUsd: monthCreditsUsd,
			tokenCostUsd: data.currentMonth.costs.tokenCostUsd,
			totalUsd: monthLedgerUsd + data.currentMonth.costs.tokenCostUsd,
		},
		range: {
			from,
			to,
			days,
			ledgerUsd: rangeLedgerUsd,
			subscriptionUsd: rangeSubscriptionUsd,
			creditsUsd: rangeCreditsUsd,
			tokenCostUsd: data.rangeWindow.costs.tokenCostUsd,
			totalUsd: rangeLedgerUsd + data.rangeWindow.costs.tokenCostUsd,
			amortizedUsd,
			planValueUsd: data.rangeWindow.costs.planValueUsd,
			valueRatio:
				amortizedUsd > 0
					? data.rangeWindow.costs.planValueUsd / amortizedUsd
					: null,
			overageTokenCostUsd: data.rangeWindow.costs.overageTokenCostUsd,
		},
		perAccount,
		recentPayments: data.recentPayments.map(toAccountPayment),
	};
}

/**
 * Create the GET /api/payments/summary handler. Dispatches the data
 * collection through the read-only dashboard worker, then assembles the
 * response shape on the main thread.
 */
export function createPaymentsSummaryHandler(context: APIContext) {
	const dataHandler = createIsolatedPaymentsSummaryDataHandler(context);
	return async (params: URLSearchParams): Promise<Response> => {
		try {
			const dataResponse = await dataHandler(params);
			if (!dataResponse.ok) return dataResponse;
			const data = (await dataResponse.json()) as PaymentsSummaryData;
			const summary = assemblePaymentsSummary(data);
			// Propagate the worker/worker-cache mode marker for observability.
			const mode = dataResponse.headers.get("X-ClankerMux-Analytics-Mode");
			return jsonResponse(
				summary,
				200,
				mode ? { "X-ClankerMux-Analytics-Mode": mode } : undefined,
			);
		} catch (error) {
			log.error("Payments summary error:", error);
			return errorResponse(
				InternalServerError("Failed to fetch payments summary"),
			);
		}
	};
}

// ---------------------------------------------------------------------------
// POST /api/payments
// ---------------------------------------------------------------------------

/** Fetch the live row a manual entry just created/updated, for the response. */
async function findPaymentRow(
	dbOps: DatabaseOperations,
	accountId: string,
	kind: PaymentKind,
	paidDate: string,
): Promise<AccountPaymentRow | null> {
	const row = await dbOps.getAdapter().get<AccountPaymentRow>(
		`
		SELECT * FROM account_payments
		WHERE account_id = ? AND kind = ? AND paid_date = ? AND deleted_at IS NULL
		ORDER BY recorded_at DESC
		LIMIT 1
	`,
		[accountId, kind, paidDate],
	);
	return row ?? null;
}

export function createPaymentCreateHandler(dbOps: DatabaseOperations) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await req.json();

			const kind = parseKind(body.kind);
			if (!kind) {
				return errorResponse(
					BadRequest("kind must be 'subscription' or 'credits'"),
				);
			}

			const paidDate = parsePaidDate(body.paidDate);
			if (!paidDate) {
				return errorResponse(
					BadRequest("paidDate must be a valid YYYY-MM-DD date"),
				);
			}

			const amountUsd = parseAmountUsd(body.amountUsd);
			if (amountUsd === null) {
				return errorResponse(
					BadRequest("amountUsd must be a positive finite number"),
				);
			}

			let notes: string | null = null;
			if (body.notes !== null && body.notes !== undefined) {
				if (typeof body.notes !== "string" || body.notes.length > 2000) {
					return errorResponse(
						BadRequest("notes must be a string of at most 2000 characters"),
					);
				}
				notes = body.notes.trim() || null;
			}

			const accountId =
				typeof body.accountId === "string" ? body.accountId : "";
			const account = await dbOps
				.getAdapter()
				.get<{ name: string }>("SELECT name FROM accounts WHERE id = ?", [
					accountId,
				]);
			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			const amountUsdMicros = usdToMicros(amountUsd);
			if (kind === "subscription") {
				await dbOps.upsertSubscriptionPayment(
					accountId,
					account.name,
					paidDate,
					amountUsdMicros,
					"manual",
					notes,
				);
			} else {
				await dbOps.insertCreditPayment(
					accountId,
					account.name,
					paidDate,
					amountUsdMicros,
					"manual",
					notes,
					null,
				);
			}

			const row = await findPaymentRow(dbOps, accountId, kind, paidDate);
			return jsonResponse(
				{
					success: true,
					payment: row ? toAccountPayment(row) : null,
				},
				201,
			);
		} catch (error) {
			log.error("Payment create error:", error);
			return errorResponse(
				error instanceof Error ? error : new Error("Failed to record payment"),
			);
		}
	};
}

// ---------------------------------------------------------------------------
// POST /api/payments/seed
// ---------------------------------------------------------------------------

interface SeedRow {
	accountId: string;
	accountName: string;
	kind: PaymentKind;
	paidDate: string;
	amountUsd: number;
	notes: string | null;
	importKey: string | null;
}

export function createPaymentsSeedHandler(dbOps: DatabaseOperations) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await req.json();
			const payments = body.payments;
			if (!Array.isArray(payments) || payments.length === 0) {
				return errorResponse(BadRequest("payments must be a non-empty array"));
			}

			// Resolve account names up front so existence is part of validation.
			const accountRows = await dbOps
				.getAdapter()
				.query<{ id: string; name: string }>(
					"SELECT id, name FROM accounts",
					[],
				);
			const accountNames = new Map(accountRows.map((a) => [a.id, a.name]));

			// Validate EVERY row before writing any (all-or-nothing).
			const validated: SeedRow[] = [];
			const badRows: { index: number; error: string }[] = [];
			for (let i = 0; i < payments.length; i++) {
				const raw = payments[i] as Record<string, unknown>;
				const fail = (error: string) => badRows.push({ index: i, error });

				const kind = parseKind(raw?.kind);
				const paidDate = parsePaidDate(raw?.paidDate);
				const amountUsd = parseAmountUsd(raw?.amountUsd);
				const accountId =
					typeof raw?.accountId === "string" ? raw.accountId : "";
				const accountName = accountNames.get(accountId);
				const importKey =
					typeof raw?.importKey === "string" && raw.importKey.trim()
						? raw.importKey.trim()
						: null;
				const notesRaw = raw?.notes;
				const notesValid =
					notesRaw == null ||
					(typeof notesRaw === "string" && notesRaw.length <= 2000);

				if (!kind) fail("kind must be 'subscription' or 'credits'");
				else if (!paidDate) fail("paidDate must be a valid YYYY-MM-DD date");
				else if (amountUsd === null)
					fail("amountUsd must be a positive finite number");
				else if (!accountName) fail("account not found");
				else if (kind === "credits" && !importKey)
					fail("importKey is required for credits rows");
				else if (!notesValid)
					fail("notes must be a string of at most 2000 characters");
				else {
					validated.push({
						accountId,
						accountName,
						kind,
						paidDate,
						amountUsd,
						notes:
							typeof notesRaw === "string" ? notesRaw.trim() || null : null,
						importKey,
					});
				}
			}

			if (badRows.length > 0) {
				const indices = badRows.map((b) => b.index).join(", ");
				return errorResponse(
					BadRequest(`Invalid payment rows at indices: ${indices}`, {
						rows: badRows,
					}),
				);
			}

			const countRows = async (): Promise<number> => {
				const row = await dbOps
					.getAdapter()
					.get<{ n: number }>("SELECT COUNT(*) as n FROM account_payments", []);
				return row?.n ?? 0;
			};

			const before = await countRows();
			for (const rowDef of validated) {
				const amountUsdMicros = usdToMicros(rowDef.amountUsd);
				if (rowDef.kind === "subscription") {
					await dbOps.upsertSubscriptionPayment(
						rowDef.accountId,
						rowDef.accountName,
						rowDef.paidDate,
						amountUsdMicros,
						"backfill",
						rowDef.notes,
					);
				} else {
					await dbOps.insertCreditPayment(
						rowDef.accountId,
						rowDef.accountName,
						rowDef.paidDate,
						amountUsdMicros,
						"backfill",
						rowDef.notes,
						rowDef.importKey,
					);
				}
			}
			const after = await countRows();

			const inserted = after - before;
			return jsonResponse({
				inserted,
				updated: validated.length - inserted,
			});
		} catch (error) {
			log.error("Payments seed error:", error);
			return errorResponse(
				error instanceof Error ? error : new Error("Failed to seed payments"),
			);
		}
	};
}

// ---------------------------------------------------------------------------
// DELETE /api/payments/:id
// ---------------------------------------------------------------------------

export function createPaymentDeleteHandler(dbOps: DatabaseOperations) {
	return async (paymentId: string): Promise<Response> => {
		try {
			const deleted = await dbOps.softDeletePayment(paymentId);
			if (!deleted) {
				return errorResponse(NotFound("Payment not found"));
			}
			return jsonResponse({ success: true, id: paymentId });
		} catch (error) {
			log.error("Payment delete error:", error);
			return errorResponse(
				error instanceof Error ? error : new Error("Failed to delete payment"),
			);
		}
	};
}
