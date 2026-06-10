/**
 * Subscription-payment auto-recorder — a periodic job that books each
 * subscription account's renewal due dates into the `account_payments` ledger.
 *
 * Design notes:
 *  - An account is auto-recordable when its renewal anchor is set, its cadence
 *    is monthly/yearly, and its price is > 0. PAUSED accounts are deliberately
 *    NOT skipped — a paused subscription still costs money.
 *  - `renewal_auto_start_date` is the lower bound for due-date generation:
 *    occurrences before it are never auto-booked (historical rows come only
 *    from manual backfill). The API sets it whenever a price is set; if it is
 *    somehow null we defensively fall back to today so we never invent history.
 *  - Dedup is the DB's job: `recordPayment` is an INSERT OR IGNORE against the
 *    partial unique (account_id, paid_date) subscription index, which also
 *    covers soft-deleted tombstones — so re-offering an already-booked (or
 *    operator-deleted) due date is a no-op. No existence pre-checks here.
 *  - Each tick re-reads the configs (add/remove/price-change aware) and stamps
 *    one shared `now`; the clock is injectable for tests.
 *  - Per-account try/catch so one bad account can't abort the batch; one
 *    summary INFO line only when something was actually booked (the hourly
 *    steady-state tick is silent at INFO).
 */

import { intervalManager } from "@clankermux/core";
import { computeAllDueDates } from "@clankermux/core/renewal";
import { Logger } from "@clankermux/logger";

const log = new Logger("SubscriptionPaymentRecorder");

/**
 * Recording cadence (1 hour). Due dates only roll at local midnight, so hourly
 * is generous — it just bounds how stale the ledger can be after a restart.
 */
export const RECORD_INTERVAL_MS = 3_600_000;

/** One account's renewal config row (matches `getAccountRenewalConfigs`). */
export interface AccountRenewalConfig {
	id: string;
	name: string;
	renewal_anchor: string | null;
	renewal_cadence: string | null;
	renewal_price_usd_micros: number | null;
	renewal_auto_start_date: string | null;
	paused: number;
}

/** Dependencies the recorder needs from the host server. */
export interface SubscriptionPaymentRecorderDeps {
	/** Re-read the live renewal configs each tick (add/remove/price aware). */
	getRenewalConfigs: () => Promise<AccountRenewalConfig[]>;
	/**
	 * Book one due date (INSERT OR IGNORE); returns whether a row was actually
	 * inserted (false when already booked, incl. soft-deleted tombstones).
	 */
	recordPayment: (
		accountId: string,
		accountName: string,
		dueDate: string,
		amountUsdMicros: number,
		now: number,
	) => Promise<boolean>;
	/** Injectable clock (ms epoch) for deterministic tests. */
	now?: () => number;
}

/** Local "YYYY-MM-DD" of the day containing `ms` (same calendar as renewal). */
function localDateOf(ms: number): string {
	const d = new Date(ms);
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Periodic recorder. Each tick:
 *  1) stamps one shared `now`,
 *  2) re-reads the renewal configs,
 *  3) per auto-recordable account, offers every due date in
 *     [auto_start_date, today] to `recordPayment` (the DB dedups),
 *  4) logs each actual insert at DEBUG and one INFO summary when > 0.
 *
 * Registered through `intervalManager` with `maxConcurrent: 1` so a slow tick
 * can never overlap the next; `immediate: true` gives the startup catch-up
 * tick that books due dates missed while the server was down.
 */
export class SubscriptionPaymentRecorder {
	private readonly deps: SubscriptionPaymentRecorderDeps;
	private stopInterval: (() => void) | null = null;
	private readonly intervalId = "subscription-payment-recorder";

	constructor(deps: SubscriptionPaymentRecorderDeps) {
		this.deps = { ...deps };
		this.deps.now ??= Date.now;
	}

	/** Start the recorder: immediate catch-up tick, then hourly. */
	start(): void {
		log.info(
			`Subscription payment recorder starting: catch-up tick now, then every ${Math.round(RECORD_INTERVAL_MS / 60_000)}min`,
		);
		this.stopInterval = intervalManager.register({
			id: this.intervalId,
			callback: () => this.tick(),
			intervalMs: RECORD_INTERVAL_MS,
			immediate: true,
			maxConcurrent: 1,
			description: "Subscription payment auto-recorder (renewals ledger)",
		});
	}

	/** Stop the recorder: unregister the interval. */
	stop(): void {
		if (this.stopInterval) {
			this.stopInterval();
			this.stopInterval = null;
		}
	}

	/** One recording tick (exposed for tests / manual triggering). */
	async tick(): Promise<void> {
		const now = (this.deps.now ?? Date.now)();

		let configs: AccountRenewalConfig[];
		try {
			configs = await this.deps.getRenewalConfigs();
		} catch (err) {
			log.warn(`Payment recorder: failed to read renewal configs: ${err}`);
			return;
		}

		let insertedTotal = 0;
		for (const config of configs) {
			try {
				insertedTotal += await this.recordForAccount(config, now);
			} catch (err) {
				// One bad account must not abort the batch — log and move on.
				log.error(
					`Payment recorder: failed for account ${config.name} (${config.id}): ${err}`,
				);
			}
		}

		if (insertedTotal > 0) {
			log.info(
				`Payment recorder: booked ${insertedTotal} subscription renewal payment(s)`,
			);
		}
	}

	/** Book all unbooked due dates for one account; returns the insert count. */
	private async recordForAccount(
		config: AccountRenewalConfig,
		now: number,
	): Promise<number> {
		const anchor = config.renewal_anchor;
		const cadence = config.renewal_cadence;
		const price = config.renewal_price_usd_micros;

		// Auto-recordable gate. NOTE: `paused` is deliberately not consulted —
		// a paused subscription still renews and still costs money.
		if (!anchor) return 0;
		if (cadence !== "monthly" && cadence !== "yearly") return 0;
		if (typeof price !== "number" || !(price > 0)) return 0;

		// Lower bound: never auto-book due dates before the auto-start date.
		// Null is defensive (the API always sets it alongside a price) — fall
		// back to today so we never invent history.
		const fromDate = config.renewal_auto_start_date ?? localDateOf(now);

		const dueDates = computeAllDueDates(anchor, cadence, fromDate, now);

		let inserted = 0;
		for (const dueDate of dueDates) {
			const didInsert = await this.deps.recordPayment(
				config.id,
				config.name,
				dueDate,
				price,
				now,
			);
			if (didInsert) {
				inserted++;
				log.debug(
					`Payment recorder: booked ${config.name} renewal ${dueDate} (${price} usd-micros)`,
				);
			}
		}
		return inserted;
	}
}
