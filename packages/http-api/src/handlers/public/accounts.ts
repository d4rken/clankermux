import { jsonResponse } from "@clankermux/http-common";
import type { PublicSnapshotReader } from "../../services/public-snapshot";
import { type PublicAccountsDto, toPublicAccountsDto } from "./dto";

/**
 * `GET /public/v1/accounts` — one record per account, with its usage windows
 * nested one level deep and no further.
 *
 * `id` is present so a stream event's `accountId` can be resolved to a name
 * without a second endpoint. Everything else `AccountResponse` carries —
 * identity, tokens, endpoints, notes, renewal — is absent by construction: the
 * DTO is built from a named field list rather than by deleting from the
 * management object.
 */
export function createPublicAccountsHandler(
	readSnapshot: PublicSnapshotReader,
) {
	return async (): Promise<Response> => {
		const snapshot = await readSnapshot();
		const dto: PublicAccountsDto = toPublicAccountsDto(snapshot);
		return jsonResponse(dto);
	};
}
