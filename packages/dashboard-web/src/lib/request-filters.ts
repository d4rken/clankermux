/**
 * Pure helpers for the Request History filter UI.
 *
 * These translate the component's filter state into the query params understood
 * by `GET /api/requests` (and `/api/requests/count`), and handle the
 * local-time <-> epoch conversions for the date-range inputs. Keeping them pure
 * (no React, no api imports) makes the fiddly bits unit-testable and keeps the
 * component focused on rendering.
 */

/** Status-code category. `success` = 2xx, `error` = everything else. */
export type StatusCategory = "all" | "success" | "error";

/** Sentinel `apiKey` value meaning "requests that carried no API key". */
export const NO_API_KEY = "no-api-key";

/** Sentinel `project` value meaning "requests that carried no project". */
export const NO_PROJECT = "no-project";

/** Raw filter state held by the component (mirrors the form controls). */
export interface RequestFilterState {
	status: StatusCategory;
	/** Specific status codes as strings (from the multi-select Set). */
	codes: string[];
	/** Account name, or "all". */
	account: string;
	/** API key name, {@link NO_API_KEY}, or "all". */
	apiKey: string;
	/** Project name, {@link NO_PROJECT}, or "all". */
	project: string;
	/** `datetime-local` string (local time), or "". */
	from: string;
	/** `datetime-local` string (local time), or "". */
	to: string;
}

/** Resolved filter params sent to the server (only active filters present). */
export interface RequestQueryParams {
	status?: StatusCategory;
	codes?: number[];
	from?: number;
	to?: number;
	account?: string;
	apiKey?: string;
	project?: string;
	limit?: number;
	offset?: number;
}

/**
 * Common HTTP status codes always offered in the specific-code picker, so error
 * codes are selectable even when the currently-loaded rows are all 200s (the
 * exact gap that made "filter to non-200" impossible before).
 */
export const COMMON_STATUS_CODES = [
	200, 201, 204, 400, 401, 403, 404, 408, 409, 422, 429, 500, 502, 503, 504,
	529,
];

/** Union the curated common codes with any codes observed in loaded data. */
export function mergeStatusCodes(observed: number[]): number[] {
	return Array.from(new Set([...COMMON_STATUS_CODES, ...observed])).sort(
		(a, b) => a - b,
	);
}

/** True when any filter is set (i.e. switch from live-tail to filtered mode). */
export function isRequestFilterActive(state: RequestFilterState): boolean {
	return (
		state.status !== "all" ||
		state.codes.length > 0 ||
		state.account !== "all" ||
		state.apiKey !== "all" ||
		state.project !== "all" ||
		state.from !== "" ||
		state.to !== ""
	);
}

/**
 * Resolve component filter state into server query params. Inactive filters are
 * omitted. Specific codes take precedence over the status category (matching the
 * server), so `status` is dropped when codes are present.
 */
export function buildRequestQueryParams(
	state: RequestFilterState,
): RequestQueryParams {
	const params: RequestQueryParams = {};

	const codes = state.codes
		.map((c) => Number.parseInt(c, 10))
		.filter((n) => Number.isFinite(n));
	if (codes.length > 0) {
		params.codes = codes;
	} else if (state.status !== "all") {
		params.status = state.status;
	}

	const from = localDateTimeToEpoch(state.from);
	if (from !== undefined) params.from = from;
	const to = localDateTimeToEpoch(state.to);
	if (to !== undefined) params.to = to;

	if (state.account !== "all") params.account = state.account;
	if (state.apiKey !== "all") params.apiKey = state.apiKey;
	if (state.project !== "all") params.project = state.project;

	return params;
}

/** Serialize resolved params into a URLSearchParams (only defined fields). */
export function requestQueryToSearchParams(
	params: RequestQueryParams,
): URLSearchParams {
	const p = new URLSearchParams();
	if (params.limit != null) p.set("limit", String(params.limit));
	if (params.offset != null) p.set("offset", String(params.offset));
	if (params.status && params.status !== "all") p.set("status", params.status);
	if (params.codes && params.codes.length > 0) {
		p.set("codes", params.codes.join(","));
	}
	if (params.from != null) p.set("from", String(params.from));
	if (params.to != null) p.set("to", String(params.to));
	if (params.account && params.account !== "all") {
		p.set("account", params.account);
	}
	if (params.apiKey && params.apiKey !== "all") p.set("apiKey", params.apiKey);
	if (params.project && params.project !== "all") {
		p.set("project", params.project);
	}
	return p;
}

/**
 * Parse a `datetime-local` value (local wall-clock, no timezone) into epoch ms.
 * Returns undefined for empty/invalid input.
 *
 * `new Date("YYYY-MM-DDTHH:mm")` (a date-*time* without a zone designator) is
 * interpreted as local time per the ECMAScript spec, which is exactly what the
 * `datetime-local` input represents.
 */
export function localDateTimeToEpoch(value: string): number | undefined {
	if (!value) return undefined;
	const ms = new Date(value).getTime();
	return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Format an epoch-ms instant as a `datetime-local`-compatible string in LOCAL
 * time (minute precision). Used to seed the From/To inputs from presets without
 * the UTC drift the old `toISOString().slice(0,16)` approach caused.
 */
export function epochToLocalDateTime(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
		`T${pad(d.getHours())}:${pad(d.getMinutes())}`
	);
}

/** Window length in ms for each named preset. */
export const PRESET_WINDOWS_MS: Record<string, number> = {
	"1h": 60 * 60 * 1000,
	"24h": 24 * 60 * 60 * 1000,
	"7d": 7 * 24 * 60 * 60 * 1000,
	"30d": 30 * 24 * 60 * 60 * 1000,
};

/**
 * Compute the From/To `datetime-local` strings for a preset relative to `now`.
 * Returns null for an unknown preset. `now` is injected so this stays pure.
 */
export function presetRange(
	preset: string,
	now: Date,
): { from: string; to: string } | null {
	const windowMs = PRESET_WINDOWS_MS[preset];
	if (!windowMs) return null;
	return {
		from: epochToLocalDateTime(now.getTime() - windowMs),
		to: epochToLocalDateTime(now.getTime()),
	};
}
