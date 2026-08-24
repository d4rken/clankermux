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

/** Recorded outcome category. Explicit `codes` still filters raw HTTP status. */
export type StatusFilter = "all" | "success" | "error";

export interface RequestFilters {
	/**
	 * Exact request id. Backs the deep link from Live Activity, whose target row
	 * can sit outside whatever slice the list view happens to have loaded.
	 */
	id?: string;
	/** Recorded success/error outcome. Ignored when `codes` is non-empty. */
	status?: StatusFilter;
	/** Explicit status codes; when present these win over `status`. */
	codes?: number[];
	/** Lower timestamp bound (epoch ms, inclusive). */
	from?: number;
	/** Upper timestamp bound (epoch ms, inclusive). */
	to?: number;
	/** Account name (falls back to matching the raw account id). */
	account?: string;
	/**
	 * API key name — a LITERAL name and nothing else. The "no key" bucket is
	 * {@link RequestFilters.noApiKey} rather than a magic name, because every
	 * sentinel string is also a name a real key can be given.
	 */
	apiKey?: string;
	/** Restrict to requests that carried no API key at all. */
	noApiKey?: boolean;
	/** Project name — a LITERAL name; see {@link RequestFilters.apiKey}. */
	project?: string;
	/** Restrict to requests that carried no project at all. */
	noProject?: boolean;
	/**
	 * SUBSTRING match against the recorded failure reason (`error_message`).
	 *
	 * Status codes cannot answer "how did overload hurt clients": a synthetic
	 * bounce and a forwarded upstream 529 are both HTTP 529, and an Anthropic
	 * stream that dies in an `overloaded_error` frame is recorded as HTTP 200
	 * with `success = 0` — invisible to any `codes=` filter. The reason string
	 * is the only column that separates them, and it is already written.
	 *
	 * Substring rather than exact because the values are a small stable set with
	 * a shared stem: `provider_overloaded` (our synthetic terminal),
	 * `529 overloaded_error: Overloaded` (forwarded upstream),
	 * `200 overloaded_error: Overloaded` (in-band, mid-stream). `error=overload`
	 * gets the whole class; the full string gets exactly one kind.
	 *
	 * `error_message` is not indexed, so pair this with `from`/`to` (which are)
	 * on a large history rather than scanning it unbounded.
	 */
	error?: string;
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

	// First, so the positional params keep a stable, documented order.
	if (filters.id) {
		clauses.push("r.id = ?");
		params.push(filters.id);
	}

	// Status: explicit codes are the most specific selection, so they take
	// precedence over the success/error category when both are present.
	if (filters.codes && filters.codes.length > 0) {
		const placeholders = filters.codes.map(() => "?").join(", ");
		clauses.push(`r.status_code IN (${placeholders})`);
		params.push(...filters.codes);
	} else if (filters.status === "success") {
		clauses.push("r.success = 1");
	} else if (filters.status === "error") {
		// Outcome, not status code: Anthropic can return HTTP 200 and later send a
		// terminal overloaded_error/rate_limit_error inside the SSE stream.
		clauses.push("r.success = 0");
	}

	if (filters.error) {
		// The ESCAPE clause is REQUIRED, not decoration: SQLite's LIKE has no
		// default escape character, so without it the backslashes below would be
		// matched literally and `provider_overloaded` would find nothing.
		clauses.push("r.error_message LIKE ? ESCAPE '\\'");
		// Escape the LIKE metacharacters so a reason string containing `_`
		// (every one of ours does — `provider_overloaded`) matches literally
		// instead of treating it as a single-character wildcard.
		const escaped = filters.error
			.replace(/\\/g, "\\\\")
			.replace(/%/g, "\\%")
			.replace(/_/g, "\\_");
		params.push(`%${escaped}%`);
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

	if (filters.noApiKey) {
		clauses.push("r.api_key_name IS NULL");
	} else if (filters.apiKey) {
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

	if (filters.noProject) {
		clauses.push("r.project IS NULL");
	} else if (filters.project) {
		// The project name is stamped directly on the row at record time (no
		// rename indirection like api_keys), so a plain equality match suffices.
		clauses.push("r.project = ?");
		params.push(filters.project);
	}

	const sql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
	return { sql, params };
}

/**
 * Parse {@link RequestFilters} from URL search params.
 *
 * Name-valued filters are PRESENCE-based: `account`, `apiKey` and `project` are
 * active whenever the parameter is present and non-empty, whatever it says. The
 * old "drop the literal value `all`" rule silently discarded the filter for
 * anything genuinely named `all`, with no value a caller could send to ask for
 * it instead. The empty buckets are their own booleans (`noApiKey=1`,
 * `noProject=1`) for the same reason.
 */
export function parseRequestFilters(params: URLSearchParams): RequestFilters {
	const filters: RequestFilters = {};

	const id = params.get("id");
	if (id) {
		filters.id = id;
	}

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
	if (account) {
		filters.account = account;
	}

	const error = params.get("error");
	if (error) {
		filters.error = error;
	}

	if (params.get("noApiKey") === "1") {
		filters.noApiKey = true;
	} else {
		const apiKey = params.get("apiKey");
		if (apiKey) {
			filters.apiKey = apiKey;
		}
	}

	if (params.get("noProject") === "1") {
		filters.noProject = true;
	} else {
		const project = params.get("project");
		if (project) {
			filters.project = project;
		}
	}

	return filters;
}

function parseEpoch(raw: string | null): number | undefined {
	if (!raw) return undefined;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) ? n : undefined;
}
