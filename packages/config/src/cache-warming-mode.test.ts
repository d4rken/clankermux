/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

const ORIGINAL_ENV = {
	CACHE_WARMING_MODE: process.env.CACHE_WARMING_MODE,
	CACHE_WARMING_ENABLED: process.env.CACHE_WARMING_ENABLED,
	CACHE_KEEPALIVE_SNAPSHOT_RETENTION_DAYS:
		process.env.CACHE_KEEPALIVE_SNAPSHOT_RETENTION_DAYS,
};

function restoreEnv(): void {
	for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

function makeConfig(): { config: Config; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "clankermux-config-"));
	return {
		config: new Config(join(dir, "config.json")),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("cache warming mode", () => {
	afterEach(() => {
		restoreEnv();
	});

	it("defaults to off", () => {
		delete process.env.CACHE_WARMING_MODE;
		delete process.env.CACHE_WARMING_ENABLED;
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getCacheWarmingMode()).toBe("off");
			expect(config.getCacheWarmingEnabled()).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("persists set values and reads them back", () => {
		delete process.env.CACHE_WARMING_MODE;
		delete process.env.CACHE_WARMING_ENABLED;
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

	it("CACHE_WARMING_MODE env wins when a valid mode", () => {
		delete process.env.CACHE_WARMING_ENABLED;
		const { config, cleanup } = makeConfig();
		try {
			config.setCacheWarmingMode("off");
			process.env.CACHE_WARMING_MODE = "dynamic";
			expect(config.getCacheWarmingMode()).toBe("dynamic");
			process.env.CACHE_WARMING_MODE = "static";
			expect(config.getCacheWarmingMode()).toBe("static");
		} finally {
			cleanup();
		}
	});

	it("ignores an invalid CACHE_WARMING_MODE env value", () => {
		delete process.env.CACHE_WARMING_ENABLED;
		const { config, cleanup } = makeConfig();
		try {
			config.setCacheWarmingMode("static");
			process.env.CACHE_WARMING_MODE = "bogus";
			// falls through to the file value
			expect(config.getCacheWarmingMode()).toBe("static");
		} finally {
			cleanup();
		}
	});

	it("legacy CACHE_WARMING_ENABLED env maps to dynamic/off", () => {
		delete process.env.CACHE_WARMING_MODE;
		const { config, cleanup } = makeConfig();
		try {
			process.env.CACHE_WARMING_ENABLED = "true";
			expect(config.getCacheWarmingMode()).toBe("dynamic");
			process.env.CACHE_WARMING_ENABLED = "false";
			expect(config.getCacheWarmingMode()).toBe("off");
		} finally {
			cleanup();
		}
	});

	it("CACHE_WARMING_MODE env takes precedence over legacy CACHE_WARMING_ENABLED", () => {
		const { config, cleanup } = makeConfig();
		try {
			process.env.CACHE_WARMING_MODE = "static";
			process.env.CACHE_WARMING_ENABLED = "false";
			expect(config.getCacheWarmingMode()).toBe("static");
		} finally {
			cleanup();
		}
	});

	it("legacy cache_warming_enabled file value maps to dynamic/off", () => {
		delete process.env.CACHE_WARMING_MODE;
		delete process.env.CACHE_WARMING_ENABLED;
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

	it("includes cache_warming_mode in getAllSettings()", () => {
		delete process.env.CACHE_WARMING_MODE;
		delete process.env.CACHE_WARMING_ENABLED;
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
	afterEach(() => {
		restoreEnv();
	});

	it("defaults to 30 days", () => {
		delete process.env.CACHE_KEEPALIVE_SNAPSHOT_RETENTION_DAYS;
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getCacheKeepaliveSnapshotRetentionDays()).toBe(30);
		} finally {
			cleanup();
		}
	});

	it("persists set values and reads them back", () => {
		delete process.env.CACHE_KEEPALIVE_SNAPSHOT_RETENTION_DAYS;
		const { config, cleanup } = makeConfig();
		try {
			config.setCacheKeepaliveSnapshotRetentionDays(60);
			expect(config.getCacheKeepaliveSnapshotRetentionDays()).toBe(60);
		} finally {
			cleanup();
		}
	});

	it("clamps set values to the 1..3650 range", () => {
		delete process.env.CACHE_KEEPALIVE_SNAPSHOT_RETENTION_DAYS;
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

	it("lets the env override win and clamps it", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setCacheKeepaliveSnapshotRetentionDays(20);
			process.env.CACHE_KEEPALIVE_SNAPSHOT_RETENTION_DAYS = "200";
			expect(config.getCacheKeepaliveSnapshotRetentionDays()).toBe(200);
			process.env.CACHE_KEEPALIVE_SNAPSHOT_RETENTION_DAYS = "999999";
			expect(config.getCacheKeepaliveSnapshotRetentionDays()).toBe(3650);
		} finally {
			cleanup();
		}
	});

	it("includes the value in getAllSettings()", () => {
		delete process.env.CACHE_KEEPALIVE_SNAPSHOT_RETENTION_DAYS;
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
