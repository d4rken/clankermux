/**
 * `GET /client/v1/requests/{id}` and `GET /client/v1/requests?tag=` — the two
 * reads the client API exists for.
 *
 * Both are scoped to the api key the mount authenticated, and the scoping lives
 * in the SQL (see `RequestRepository.getClientRequest` /
 * `listClientRequestsByTag`). Nothing here re-filters what the database
 * returned, because a filter in this layer is one that a future caller of the
 * repository can forget.
 */
import { ValidationError, validateNumber } from "@clankermux/core";
import type { ClientRequestRow } from "@clankermux/database";
import { jsonResponse } from "@clankermux/http-common";
import { validateCorrelationTag } from "@clankermux/proxy";
import { CLIENT_NO_STORE_HEADERS } from "./cache-headers";
import {
	type ClientRequestCursor,
	decodeClientRequestCursor,
	encodeClientRequestCursor,
} from "./cursor";
import { toClientRequestDto, toClientRequestsDto } from "./dto";
import { clientError } from "./errors";
import type { ClientRequestContext } from "./router";

/** The page size a caller gets when it names none. */
export const CLIENT_REQUESTS_DEFAULT_LIMIT = 50;
/** The largest page this surface will assemble. */
export const CLIENT_REQUESTS_MAX_LIMIT = 200;

/**
 * Just enough of `RequestRepository` for these two handlers. The router hands
 * them the real repository, so a drift between the two shapes fails there.
 */
export interface ClientRequestReader {
	getClientRequest(
		apiKeyId: string,
		id: string,
	): Promise<ClientRequestRow | null>;
	listClientRequestsByTag(opts: {
		apiKeyId: string;
		tag: string;
		limit: number;
		after?: ClientRequestCursor | null;
	}): Promise<ClientRequestRow[]>;
}

/**
 * `GET /client/v1/requests/{id}`.
 *
 * ONE answer for three situations — another client's row, a row retention has
 * already deleted, and an id that was never issued — so the endpoint is not an
 * existence oracle for request ids and the consumer has a single terminal
 * meaning to handle. 404, never 403: a 403 would confirm the row exists.
 */
export function createClientRequestByIdHandler(reader: ClientRequestReader) {
	return async (id: string, ctx: ClientRequestContext): Promise<Response> => {
		const row = await reader.getClientRequest(ctx.apiKeyId, id);
		if (!row) {
			return clientError(
				404,
				"not_found",
				"No request with that id is readable with this key.",
			);
		}
		return jsonResponse(toClientRequestDto(row), 200, CLIENT_NO_STORE_HEADERS);
	};
}

/**
 * `GET /client/v1/requests?tag={tag}&limit={n}&after={cursor}`.
 *
 * `tag` is required: the tag is the client's own handle on a run, and a
 * tagless search would be "every request this key ever made", which is a
 * different resource with different cost.
 *
 * The tag goes through the SAME validator the ingest header does, so the set of
 * tags that can be searched for is exactly the set that can be stored. A search
 * term this refuses could never have reached the column.
 */
export function createClientRequestSearchHandler(reader: ClientRequestReader) {
	return async (url: URL, ctx: ClientRequestContext): Promise<Response> => {
		const tag = validateCorrelationTag(url.searchParams.get("tag"));
		if (tag === null) {
			return clientError(
				400,
				"invalid_request",
				"tag is required, and must be 1-128 bytes of printable US-ASCII (0x20-0x7E).",
			);
		}

		let limit: number;
		try {
			limit =
				validateNumber(
					url.searchParams.get("limit") ??
						String(CLIENT_REQUESTS_DEFAULT_LIMIT),
					"limit",
					{
						min: 1,
						max: CLIENT_REQUESTS_MAX_LIMIT,
						integer: true,
					},
				) ?? CLIENT_REQUESTS_DEFAULT_LIMIT;
		} catch (err) {
			if (!(err instanceof ValidationError)) throw err;
			return clientError(400, "invalid_request", err.message);
		}

		const rawCursor = url.searchParams.get("after");
		let after: ClientRequestCursor | null = null;
		if (rawCursor !== null) {
			after = decodeClientRequestCursor(rawCursor);
			if (!after) {
				return clientError(
					400,
					"invalid_request",
					"after is not a cursor this server issued.",
				);
			}
		}

		// One row past the page, then trimmed: the extra row is how `next` can be
		// null on the last page instead of the caller learning it is done by
		// fetching an empty one.
		const rows = await reader.listClientRequestsByTag({
			apiKeyId: ctx.apiKeyId,
			tag,
			limit: limit + 1,
			after,
		});
		const page = rows.slice(0, limit);
		const last = page[page.length - 1];
		const next =
			rows.length > limit && last
				? encodeClientRequestCursor({ timestamp: last.timestamp, id: last.id })
				: null;
		return jsonResponse(
			toClientRequestsDto(page, next),
			200,
			CLIENT_NO_STORE_HEADERS,
		);
	};
}
