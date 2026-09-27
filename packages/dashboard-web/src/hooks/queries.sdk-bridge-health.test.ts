import { describe, expect, it } from "bun:test";
import { queryKeys } from "../lib/query-keys";
import { sdkBridgeHealthQueryOptions } from "./queries";

describe("sdkBridgeHealthQueryOptions", () => {
	it("uses the shared key factory, one entry per range", () => {
		expect(sdkBridgeHealthQueryOptions("24h").queryKey).toEqual(
			queryKeys.sdkBridgeHealth("24h"),
		);
		expect(sdkBridgeHealthQueryOptions("24h").queryKey).not.toEqual(
			sdkBridgeHealthQueryOptions("7d").queryKey,
		);
	});

	it("takes no filter dimension", () => {
		expect(JSON.stringify(queryKeys.sdkBridgeHealth("24h"))).not.toContain(
			"filters",
		);
	});
});
