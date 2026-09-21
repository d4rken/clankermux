/**
 * The one error body this namespace answers with.
 *
 * `{"type":"error","error":{"type":…,"message":…}}`, for every non-2xx under
 * `/client/v1` — the mount's 401 and namespace 404 as much as the refusals the
 * router produces itself. The mount builds the same shape from its own private
 * helper, which this package cannot import, so the agreement between the two
 * layers is pinned by a test rather than trusted:
 * `apps/server/src/__tests__/request-router-client-api.test.ts`.
 *
 * `type` is the half a caller branches on, so the set stays small and stable:
 * `authentication_error`, `invalid_request`, `method_not_allowed`,
 * `not_found`.
 */
import { jsonResponse } from "@clankermux/http-common";
import { CLIENT_NO_STORE_HEADERS } from "./cache-headers";

export function clientError(
	status: number,
	type: string,
	message: string,
	headers: Record<string, string> = {},
): Response {
	return jsonResponse({ type: "error", error: { type, message } }, status, {
		...CLIENT_NO_STORE_HEADERS,
		...headers,
	});
}
