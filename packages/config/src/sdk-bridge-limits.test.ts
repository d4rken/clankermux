import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

function withConfig(
	file: Record<string, unknown> | null,
	run: (config: Config) => void,
): void {
	const dir = mkdtempSync(join(tmpdir(), "clankermux-config-"));
	try {
		const path = join(dir, "config.json");
		if (file) writeFileSync(path, JSON.stringify(file));
		run(new Config(path));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("SDK bridge limits", () => {
	it("defaults", () => {
		withConfig(null, (config) => {
			expect(config.getSdkBridgeMaxProcesses()).toBe(8);
			expect(config.getSdkBridgeParkedTimeoutMs()).toBe(15 * 60_000);
			expect(config.getSdkBridgeTurnDeadlineMs()).toBe(60 * 60_000);
			expect(config.getSdkBridgeMaxHistoryBytes()).toBe(64 * 1024 * 1024);
			expect(config.getSdkBridgeMaxTools()).toBe(1024);
			expect(config.getSdkBridgeMaxSchemaBytes()).toBe(8 * 1024 * 1024);
			expect(config.getSdkBridgeMaxParkedCallsPerTurn()).toBe(256);
			expect(config.getSdkBridgeMaxConcurrentRebuilds()).toBe(8);
		});
	});

	it("reads file values and clamps them", () => {
		withConfig(
			{
				sdk_bridge_max_processes: 100,
				sdk_bridge_parked_timeout_ms: 1_000,
				sdk_bridge_turn_deadline_ms: 90 * 60_000,
				sdk_bridge_max_tools: 0,
				sdk_bridge_max_concurrent_rebuilds: 2.6,
			},
			(config) => {
				expect(config.getSdkBridgeMaxProcesses()).toBe(32);
				expect(config.getSdkBridgeParkedTimeoutMs()).toBe(30_000);
				expect(config.getSdkBridgeTurnDeadlineMs()).toBe(90 * 60_000);
				expect(config.getSdkBridgeMaxTools()).toBe(1);
				expect(config.getSdkBridgeMaxConcurrentRebuilds()).toBe(3);
			},
		);
		withConfig({ sdk_bridge_max_processes: 0 }, (config) =>
			expect(config.getSdkBridgeMaxProcesses()).toBe(1),
		);
		withConfig({ sdk_bridge_parked_timeout_ms: 10 * 60 * 60_000 }, (config) =>
			expect(config.getSdkBridgeParkedTimeoutMs()).toBe(2 * 60 * 60_000),
		);
	});

	it("falls back to the default for a non-number", () => {
		withConfig({ sdk_bridge_max_processes: "12" }, (config) =>
			expect(config.getSdkBridgeMaxProcesses()).toBe(8),
		);
	});

	it("appears in the settings dump", () => {
		withConfig({ sdk_bridge_max_processes: 3 }, (config) => {
			const all = config.getAllSettings();
			expect(all.sdk_bridge_max_processes).toBe(3);
			expect(all.sdk_bridge_parked_timeout_ms).toBe(15 * 60_000);
			expect(all.sdk_bridge_turn_deadline_ms).toBe(60 * 60_000);
			expect(all.sdk_bridge_max_history_bytes).toBe(64 * 1024 * 1024);
			expect(all.sdk_bridge_max_tools).toBe(1024);
			expect(all.sdk_bridge_max_schema_bytes).toBe(8 * 1024 * 1024);
			expect(all.sdk_bridge_max_parked_calls_per_turn).toBe(256);
			expect(all.sdk_bridge_max_concurrent_rebuilds).toBe(8);
		});
	});
});
