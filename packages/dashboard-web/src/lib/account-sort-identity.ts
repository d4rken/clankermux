/** The row identity every account sort falls back to when its key ties. */
export interface AccountSortIdentity {
	id: string;
	name: string;
}

/**
 * The total tiebreak chain every account sort mode ends in.
 *
 * Case-insensitive name alone is NOT total: account-name uniqueness is enforced
 * with `SELECT id FROM accounts WHERE name = ?` under SQLite's BINARY
 * collation, so `Alpha` and `alpha` can both exist and compare equal at base
 * sensitivity — leaving those rows to fall back to input order. The exact-name
 * and id links close the chain.
 */
export function compareAccountIdentity(
	a: AccountSortIdentity,
	b: AccountSortIdentity,
): number {
	const byBase = a.name.localeCompare(b.name, undefined, {
		sensitivity: "base",
	});
	if (byBase !== 0) return byBase;
	const byExact = a.name.localeCompare(b.name);
	if (byExact !== 0) return byExact;
	if (a.id === b.id) return 0;
	return a.id < b.id ? -1 : 1;
}

/** Subtraction-free numeric compare, so `Infinity` against `Infinity` is 0, not NaN. */
export function compareSortKeys(a: number, b: number): number {
	if (a === b) return 0;
	return a < b ? -1 : 1;
}
