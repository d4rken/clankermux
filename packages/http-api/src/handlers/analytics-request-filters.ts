import {
	EMPTY_REQUEST_FILTERS,
	type RequestFilters,
} from "@clankermux/database";

/**
 * Parse the analytics filter panel out of a query string.
 *
 * The wire names are the dashboard's: `accounts`, `models`, `apiKeys` and
 * `projects` are comma-separated lists, the two NULL buckets are the separate
 * flags `accountsNone` / `projectsNone`, and `status` defaults to `all`.
 *
 * `/api/analytics` and `/api/analytics/stops-history` both read it, so a panel
 * selection means the same thing on both — the predicates it compiles to live
 * in `@clankermux/database`'s request-filters module.
 *
 * Named `parseAnalyticsRequestFilters` rather than `parseRequestFilters`
 * because the sibling `request-filters.ts` in this directory already owns that
 * name for the request-HISTORY endpoints (`/api/requests`), whose filter set is
 * a different one over the same table.
 */
export function parseAnalyticsRequestFilters(
	params: URLSearchParams,
): RequestFilters {
	const list = (name: string): string[] =>
		params.get(name)?.split(",").filter(Boolean) || [];
	const status = params.get("status");
	return {
		// `accounts` and `apiKeys` carry stable IDs, not display names. Names are
		// not identity: they change under a rename and disappear under a hard
		// delete, and matching on them left the SQL-NULL-account rows
		// unfilterable while the dropdown still offered a "(no account)" option.
		// IDs are what the row actually stores. `models` and `projects` ARE their
		// own identity, so they are unchanged.
		accounts: list("accounts"),
		accountsNone: params.get("accountsNone") === "true",
		models: list("models"),
		apiKeys: list("apiKeys"),
		// Named projects plus a dedicated flag for the NULL bucket — no in-band
		// sentinel, so a project literally named "no-project" stays filterable as
		// a normal name.
		projects: list("projects"),
		projectsNone: params.get("projectsNone") === "true",
		status:
			status === "success" || status === "error"
				? status
				: EMPTY_REQUEST_FILTERS.status,
	};
}
