/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

function makeConfig(): { config: Config; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "clankermux-config-"));
	return {
		config: new Config(join(dir, "config.json")),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("cache warming mode", () => {
	it("defaults to off", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getCacheWarmingMode()).toBe("off");
			expect(config.getCacheWarmingEnabled()).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("persists set values and reads them back", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setCacheWarmingMode("static");
			expect(config.getCacheWarmingMode()).toBe("static");
			expect(config.getCacheWarmingEnabled()).toBe(true);
			config.setCacheWarmingMode("dynamic");
			expect(config.getCacheWarmingMode()).toBe("dynamic");
			config.setCacheWarmingMode("off");
			expect(config.getCacheWarmingMode()).toBe("off");
			expect(config.getCacheWarmingEnabled()).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("ignores an invalid cache_warming_mode file value", () => {
		const { config, cleanup } = makeConfig();
		try {
			// Legacy file boolean present → dynamic.
			config.set("cache_warming_enabled", true);
			// Simulate a hand-edited file with a bogus mode; falls through to the
			// legacy boolean.
			config.set("cache_warming_mode", "bogus");
			expect(config.getCacheWarmingMode()).toBe("dynamic");
		} finally {
			cleanup();
		}
	});

	it("legacy cache_warming_enabled file value maps to dynamic/off", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setCacheWarmingEnabled(true);
			expect(config.getCacheWarmingMode()).toBe("dynamic");
			config.setCacheWarmingEnabled(false);
			expect(config.getCacheWarmingMode()).toBe("off");
		} finally {
			cleanup();
		}
	});

	it("cache_warming_mode file field takes precedence over legacy boolean", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.set("cache_warming_enabled", false); // legacy boolean → off
			config.set("cache_warming_mode", "static"); // explicit mode wins
			expect(config.getCacheWarmingMode()).toBe("static");
		} finally {
			cleanup();
		}
	});

	it("includes cache_warming_mode in getAllSettings()", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setCacheWarmingMode("static");
			expect(config.getAllSettings().cache_warming_mode).toBe("static");
		} finally {
			cleanup();
		}
	});
});

describe("cache keepalive snapshot retention days", () => {
	it("defaults to 30 days", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getCacheKeepaliveSnapshotRetentionDays()).toBe(30);
		} finally {
			cleanup();
		}
	});

	it("persists set values and reads them back", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setCacheKeepaliveSnapshotRetentionDays(60);
			expect(config.getCacheKeepaliveSnapshotRetentionDays()).toBe(60);
		} finally {
			cleanup();
		}
	});

	it("clamps set values to the 1..3650 range", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setCacheKeepaliveSnapshotRetentionDays(0);
			expect(config.getCacheKeepaliveSnapshotRetentionDays()).toBe(1);
			config.setCacheKeepaliveSnapshotRetentionDays(99999);
			expect(config.getCacheKeepaliveSnapshotRetentionDays()).toBe(3650);
		} finally {
			cleanup();
		}
	});

	it("clamps a raw on-disk value on read", () => {
		const { config, cleanup } = makeConfig();
		try {
			// Simulate a hand-edited file value above the cap (raw set bypasses the
			// clamping setter, so the clamp must happen on read).
			config.set("cache_keepalive_snapshot_retention_days", 999999);
			expect(config.getCacheKeepaliveSnapshotRetentionDays()).toBe(3650);
		} finally {
			cleanup();
		}
	});

	it("includes the value in getAllSettings()", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setCacheKeepaliveSnapshotRetentionDays(21);
			expect(
				config.getAllSettings().cache_keepalive_snapshot_retention_days,
			).toBe(21);
		} finally {
			cleanup();
		}
	});
});

describe("cache warming risk factor", () => {
	it("defaults to 0.4", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getCacheWarmingRiskFactor()).toBe(0.4);
		} finally {
			cleanup();
		}
	});

	it("round-trips a set value", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setCacheWarmingRiskFactor(0.6);
			expect(config.getCacheWarmingRiskFactor()).toBeCloseTo(0.6, 10);
			expect(config.getAllSettings().cache_warming_risk_factor).toBeCloseTo(
				0.6,
				10,
			);
		} finally {
			cleanup();
		}
	});

	it("clamps out-of-range and non-finite values to [0, 1]", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setCacheWarmingRiskFactor(5);
			expect(config.getCacheWarmingRiskFactor()).toBe(1);
			config.setCacheWarmingRiskFactor(-2);
			expect(config.getCacheWarmingRiskFactor()).toBe(0);
			config.setCacheWarmingRiskFactor(Number.NaN);
			expect(config.getCacheWarmingRiskFactor()).toBe(0.4);
		} finally {
			cleanup();
		}
	});

	it("clamps a corrupt on-disk value on read", () => {
		const { config, cleanup } = makeConfig();
		try {
			// Simulate a hand-edited file value above the cap.
			config.set("cache_warming_risk_factor", 99);
			expect(config.getCacheWarmingRiskFactor()).toBe(1);
		} finally {
			cleanup();
		}
	});
});
