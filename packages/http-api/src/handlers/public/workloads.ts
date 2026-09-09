import { jsonResponse } from "@clankermux/http-common";
import type { PublicSnapshotReader } from "../../services/public-snapshot";
import type { createPublicWeeklyReader } from "../../services/public-workloads";
import { NO_STORE_HEADERS } from "./cache-headers";
import { toPublicWorkloadsDto } from "./workloads-dto";
export function createPublicWorkloadsHandler(
	readSnapshot: PublicSnapshotReader,
	readWeekly: ReturnType<typeof createPublicWeeklyReader>,
) {
	return async (): Promise<Response> => {
		const [snapshot, weekly] = await Promise.all([
			readSnapshot(),
			readWeekly(),
		]);
		return jsonResponse(
			toPublicWorkloadsDto(
				snapshot.workloadAvailability ?? [],
				weekly.workloads,
				weekly.computedAtMs,
				Date.now(),
			),
			200,
			NO_STORE_HEADERS,
		);
	};
}
