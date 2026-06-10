/**
 * Shared filtering logic for the request-history endpoints.
 *
 * Both `GET /api/requests` (the paginated list) and `GET /api/requests/count`
 * (the matching-row total) filter the same way, so the WHERE-clause builder and
 * the query-param parser live here to guarantee the two endpoints can never
 * drift out of sync.
 *
 * All column references are qualified (`r.` for requests, `a.` for the joined
 * accounts row) so the produced SQL drops straight into the existing
 * `requests r LEFT JOIN accounts a` queries.
 */

/** Status-code category. `success` = 2xx, `error` = everything else. */
export type StatusFilter = "all" | "success" | "error";

/** Sentinel `apiKey` value meaning "requests that carried no API key". */
export const NO_API_KEY = "no-api-key";

/** Sentinel `project` value meaning "requests that carried no project". */
export const NO_PROJECT = "no-project";

export interface RequestFilters {
	/** Status-code category. Ignored when `codes` is non-empty. */
	status?: StatusFilter;
	/** Explicit status codes; when present these win over `status`. */
	codes?: number[];
	/** Lower timestamp bound (epoch ms, inclusive). */
	from?: number;
	/** Upper timestamp bound (epoch ms, inclusive). */
	to?: number;
	/** Account name (falls back to matching the raw account id). */
	account?: string;
	/** API key name, or {@link NO_API_KEY} for the "no key" bucket. */
	apiKey?: string;
	/** Project name, or {@link NO_PROJECT} for the "no project" bucket. */
	project?: string;
}

/**
 * Build a parameterized `WHERE` clause from the given filters.
 *
 * Returns `{ sql: "", params: [] }` when no filter is active so callers can
 * splice `sql` into their query unconditionally. Clause order is stable so the
 * positional `params` array always lines up with the `?` placeholders.
 */
export function buildRequestFilterClause(filters: RequestFilters): {
	sql: string;
	params: (string | number)[];
} {
	const clauses: string[] = [];
	const params: (string | number)[] = [];

	// Status: explicit codes are the most specific selection, so they take
	// precedence over the success/error category when both are present.
	if (filters.codes && filters.codes.length > 0) {
		const placeholders = filters.codes.map(() => "?").join(", ");
		clauses.push(`r.status_code IN (${placeholders})`);
		params.push(...filters.codes);
	} else if (filters.status === "success") {
		clauses.push("r.status_code >= 200 AND r.status_code < 300");
	} else if (filters.status === "error") {
		// Non-2xx. status_code is effectively never NULL in practice, but guard
		// for it so a stray null row still counts as an error rather than vanishing.
		clauses.push(
			"(r.status_code IS NULL OR r.status_code < 200 OR r.status_code >= 300)",
		);
	}

	if (typeof filters.from === "number") {
		clauses.push("r.timestamp >= ?");
		params.push(filters.from);
	}
	if (typeof filters.to === "number") {
		clauses.push("r.timestamp <= ?");
		params.push(filters.to);
	}

	if (filters.account) {
		// The dashboard filters by the friendly account name, but fall back to the
		// raw id so rows from since-deleted accounts (name JOIN is null) still match.
		clauses.push("(a.name = ? OR r.account_used = ?)");
		params.push(filters.account, filters.account);
	}

	if (filters.apiKey) {
		if (filters.apiKey === NO_API_KEY) {
			clauses.push("r.api_key_name IS NULL");
		} else {
			// Match the key's CURRENT name (api_keys.name) so a filter on the
			// post-rename name finds requests stamped under the old one. The
			// stamped snapshot remains the fallback for hard-deleted keys. A
			// correlated subquery keeps the clause self-contained — it drops into
			// any query whose requests alias is `r`, no extra JOIN required.
			clauses.push(
				"COALESCE((SELECT name FROM api_keys WHERE id = r.api_key_id), r.api_key_name) = ?",
			);
			params.push(filters.apiKey);
		}
	}

	if (filters.project) {
		if (filters.project === NO_PROJECT) {
			clauses.push("r.project IS NULL");
		} else {
			// The project name is stamped directly on the row at record time (no
			// rename indirection like api_keys), so a plain equality match suffices.
			clauses.push("r.project = ?");
			params.push(filters.project);
		}
	}

	const sql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
	return { sql, params };
}

/**
 * Parse {@link RequestFilters} from URL search params. Invalid or "all"-sentinel
 * values are dropped so the result only ever contains active filters.
 */
export function parseRequestFilters(params: URLSearchParams): RequestFilters {
	const filters: RequestFilters = {};

	const status = params.get("status");
	if (status === "success" || status === "error") {
		filters.status = status;
	}

	const codesRaw = params.get("codes");
	if (codesRaw) {
		const codes = codesRaw
			.split(",")
			.map((c) => Number.parseInt(c.trim(), 10))
			.filter((n) => Number.isFinite(n));
		if (codes.length > 0) {
			filters.codes = codes;
		}
	}

	const from = parseEpoch(params.get("from"));
	if (from !== undefined) {
		filters.from = from;
	}
	const to = parseEpoch(params.get("to"));
	if (to !== undefined) {
		filters.to = to;
	}

	const account = params.get("account");
	if (account && account !== "all") {
		filters.account = account;
	}

	const apiKey = params.get("apiKey");
	if (apiKey && apiKey !== "all") {
		filters.apiKey = apiKey;
	}

	const project = params.get("project");
	if (project && project !== "all") {
		filters.project = project;
	}

	return filters;
}

function parseEpoch(raw: string | null): number | undefined {
	if (!raw) return undefined;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) ? n : undefined;
}
