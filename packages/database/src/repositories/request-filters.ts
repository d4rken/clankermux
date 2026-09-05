/**
 * The analytics request-filter set, and the SQL predicates it compiles to.
 *
 * This is the filter panel the Analytics tabs carry (accounts, models, API
 * keys, projects, status) expressed once, so every read that claims to honor
 * that panel honors the SAME rules. It lived inline in the `/api/analytics`
 * handler until a second read — the stops history — had to answer under the
 * same selection; a second copy of these predicates is how two panels on one
 * page come to disagree about which requests they are describing.
 *
 * Identity, not display names. `accounts` and `apiKeys` carry stable IDs: a
 * name changes under a rename and disappears under a hard delete, and matching
 * on it leaves the SQL-NULL rows unfilterable. `models` and `projects` ARE
 * their own identity and stay plain values.
 *
 * The two NULL buckets have dedicated flags rather than in-band sentinels, so a
 * project literally named "no-project" stays filterable as a normal name.
 */

/** Recorded outcome selection. */
export type RequestFilterStatus = "all" | "success" | "error";

export interface RequestFilters {
	/** Account IDs (`requests.account_used`). */
	accounts: string[];
	/** Include the `account_used IS NULL` bucket. */
	accountsNone: boolean;
	models: string[];
	/** `requests.api_key_id` values. */
	apiKeys: string[];
	projects: string[];
	/** Include the `project IS NULL` bucket. */
	projectsNone: boolean;
	status: RequestFilterStatus;
}

/** A cleared selection — the single definition of "no filters". */
export const EMPTY_REQUEST_FILTERS: RequestFilters = {
	accounts: [],
	accountsNone: false,
	models: [],
	apiKeys: [],
	projects: [],
	projectsNone: false,
	status: "all",
};

/** Does this selection narrow anything at all? */
export function hasRequestFilters(
	filters: RequestFilters | undefined,
): boolean {
	if (!filters) return false;
	return (
		filters.accounts.length > 0 ||
		filters.accountsNone ||
		filters.models.length > 0 ||
		filters.apiKeys.length > 0 ||
		filters.projects.length > 0 ||
		filters.projectsNone ||
		filters.status !== "all"
	);
}

/**
 * Compile the selection into predicates over a `requests` row aliased `alias`.
 *
 * Returns the conditions and their positional binds in the same order, so a
 * caller appends both with `conditions.join(" AND ")` and `push(...binds)` and
 * cannot shift one against the other. An empty (or absent) selection yields
 * `{ conditions: [], binds: [] }`, which a caller splices in unconditionally.
 */
export function buildRequestFilterConditions(
	filters: RequestFilters | undefined,
	alias = "r",
): { conditions: string[]; binds: (string | number)[] } {
	const conditions: string[] = [];
	const binds: (string | number)[] = [];
	if (!filters) return { conditions, binds };

	// Named accounts plus a dedicated flag for the NULL bucket, mirroring the
	// project filter below. The NO_ACCOUNT_ID sentinel is never STORED on a
	// request row (account_used is either an id or SQL NULL), so an
	// `account_used = 'no_account'` disjunct would match nothing and the
	// no-account requests could not be filtered at all.
	if (filters.accounts.length > 0 || filters.accountsNone) {
		const parts: string[] = [];
		if (filters.accounts.length > 0) {
			const placeholders = filters.accounts.map(() => "?").join(",");
			parts.push(`${alias}.account_used IN (${placeholders})`);
			binds.push(...filters.accounts);
		}
		if (filters.accountsNone) {
			parts.push(`${alias}.account_used IS NULL`);
		}
		conditions.push(`(${parts.join(" OR ")})`);
	}

	if (filters.models.length > 0) {
		const placeholders = filters.models.map(() => "?").join(",");
		conditions.push(`${alias}.model IN (${placeholders})`);
		binds.push(...filters.models);
	}

	if (filters.apiKeys.length > 0) {
		// Match on api_key_id, which is stamped on the row and survives both a
		// rename and a hard delete — exactly what a COALESCE(current name,
		// snapshot name) predicate approximates, but exactly rather than
		// approximately, and without a correlated subquery per row.
		const placeholders = filters.apiKeys.map(() => "?").join(",");
		conditions.push(`${alias}.api_key_id IN (${placeholders})`);
		binds.push(...filters.apiKeys);
	}

	if (filters.projects.length > 0 || filters.projectsNone) {
		const parts: string[] = [];
		if (filters.projects.length > 0) {
			const placeholders = filters.projects.map(() => "?").join(",");
			parts.push(`${alias}.project IN (${placeholders})`);
			binds.push(...filters.projects);
		}
		if (filters.projectsNone) {
			parts.push(`${alias}.project IS NULL`);
		}
		conditions.push(`(${parts.join(" OR ")})`);
	}

	if (filters.status === "success") {
		conditions.push(`${alias}.success = TRUE`);
	} else if (filters.status === "error") {
		conditions.push(`${alias}.success = FALSE`);
	}

	return { conditions, binds };
}
