import { jsonResponse } from "@clankermux/http-common";
import type { PublicRunwayReader } from "../../services/public-runway";
import { NO_STORE_HEADERS } from "./cache-headers";
import { type PublicRunwayDto, toPublicRunwayDto } from "./dto";

/**
 * `GET /public/v1/runway` — the pool's quota projection, and only the pool's.
 *
 * A resource of its own rather than a field on `/public/v1/status` because it
 * is the one read here that costs real work: the scan resolves every account's
 * usage through several freshness tiers and regresses the stored history. A
 * panel applet polling `status` every few seconds must not pay for it, and a
 * desk panel that only wants a run-out estimate must not have to parse the whole
 * pool to get one.
 */
export function createPublicRunwayHandler(readRunway: PublicRunwayReader) {
	return async (): Promise<Response> => {
		const dto: PublicRunwayDto = toPublicRunwayDto(await readRunway());
		return jsonResponse(dto, 200, NO_STORE_HEADERS);
	};
}
