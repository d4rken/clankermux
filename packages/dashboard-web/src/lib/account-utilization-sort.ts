import {
	extractFiveHour,
	extractSevenDay,
	providerDisplayName,
} from "@clankermux/core";
import type { FullUsageData, StaleUsageInfo } from "@clankermux/types";
import { providerShowsWeeklyUsage } from "../utils/provider-utils";
import { classifyUsageCard, type UsageCardSource } from "./usage-windows";

/**
 * The sort orders the Account Utilization card offers, in the order the
 * `<Select>` lists them. The mode type is DERIVED from this tuple, so a mode
 * cannot exist in the type but be missing from the dropdown.
 */
export const ACCOUNT_UTILIZATION_SORT_MODES = [
	"utilization-desc",
	"utilization-asc",
	"reset",
	"name",
	"provider",
	"priority",
] as const;

export type AccountUtilizationSortMode =
	(typeof ACCOUNT_UTILIZATION_SORT_MODES)[number];

export const ACCOUNT_UTILIZATION_SORT_LABELS: Record<
	AccountUtilizationSortMode,
	string
> = {
	"utilization-desc": "Utilization (high to low)",
	"utilization-asc": "Utilization (low to high)",
	reset: "Soonest reset",
	name: "Name (A-Z)",
	provider: "Provider",
	priority: "Routing priority",
};

export const ACCOUNT_UTILIZATION_SORT_STORAGE_KEY =
	"clankermux-account-utilization-sort";

/** What the card falls back to with no stored (or a corrupt) preference. */
export const DEFAULT_ACCOUNT_UTILIZATION_SORT_MODE: AccountUtilizationSortMode =
	"utilization-desc";

/**
 * Validate a persisted sort mode (from localStorage). Anything unknown falls
 * back to utilization high→low, the order this card shipped with, so a missing
 * or corrupt preference changes nothing.
 */
export function parseAccountUtilizationSortMode(
	value: string | null,
): AccountUtilizationSortMode {
	return (ACCOUNT_UTILIZATION_SORT_MODES as readonly string[]).includes(
		value ?? "",
	)
		? (value as AccountUtilizationSortMode)
		: DEFAULT_ACCOUNT_UTILIZATION_SORT_MODE;
}

/**
 * The account fields that decide which usage card a row renders. A subset of
 * `AccountResponse`, so the card can hand an account straight in while tests
 * build minimal fixtures.
 */
export interface UtilizationAccountSource {
	provider: string;
	rateLimitReset: string | null;
	usageUtilization?: number | null;
	usageWindow?: string | null;
	usageData?: FullUsageData | null;
	staleUsage?: StaleUsageInfo | null;
	usageRateLimitedUntil?: number | null;
}

/** Everything the sort reads: the classification inputs plus row identity. */
export interface SortableUtilizationAccount extends UtilizationAccountSource {
	id: string;
	name: string;
	priority: number;
}

/** Highest of the account's 5h/7d utilization, for sort ordering (no data → -1). */
export function maxUtilization(
	account: Pick<UtilizationAccountSource, "usageData">,
): number {
	if (!account.usageData) return -1;
	const five = extractFiveHour(account.usageData)?.pct ?? null;
	const seven = extractSevenDay(account.usageData)?.pct ?? null;
	if (five == null && seven == null) return -1;
	return Math.max(five ?? 0, seven ?? 0);
}

/**
 * The single mapping from an account to the shape `classifyUsageCard` consumes.
 * Both the reset-sort key and the card's cross-account reset extremes go
 * through this, so the two can never classify the same account differently —
 * notably on `showWeekly`, which decides whether a weekly window exists at all.
 */
export function accountToUsageCardSource(
	account: UtilizationAccountSource,
): UsageCardSource {
	return {
		resetIso: account.rateLimitReset,
		usageUtilization: account.usageUtilization,
		usageWindow: account.usageWindow,
		usageData: account.usageData,
		staleUsage: account.staleUsage,
		usageRateLimitedUntil: account.usageRateLimitedUntil,
		provider: account.provider,
		showWeekly: providerShowsWeeklyUsage(account.provider),
	};
}

/** Epoch ms for an ISO string, but only when it parses AND is still ahead of `now`. */
function futureMs(iso: string | null | undefined, now: number): number | null {
	if (!iso) return null;
	const ms = new Date(iso).getTime();
	if (!Number.isFinite(ms) || ms <= now) return null;
	return ms;
}

function earliestOf(
	candidates: readonly (string | null | undefined)[],
	now: number,
): number {
	let soonest = Number.POSITIVE_INFINITY;
	for (const candidate of candidates) {
		const ms = futureMs(candidate, now);
		if (ms != null && ms < soonest) soonest = ms;
	}
	return soonest;
}

/**
 * The earliest still-future reset the row actually DISPLAYS, as epoch ms.
 * Accounts with nothing to count down to return `Number.POSITIVE_INFINITY` and
 * therefore sort last.
 *
 * Derived from `classifyUsageCard` rather than from the raw fields, so the key
 * can never name a window the user cannot see. Stale snapshots do count:
 * RateLimitProgress renders their 5h/weekly reset text just like a live row's.
 */
export function soonestResetMs(
	account: UtilizationAccountSource,
	now: number,
): number {
	const card = classifyUsageCard(accountToUsageCardSource(account), now);
	switch (card.kind) {
		case "windows":
			return earliestOf(
				card.usages.map((usage) => usage.resetTime),
				now,
			);
		case "stale":
			return earliestOf(
				[
					card.staleUsage.fiveHour?.resetIso,
					card.staleUsage.sevenDay?.resetIso,
				],
				now,
			);
		case "rate-limited":
			return card.retryAfterMs > now
				? card.retryAfterMs
				: Number.POSITIVE_INFINITY;
		default:
			// "credits" and "none" render no countdown at all.
			return Number.POSITIVE_INFINITY;
	}
}

/** Subtraction-free numeric compare, so `Infinity` against `Infinity` is 0, not NaN. */
function compareNumbers(a: number, b: number): number {
	if (a === b) return 0;
	return a < b ? -1 : 1;
}

interface DecoratedAccount<T> {
	account: T;
	utilization: number;
	reset: number;
	providerLabel: string;
}

/**
 * The total tiebreak chain every mode ends in.
 *
 * Case-insensitive name alone is NOT total: account-name uniqueness is enforced
 * with `SELECT id FROM accounts WHERE name = ?` under SQLite's BINARY
 * collation, so `Alpha` and `alpha` can both exist and compare equal at base
 * sensitivity — leaving those rows to fall back to input order. The exact-name
 * and id links close the chain.
 */
function compareTiebreak<T extends SortableUtilizationAccount>(
	a: DecoratedAccount<T>,
	b: DecoratedAccount<T>,
): number {
	const byBase = a.account.name.localeCompare(b.account.name, undefined, {
		sensitivity: "base",
	});
	if (byBase !== 0) return byBase;
	const byExact = a.account.name.localeCompare(b.account.name);
	if (byExact !== 0) return byExact;
	if (a.account.id === b.account.id) return 0;
	return a.account.id < b.account.id ? -1 : 1;
}

/**
 * Accounts reporting no usage at all sort LAST in BOTH directions. Their
 * `maxUtilization` is the -1 sentinel, and a naive ascending sort would lead
 * with them — asserting they have the most headroom when they report nothing.
 */
function compareNoUsagePartition<T>(
	a: DecoratedAccount<T>,
	b: DecoratedAccount<T>,
): number {
	const aMissing = a.utilization < 0;
	const bMissing = b.utilization < 0;
	if (aMissing === bMissing) return 0;
	return aMissing ? 1 : -1;
}

/**
 * Return the accounts ordered per the selected mode (input untouched).
 *
 * Decorate-sort-undecorate: each account's keys are computed ONCE up front.
 * `classifyUsageCard` is not cheap and a comparator runs O(n log n) times, and
 * computing per comparison would also risk an inconsistent comparator.
 */
export function sortAccountsByUtilization<T extends SortableUtilizationAccount>(
	accounts: readonly T[],
	mode: AccountUtilizationSortMode,
	now: number,
): T[] {
	const decorated: DecoratedAccount<T>[] = accounts.map((account) => ({
		account,
		utilization: maxUtilization(account),
		reset: soonestResetMs(account, now),
		providerLabel: providerDisplayName(account.provider),
	}));

	decorated.sort((a, b) => {
		switch (mode) {
			case "utilization-desc":
				return (
					compareNoUsagePartition(a, b) ||
					compareNumbers(b.utilization, a.utilization) ||
					compareTiebreak(a, b)
				);
			case "utilization-asc":
				return (
					compareNoUsagePartition(a, b) ||
					compareNumbers(a.utilization, b.utilization) ||
					compareTiebreak(a, b)
				);
			case "reset":
				return compareNumbers(a.reset, b.reset) || compareTiebreak(a, b);
			case "provider":
				return (
					a.providerLabel.localeCompare(b.providerLabel) ||
					a.account.provider.localeCompare(b.account.provider) ||
					compareTiebreak(a, b)
				);
			case "priority":
				// Ascending = preferred first: the load balancer takes
				// `Math.min(...priorities)` as its top tier, so the LOWER number
				// wins. That is the inverse of the API list order (priority DESC),
				// and is expected.
				return (
					compareNumbers(a.account.priority, b.account.priority) ||
					compareTiebreak(a, b)
				);
			default:
				// "name" — the tiebreak chain used as the primary key.
				return compareTiebreak(a, b);
		}
	});

	return decorated.map((entry) => entry.account);
}
