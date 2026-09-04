import { jsonResponse } from "@clankermux/http-common";
import type { PublicPacingReader } from "../../services/public-pacing";
import { NO_STORE_HEADERS } from "./cache-headers";
import { type PublicPacingDto, toPublicPacingDto } from "./dto";

/**
 * `GET /public/v1/pacing` — the per-class pacing rollup, de-identified.
 *
 * Always 200, on the same grounds as `status`: a pool being paced hard is a
 * measurement, not a server error, and a widget that treated it as one would go
 * blank at exactly the moment its reading matters.
 */
export function createPublicPacingHandler(
	readPacing: PublicPacingReader,
): () => Promise<Response> {
	return async (): Promise<Response> => {
		const dto: PublicPacingDto = toPublicPacingDto(await readPacing());
		return jsonResponse(dto, 200, NO_STORE_HEADERS);
	};
}
