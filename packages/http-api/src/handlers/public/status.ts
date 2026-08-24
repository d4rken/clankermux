import { getVersion } from "@clankermux/core";
import { jsonResponse } from "@clankermux/http-common";
import type { PublicSnapshotReader } from "../../services/public-snapshot";
import { NO_STORE_HEADERS } from "./cache-headers";
import { type PublicStatusDto, toPublicStatusDto } from "./dto";

/**
 * `GET /public/v1/status` — the whole deployment in one flat record, for a
 * device with no room to correlate anything.
 *
 * Always 200, unlike `/health`, which answers 503 for a non-ok pool. A desk
 * panel polling this needs the BODY on a degraded pool; a non-2xx would make
 * most embedded HTTP clients discard it and show nothing at the exact moment
 * there is something to show. The `status` field carries the verdict instead.
 */
export function createPublicStatusHandler(
	readSnapshot: PublicSnapshotReader,
	// The shared resolver, so this reports the same version as every other
	// surface. It caches after the first read.
	readVersion: () => Promise<string> = getVersion,
) {
	return async (): Promise<Response> => {
		const [snapshot, version] = await Promise.all([
			readSnapshot(),
			readVersion(),
		]);
		const dto: PublicStatusDto = toPublicStatusDto(snapshot, {
			uptimeS: Math.round(process.uptime()),
			version,
		});
		return jsonResponse(dto, 200, NO_STORE_HEADERS);
	};
}
