import type { SdkBridgeRoutePlan } from "@clankermux/types";
import { type BridgeError, bridgeErrors } from "./errors";
import type { TurnBody } from "./turn-request";
import type { SdkBridgeLimits } from "./types";

export type AdmissionRejection = BridgeError & { reason: string };

function reject(reason: string, error: BridgeError): AdmissionRejection {
	return { ...error, reason };
}

/** A request body too large to parse at all. */
export function checkBodySize(
	bytes: number,
	limits: SdkBridgeLimits,
): AdmissionRejection | null {
	return bytes > limits.maxHistoryBytes
		? reject(
				"limit",
				bridgeErrors.limit("maxHistoryBytes", bytes, limits.maxHistoryBytes),
			)
		: null;
}

/**
 * Whether a new turn may start a Claude Code process. Every check runs before
 * anything is spawned. The safety limits sit orders of magnitude above real
 * sessions, so they only stop runaway requests.
 */
export function checkAdmission(input: {
	turn: TurnBody;
	plan: SdkBridgeRoutePlan;
	limits: SdkBridgeLimits;
	/** Claude Code processes alive now, parked ones included. */
	processes: number;
	rebuilds: number;
	needsRebuild: boolean;
}): AdmissionRejection | null {
	const { turn, plan, limits } = input;
	if (!plan.candidates.length)
		return reject("no_eligible_account", bridgeErrors.noEligibleAccount());
	const size = checkBodySize(turn.bodyBytes, limits);
	if (size) return size;
	if (turn.tools.length > limits.maxTools)
		return reject(
			"limit",
			bridgeErrors.limit("maxTools", turn.tools.length, limits.maxTools),
		);
	if (turn.schemaBytes > limits.maxSchemaBytes)
		return reject(
			"limit",
			bridgeErrors.limit(
				"maxSchemaBytes",
				turn.schemaBytes,
				limits.maxSchemaBytes,
			),
		);
	if (input.processes >= limits.maxProcesses)
		return reject("process_cap", bridgeErrors.processCap(limits.maxProcesses));
	if (input.needsRebuild && input.rebuilds >= limits.maxConcurrentRebuilds)
		return reject(
			"rebuild_cap",
			bridgeErrors.rebuildCap(limits.maxConcurrentRebuilds),
		);
	return null;
}
