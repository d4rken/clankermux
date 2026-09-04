import { jsonResponse } from "@clankermux/http-common";
import type { PublicWorkloadHeadroomReader } from "../../services/public-workload-headroom";
import { NO_STORE_HEADERS } from "./cache-headers";
import {
	type PublicWorkloadHeadroomDto,
	toPublicWorkloadHeadroomDto,
} from "./dto";

/**
 * `GET /public/v1/workload-headroom` — how much more load each servable class
 * and each scoped model family can take.
 *
 * Always 200, on the same grounds as `pacing`: a workload with no room left is
 * a measurement, not a server error, and a widget that treated it as one would
 * go blank at exactly the moment its reading matters.
 */
export function createPublicWorkloadHeadroomHandler(
	readWorkloadHeadroom: PublicWorkloadHeadroomReader,
): () => Promise<Response> {
	return async (): Promise<Response> => {
		const dto: PublicWorkloadHeadroomDto = toPublicWorkloadHeadroomDto(
			await readWorkloadHeadroom(),
		);
		return jsonResponse(dto, 200, NO_STORE_HEADERS);
	};
}
