import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import type {
	AnalyticsFilterOption,
	AnalyticsFilterOptionsResponse,
	APIContext,
} from "../types";

const log = new Logger("AnalyticsFilterOptions");

/**
 * Cap per list. A dropdown past a few hundred entries is unusable anyway, and
 * the cap keeps a pathological high-cardinality dimension from producing an
 * unbounded response. Matches createRequestProjectsHandler.
 */
const OPTIONS_LIMIT = 500;

/**
 * Options for the analytics filter dropdowns.
 *
 * WHY A DEDICATED ENDPOINT: the dropdowns used to be accumulated client-side
 * from whatever the analytics breakdowns returned. Those are truncated to the
 * top 10 models / top 20 projects and only cover the sub-tabs the user has
 * actually opened, so the long tail was silently unselectable.
 *
 * WHY TWO-STEP LABEL RESOLUTION: grouping on the display expression
 * (`COALESCE(a.name, r.account_used, …)`) forces a full scan of `requests` —
 * measured at 4.9 s on the live DB. Grouping on the raw indexed columns instead
 * is an index-only scan (~0.06 s each); the labels are then resolved from the
 * small `accounts` / `api_keys` tables in a second pass.
 */
export function createAnalyticsFilterOptionsHandler(context: APIContext) {
	// Takes (and ignores) the search params so it matches the DirectHandler
	// signature the dashboard worker and its runner dispatch through. The option
	// lists are global by design — scoping them to the active filters would make
	// a filter un-clearable once it excluded its own option.
	return async (_params?: URLSearchParams): Promise<Response> => {
		const db = context.dbOps.getAdapter();
		try {
			// ── Step 1: distinct raw values, straight off the indexes ───────────
			const [modelRows, projectRows, accountIdRows, apiKeyIdRows] =
				await Promise.all([
					db.query<{ model: string }>(
						`SELECT DISTINCT model FROM requests WHERE model IS NOT NULL ORDER BY model LIMIT ${OPTIONS_LIMIT}`,
					),
					db.query<{ project: string }>(
						`SELECT DISTINCT project FROM requests WHERE project IS NOT NULL ORDER BY project LIMIT ${OPTIONS_LIMIT}`,
					),
					db.query<{ account_used: string }>(
						`SELECT DISTINCT account_used FROM requests WHERE account_used IS NOT NULL ORDER BY account_used LIMIT ${OPTIONS_LIMIT}`,
					),
					db.query<{ api_key_id: string }>(
						`SELECT DISTINCT api_key_id FROM requests WHERE api_key_id IS NOT NULL ORDER BY api_key_id LIMIT ${OPTIONS_LIMIT}`,
					),
				]);

			// ── Step 2: label lookups from the small dimension tables ───────────
			const [accountRows, apiKeyRows] = await Promise.all([
				db.query<{ id: string; name: string }>(`SELECT id, name FROM accounts`),
				db.query<{ id: string; name: string }>(`SELECT id, name FROM api_keys`),
			]);
			const accountNames = new Map(accountRows.map((r) => [r.id, r.name]));
			const apiKeyNames = new Map(apiKeyRows.map((r) => [r.id, r.name]));

			// A hard-deleted key has no api_keys row, so fall back to the
			// record-time snapshot on its most recent request. Bounded: only ids
			// missing from api_keys are looked up (usually none), and each lookup
			// is an index seek on (api_key_id, timestamp DESC) that stops at the
			// first non-NULL snapshot. Deliberately NOT a grouped MAX() over
			// `requests` — that would need a full scan to read a column no
			// api_key_id index covers.
			const deletedKeyLabels = new Map<string, string>();
			for (const { api_key_id: id } of apiKeyIdRows) {
				if (apiKeyNames.has(id)) continue;
				const snapshot = await db.get<{ api_key_name: string }>(
					`SELECT api_key_name FROM requests
					 WHERE api_key_id = ? AND api_key_name IS NOT NULL
					 ORDER BY timestamp DESC LIMIT 1`,
					[id],
				);
				if (snapshot?.api_key_name) {
					deletedKeyLabels.set(id, snapshot.api_key_name);
				}
			}

			// ── Step 3: NULL-bucket presence ────────────────────────────────────
			// Derived from counts rather than `EXISTS(… IS NULL)`: no index covers
			// `project IS NULL` (idx_requests_project_timestamp is partial on
			// NOT NULL), so an EXISTS probe degrades to a full table scan whenever
			// the answer is "no". These three counts are index-only scans with a
			// predictable cost either way.
			const nullBuckets = await db.get<{
				total: number;
				with_account: number;
				with_project: number;
			}>(
				`SELECT
					(SELECT COUNT(*) FROM requests) AS total,
					(SELECT COUNT(*) FROM requests WHERE account_used IS NOT NULL) AS with_account,
					(SELECT COUNT(*) FROM requests WHERE project IS NOT NULL) AS with_project`,
			);
			const total = Number(nullBuckets?.total) || 0;

			const toAccountOption = (id: string): AnalyticsFilterOption => ({
				value: id,
				// Falls back to the bare id for a hard-deleted account, so its
				// history stays selectable instead of vanishing from the dropdown.
				label: accountNames.get(id) ?? id,
			});
			const toApiKeyOption = (id: string): AnalyticsFilterOption => ({
				value: id,
				label: apiKeyNames.get(id) ?? deletedKeyLabels.get(id) ?? id,
			});

			const response: AnalyticsFilterOptionsResponse = {
				accounts: accountIdRows
					.map((row) => toAccountOption(row.account_used))
					.sort((a, b) => a.label.localeCompare(b.label)),
				apiKeys: apiKeyIdRows
					.map((row) => toApiKeyOption(row.api_key_id))
					.sort((a, b) => a.label.localeCompare(b.label)),
				models: modelRows.map((row) => row.model),
				projects: projectRows.map((row) => row.project),
				hasNoAccount: total > (Number(nullBuckets?.with_account) || 0),
				hasNoProject: total > (Number(nullBuckets?.with_project) || 0),
			};
			return jsonResponse(response);
		} catch (error) {
			log.error("Analytics filter options error:", error);
			return errorResponse(
				InternalServerError("Failed to fetch analytics filter options"),
			);
		}
	};
}
