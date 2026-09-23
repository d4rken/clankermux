import { describe, expect, it } from "bun:test";
import {
	ClaudeDeviceRegistry,
	extractClaudeCliDeviceId,
} from "./claude-device-registry";

const DEVICE = "e01ccdf3".repeat(8);
const CLI = new Headers({ "user-agent": "claude-cli/2.1.280 (external, cli)" });

function body(userId: unknown): Record<string, unknown> {
	return { model: "claude-sonnet-5", metadata: { user_id: userId } };
}

function userId(fields: Record<string, unknown>): string {
	return JSON.stringify(fields);
}

describe("extractClaudeCliDeviceId", () => {
	it("reads the device of an interactive Claude Code request", () => {
		expect(
			extractClaudeCliDeviceId(
				CLI,
				body(
					userId({
						device_id: DEVICE,
						account_uuid: "",
						session_id: "8644f453-0000-4000-8000-000000000000",
					}),
				),
			),
		).toBe(DEVICE);
	});

	it("ignores other clients", () => {
		for (const ua of [
			"claude-cli/2.1.280 (external, sdk-ts, agent-sdk/0.3.280)",
			"claude-code/2.1.280",
			"pi/1.0",
		])
			expect(
				extractClaudeCliDeviceId(
					new Headers({ "user-agent": ua }),
					body(userId({ device_id: DEVICE })),
				),
			).toBeNull();
		expect(
			extractClaudeCliDeviceId(
				new Headers(),
				body(userId({ device_id: DEVICE })),
			),
		).toBeNull();
	});

	it("rejects malformed values", () => {
		for (const value of [
			undefined,
			42,
			"user_abc_account__session_8644f453",
			"{not json",
			"[]",
			userId({ device_id: DEVICE.toUpperCase() }),
			userId({ device_id: DEVICE.slice(1) }),
			userId({ device_id: `${DEVICE}0` }),
			userId({ device_id: `${DEVICE.slice(1)}g` }),
			userId({ device_id: 7 }),
			userId({ account_uuid: "", session_id: "s" }),
			userId({ device_id: DEVICE, pad: "x".repeat(1024) }),
		])
			expect(extractClaudeCliDeviceId(CLI, body(value))).toBeNull();
		expect(extractClaudeCliDeviceId(CLI, null)).toBeNull();
		expect(extractClaudeCliDeviceId(CLI, { metadata: "x" })).toBeNull();
	});
});

describe("ClaudeDeviceRegistry", () => {
	it("keeps the most recently recorded device per account", () => {
		const registry = new ClaudeDeviceRegistry();
		const other = "0123456789abcdef".repeat(4);
		registry.record("acc-1", DEVICE);
		registry.record("acc-2", DEVICE);
		registry.record("acc-1", other);
		expect(registry.deviceIdFor("acc-1")).toBe(other);
		expect(registry.deviceIdFor("acc-2")).toBe(DEVICE);
		expect(registry.deviceIdFor("acc-3")).toBeNull();
	});

	it("reset forgets every account", () => {
		const registry = new ClaudeDeviceRegistry();
		registry.record("acc-1", DEVICE);
		registry.reset();
		expect(registry.deviceIdFor("acc-1")).toBeNull();
	});
});
