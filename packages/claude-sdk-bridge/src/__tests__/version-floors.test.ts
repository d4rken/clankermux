import { describe, expect, it } from "bun:test";
import type { SdkBridgeInnerOutcome } from "@clankermux/types";
import { createVersionFloors, VERSION_FLOOR_TTL_MS } from "../version-floors";

function rejection(
	extra: Partial<SdkBridgeInnerOutcome> = {},
): SdkBridgeInnerOutcome {
	return {
		requestId: "r1",
		status: 400,
		errorType: "invalid_request_error",
		errorCode: "claude_code_version_too_old",
		message:
			"Claude Code 2.1.280 does not support this model; version 2.1.290 or newer is required.",
		retryAfter: null,
		accountId: "acct-a",
		model: "claude-opus-6",
		...extra,
	};
}

describe("version floors", () => {
	it("learns the floor a rejection names, for the bare model id", () => {
		let now = 1_000;
		const floors = createVersionFloors(() => now);
		expect(floors.observe(rejection())).toEqual({
			model: "claude-opus-6",
			requiredVersion: "2.1.290",
			rejectedVersion: "2.1.280",
			learnedAt: 1_000,
			expiresAt: 1_000 + VERSION_FLOOR_TTL_MS,
		});
		expect(floors.get("claude-opus-6")?.requiredVersion).toBe("2.1.290");
		expect(floors.get("Claude-Opus-6[1m]")?.requiredVersion).toBe("2.1.290");
		expect(floors.get("claude-sonnet-5")).toBeNull();
		now += VERSION_FLOOR_TTL_MS;
		expect(floors.get("claude-opus-6")).toBeNull();
		expect(floors.all()).toEqual([]);
	});

	it("answers a repeated rejection with null, restarting the expiry", () => {
		let now = 0;
		const floors = createVersionFloors(() => now);
		expect(floors.observe(rejection())).not.toBeNull();
		now = 10;
		expect(floors.observe(rejection())).toBeNull();
		expect(floors.get("claude-opus-6")?.expiresAt).toBe(
			10 + VERSION_FLOOR_TTL_MS,
		);
		expect(
			floors.observe(
				rejection({
					message:
						"Claude Code 2.1.280 does not support this model; version 2.1.300 or newer is required.",
				}),
			)?.requiredVersion,
		).toBe("2.1.300");
	});

	it("compares versions numerically", () => {
		const floors = createVersionFloors(() => 0);
		expect(
			floors.observe(
				rejection({
					message:
						"Claude Code 2.1.99 does not support this model; version 2.1.100 or newer is required.",
				}),
			)?.requiredVersion,
		).toBe("2.1.100");
	});

	it.each([
		[
			"a required version no newer than the rejected one",
			{
				message:
					"Claude Code 2.1.290 does not support this model; version 2.1.280 or newer is required.",
			},
		],
		[
			"no required version",
			{ message: "Claude Code 2.1.280 does not support this model." },
		],
		[
			"no rejected version",
			{
				message:
					"This client does not support this model; version 2.1.290 or newer is required.",
			},
		],
		["no model", { model: null }],
		["another failure", { errorCode: null, message: "Overloaded" }],
		["another status", { status: 403 }],
	])("learns nothing from %s", (_, extra) => {
		const floors = createVersionFloors(() => 0);
		expect(floors.observe(rejection(extra))).toBeNull();
		expect(floors.all()).toEqual([]);
	});
});
