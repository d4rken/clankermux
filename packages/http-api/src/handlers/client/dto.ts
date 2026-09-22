/**
 * The credential-scoped client contract: what a machine client reads back about
 * its OWN requests.
 *
 * camelCase, like every other published surface here. Counts and identity only
 * — no prompt, no response body, no headers, no payload. The caller already
 * holds everything it sent; what it cannot reconstruct is what the proxy
 * recorded about the exchange.
 */
import type { ClientRequestRow } from "@clankermux/database";

export const CLIENT_REQUEST_SCHEMA = "clankermux.client.request.v1";
export const CLIENT_REQUESTS_SCHEMA = "clankermux.client.requests.v1";

/**
 * Where a row's token vector came from, as this surface states it.
 *
 * The same three values `requests.usage_source` stores, plus `null` for a row
 * whose accounting is not finished. A fourth value would widen a contract the
 * consumer has already been given as three.
 */
export type ClientUsageSourceDto = "provider" | "approximate" | "none" | null;

export interface ClientRequestDto {
	schema: typeof CLIENT_REQUEST_SCHEMA;
	id: string;
	/**
	 * When the ROW WAS WRITTEN, ms epoch — not when the request started. The
	 * recorder stamps this as it persists, after the async writer drains, so it
	 * trails the exchange by the response duration plus queue depth. It is the
	 * paging order, and it is not a request clock.
	 */
	timestamp: number;
	/** True when no later write can change this row's accounting. */
	finalized: boolean;
	statusCode: number | null;
	error: string | null;
	model: string | null;
	requestedModel: string | null;
	/**
	 * Four DISJOINT classes: `inputTokens` excludes both cache classes, so the
	 * three prompt classes sum to the whole prompt and none contains another.
	 * `null` means no count for that class was received; a provider-reported
	 * zero is published as 0. Rows written before that guarantee are not
	 * backfilled, so on those a null may still be a collapsed zero.
	 */
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadInputTokens: number | null;
	cacheCreationInputTokens: number | null;
	usageSource: ClientUsageSourceDto;
	/**
	 * The attempt index the answering try was made under. Above 0 it means
	 * earlier attempts happened and their cost is missing: the proxy can discard
	 * a provider response it has already been billed for, and no column records
	 * what that cost, so the row is a lower bound. At 0 it does NOT prove none
	 * did, because a retry against the same account after a hold restarts the
	 * index. Evidence when positive, not evidence of absence when 0.
	 */
	failoverAttempts: number | null;
	project: string | null;
	apiKeyId: string;
	correlationTag: string | null;
}

export interface ClientRequestsDto {
	schema: typeof CLIENT_REQUESTS_SCHEMA;
	requests: ClientRequestDto[];
	/** The `after` cursor for the next page, or null when this is the last one. */
	next: string | null;
}

/**
 * Is this row's accounting finished? A predicate over the ROW, with no clock in
 * it.
 *
 * `usage_source` is the modern answer and a real guarantee: it is written at
 * persist time and write-once in SQL, so a `true` from that clause can never be
 * contradicted by a later write. The other three clauses cover history —
 * `usage_finalized_at` is itself an additive column, so rows older than it carry
 * real token counts under a NULL stamp, and usage evidence is the only thing
 * that distinguishes them from a row still waiting for a late patch.
 *
 * Elapsed time is NOT evidence here and must not become one: the SQL adapter
 * retries SQLITE_BUSY against a ten-minute deadline on top of the async
 * writer's own backlog, so "it has been a while" cannot establish that a write
 * has committed.
 */
export function isClientRequestFinalized(row: ClientRequestRow): boolean {
	return (
		row.usage_source != null ||
		row.usage_finalized_at != null ||
		row.model != null ||
		row.total_tokens != null
	);
}

/**
 * What to publish for `usageSource`.
 *
 * A row finalized only by the legacy clauses reports `approximate`, which this
 * contract defines as "not established as provider-reported" rather than "these
 * numbers were estimated". Claiming `provider` for a row whose provenance was
 * never recorded would be a false exactness claim, and the default arm gives an
 * unrecognised stored value the same honest answer.
 */
export function toClientUsageSource(
	row: ClientRequestRow,
): ClientUsageSourceDto {
	switch (row.usage_source) {
		case "provider":
			return "provider";
		case "approximate":
			return "approximate";
		case "none":
			return "none";
		default:
			return isClientRequestFinalized(row) ? "approximate" : null;
	}
}

export function toClientRequestDto(row: ClientRequestRow): ClientRequestDto {
	return {
		schema: CLIENT_REQUEST_SCHEMA,
		id: row.id,
		timestamp: row.timestamp,
		finalized: isClientRequestFinalized(row),
		statusCode: row.status_code,
		error: row.error_message,
		model: row.model,
		requestedModel: row.requested_model,
		inputTokens: row.input_tokens,
		outputTokens: row.output_tokens,
		cacheReadInputTokens: row.cache_read_input_tokens,
		cacheCreationInputTokens: row.cache_creation_input_tokens,
		usageSource: toClientUsageSource(row),
		failoverAttempts: row.failover_attempts,
		project: row.project,
		apiKeyId: row.api_key_id,
		correlationTag: row.correlation_tag,
	};
}

export function toClientRequestsDto(
	rows: ClientRequestRow[],
	next: string | null,
): ClientRequestsDto {
	return {
		schema: CLIENT_REQUESTS_SCHEMA,
		requests: rows.map(toClientRequestDto),
		next,
	};
}
