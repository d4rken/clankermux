import { providerDisplayName } from "@clankermux/core";
import {
	type AccountSortIdentity,
	compareAccountIdentity,
	compareSortKeys,
} from "./account-sort-identity";
import { computeRenewal } from "./renewal";

/**
 * The orders the Accounts page offers, in the order the `<Select>` lists them.
 * The mode type is DERIVED from this tuple, so a mode cannot exist in the type
 * but be missing from the dropdown.
 */
export const ACCOUNT_LIST_SORT_MODES = [
	"default",
	"name",
	"provider",
	"reauth",
	"renewal",
] as const;

export type AccountListSortMode = (typeof ACCOUNT_LIST_SORT_MODES)[number];

export const ACCOUNT_LIST_SORT_LABELS: Record<AccountListSortMode, string> = {
	default: "Default order",
	name: "Name (A-Z)",
	provider: "Provider",
	reauth: "Soonest re-auth deadline",
	renewal: "Soonest renewal date",
};

/**
 * Tooltip per mode, so the two date orders can say whose date they read — the
 * page shows a re-auth chip and a renewal chip and "expiring soonest" alone
 * does not name either.
 */
export const ACCOUNT_LIST_SORT_DESCRIPTIONS: Record<
	AccountListSortMode,
	string
> = {
	default: "The order the server returns accounts in.",
	name: "Alphabetical by account name.",
	provider: "Grouped by provider, alphabetically by account name within each.",
	reauth:
		"Soonest OAuth refresh-token expiry first — the deadline after which the account auto-pauses until someone re-authenticates it. Providers that report no deadline sort last.",
	renewal:
		"Soonest subscription renewal date first, from each account's renewal anchor and cadence. Accounts with no renewal date set sort last.",
};

export const ACCOUNT_LIST_SORT_STORAGE_KEY = "clankermux-account-list-sort";

/** What the page falls back to with no stored (or a corrupt) preference. */
export const DEFAULT_ACCOUNT_LIST_SORT_MODE: AccountListSortMode = "default";

/**
 * Validate a persisted sort mode (from localStorage). Anything unknown falls
 * back to the server order the page shipped with, so a missing or corrupt
 * preference changes nothing.
 */
export function parseAccountListSortMode(
	value: string | null,
): AccountListSortMode {
	return (ACCOUNT_LIST_SORT_MODES as readonly string[]).includes(value ?? "")
		? (value as AccountListSortMode)
		: DEFAULT_ACCOUNT_LIST_SORT_MODE;
}

/** Everything the sort reads. A subset of `AccountResponse`. */
export interface SortableListAccount extends AccountSortIdentity {
	provider: string;
	/** ISO deadline after which the refresh token stops being accepted. */
	refreshTokenExpiresAt?: string | null;
	/** "YYYY-MM-DD" subscription anchor; null when renewal tracking is off. */
	renewalAnchor?: string | null;
	renewalCadence?: "monthly" | "yearly" | "none" | null;
}

/**
 * Accounts with no date sort LAST rather than first, in a mode whose whole
 * point is "act on this one next". `POSITIVE_INFINITY` is what puts them there;
 * `compareSortKeys` is what keeps two of them comparing equal instead of NaN.
 */
const NO_DATE = Number.POSITIVE_INFINITY;

/** Epoch ms of the refresh-token deadline; `NO_DATE` when the provider reports none. */
export function reauthDeadlineSortKey(account: SortableListAccount): number {
	if (!account.refreshTokenExpiresAt) return NO_DATE;
	const ms = Date.parse(account.refreshTokenExpiresAt);
	return Number.isFinite(ms) ? ms : NO_DATE;
}

/**
 * Epoch ms of the next renewal, `NO_DATE` when no anchor is set.
 *
 * The stored anchor is the ORIGINAL subscription date and is usually in the
 * past, so ordering by it directly would rank a long-standing account above one
 * renewing tomorrow. `computeRenewal` is the same function the renewal chip
 * renders from, so the order matches the dates on the cards.
 */
export function renewalSortKey(
	account: SortableListAccount,
	now: number,
): number {
	const { nextDate } = computeRenewal(
		account.renewalAnchor,
		account.renewalCadence,
		now,
	);
	return nextDate ? nextDate.getTime() : NO_DATE;
}

interface DecoratedAccount<T> {
	account: T;
	providerLabel: string;
	reauth: number;
	renewal: number;
}

/**
 * Return the accounts ordered per the selected mode (input untouched).
 *
 * "default" returns the input order verbatim: the server already sorts by
 * routing priority, and re-deriving that here would be a second copy of the
 * ordering rule that could drift from it.
 */
export function sortAccountList<T extends SortableListAccount>(
	accounts: readonly T[],
	mode: AccountListSortMode,
	now: number,
): T[] {
	if (mode === "default") return [...accounts];

	const decorated: DecoratedAccount<T>[] = accounts.map((account) => ({
		account,
		providerLabel: providerDisplayName(account.provider),
		reauth: reauthDeadlineSortKey(account),
		renewal: renewalSortKey(account, now),
	}));

	decorated.sort((a, b) => {
		switch (mode) {
			case "provider":
				return (
					a.providerLabel.localeCompare(b.providerLabel) ||
					a.account.provider.localeCompare(b.account.provider) ||
					compareAccountIdentity(a.account, b.account)
				);
			case "reauth":
				return (
					compareSortKeys(a.reauth, b.reauth) ||
					compareAccountIdentity(a.account, b.account)
				);
			case "renewal":
				return (
					compareSortKeys(a.renewal, b.renewal) ||
					compareAccountIdentity(a.account, b.account)
				);
			default:
				// "name" — the tiebreak chain used as the primary key.
				return compareAccountIdentity(a.account, b.account);
		}
	});

	return decorated.map((entry) => entry.account);
}
