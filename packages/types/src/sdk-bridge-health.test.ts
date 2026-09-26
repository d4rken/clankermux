import { describe, expect, it } from "bun:test";
import {
	SDK_BRIDGE_TURN_STATUSES,
	type SdkBridgeTurnStatus,
} from "./sdk-bridge";
import {
	type SdkBridgeFailureRateRole,
	sdkBridgeFailureRateRole,
} from "./sdk-bridge-health";

describe("sdkBridgeFailureRateRole", () => {
	it("places every status", () => {
		const roles = Object.fromEntries(
			SDK_BRIDGE_TURN_STATUSES.map((s) => [s, sdkBridgeFailureRateRole(s)]),
		);
		expect(roles).toEqual({
			running: "excluded",
			released: "excluded",
			completed: "finished",
			failed: "failure",
			aborted: "excluded",
			timed_out: "failure",
			shutdown: "finished",
			rejected: "excluded",
		} satisfies Record<SdkBridgeTurnStatus, SdkBridgeFailureRateRole>);
	});
});
