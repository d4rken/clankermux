import { jsonResponse } from "@clankermux/http-common";
import type { PublicStopsReader } from "../../services/public-stops";
import { NO_STORE_HEADERS } from "./cache-headers";
import { type PublicStopsDto, toPublicStopsDto } from "./dto";

/**
 * `GET /public/v1/stops` — what the pool actually refused, over a fixed seven
 * days.
 *
 * A resource of its own rather than a field on `/public/v1/status` for the same
 * reason as the runway: it costs a real scan of the request table, and a panel
 * applet polling `status` every few seconds must not pay for one. The reader
 * behind it memoizes, so this handler is a mapper and nothing else.
 */
export function createPublicStopsHandler(readStops: PublicStopsReader) {
	return async (): Promise<Response> => {
		const snapshot = await readStops();
		const dto: PublicStopsDto = toPublicStopsDto(
			snapshot.summary,
			snapshot.generatedAtMs,
		);
		return jsonResponse(dto, 200, NO_STORE_HEADERS);
	};
}
