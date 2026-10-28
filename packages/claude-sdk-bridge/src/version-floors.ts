import { compareClaudeCliVersions } from "@clankermux/core";
import {
	type SdkBridgeInnerOutcome,
	type SdkBridgeVersionFloor,
	sdkBridgeWireModel,
} from "@clankermux/types";
import { claudeCodeVersionRejection } from "./errors";

/**
 * How long a learned floor keeps its model off the bridge. After it, one turn
 * tries the model again: the floor came from a single rejection, and the
 * Claude Code behind the bridge can change without this process noticing.
 */
export const VERSION_FLOOR_TTL_MS = 60 * 60 * 1000;

export interface VersionFloors {
	/**
	 * Learn from an inner call's outcome. Answers the floor when it is new or
	 * names other versions than the one in force, and null otherwise; a
	 * repeated rejection only restarts the floor's expiry.
	 */
	observe(outcome: SdkBridgeInnerOutcome): SdkBridgeVersionFloor | null;
	get(upstreamModel: string): SdkBridgeVersionFloor | null;
	/** The floors still in force. */
	all(): SdkBridgeVersionFloor[];
}

function floorKey(model: string): string {
	return sdkBridgeWireModel(model.trim()).toLowerCase();
}

/**
 * Per-model Claude Code version floors, learned only from a rejection that
 * names both versions and requires a newer one than the request carried.
 */
export function createVersionFloors(
	now: () => number = Date.now,
	ttlMs: number = VERSION_FLOOR_TTL_MS,
): VersionFloors {
	const floors = new Map<string, SdkBridgeVersionFloor>();
	const current = (key: string): SdkBridgeVersionFloor | null => {
		const floor = floors.get(key);
		if (!floor) return null;
		if (floor.expiresAt > now()) return floor;
		floors.delete(key);
		return null;
	};
	return {
		observe(outcome) {
			const rejection = claudeCodeVersionRejection(outcome);
			if (
				!outcome.model ||
				!rejection?.requiredVersion ||
				!rejection.rejectedVersion ||
				compareClaudeCliVersions(
					rejection.requiredVersion,
					rejection.rejectedVersion,
				) <= 0
			)
				return null;
			const learnedAt = now();
			const floor: SdkBridgeVersionFloor = {
				model: floorKey(outcome.model),
				requiredVersion: rejection.requiredVersion,
				rejectedVersion: rejection.rejectedVersion,
				learnedAt,
				expiresAt: learnedAt + ttlMs,
			};
			const previous = current(floor.model);
			floors.set(floor.model, floor);
			return previous?.requiredVersion === floor.requiredVersion &&
				previous.rejectedVersion === floor.rejectedVersion
				? null
				: floor;
		},
		get: (upstreamModel) => current(floorKey(upstreamModel)),
		all() {
			for (const key of [...floors.keys()]) current(key);
			return [...floors.values()];
		},
	};
}
