/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, type ConfigData } from "./index";

/**
 * Each test gets its own temp dir + config path so nothing is shared. `file`
 * seeds the config file BEFORE construction, which is the only way to exercise
 * the load-time legacy migration.
 */
function makeConfig(file?: ConfigData): {
	config: Config;
	path: string;
	readFile: () => ConfigData;
	cleanup: () => void;
} {
	const dir = mkdtempSync(join(tmpdir(), "clankermux-config-"));
	const path = join(dir, "config.json");
	if (file) writeFileSync(path, JSON.stringify(file, null, 2), "utf8");
	return {
		config: new Config(path),
		path,
		readFile: () => JSON.parse(readFileSync(path, "utf8")) as ConfigData,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

// Both env vars are read by getPayloadRetentionHours(); capture and restore
// them around every test (including the `delete` case) so nothing leaks into
// sibling suites running in the same process.
let priorHoursEnv: string | undefined;
let priorDaysEnv: string | undefined;

beforeEach(() => {
	priorHoursEnv = process.env.PAYLOAD_RETENTION_HOURS;
	priorDaysEnv = process.env.DATA_RETENTION_DAYS;
	delete process.env.PAYLOAD_RETENTION_HOURS;
	delete process.env.DATA_RETENTION_DAYS;
});

afterEach(() => {
	if (priorHoursEnv === undefined) delete process.env.PAYLOAD_RETENTION_HOURS;
	else process.env.PAYLOAD_RETENTION_HOURS = priorHoursEnv;
	if (priorDaysEnv === undefined) delete process.env.DATA_RETENTION_DAYS;
	else process.env.DATA_RETENTION_DAYS = priorDaysEnv;
});

describe("payload retention hours", () => {
	it("defaults to 24 hours when neither the key nor the env var is present", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getPayloadRetentionHours()).toBe(24);
		} finally {
			cleanup();
		}
	});

	it("returns an explicitly saved payload_retention_hours verbatim", () => {
		const { config, cleanup } = makeConfig({ payload_retention_hours: 12 });
		try {
			expect(config.getPayloadRetentionHours()).toBe(12);
		} finally {
			cleanup();
		}
	});

	it("persists a value set through the setter", () => {
		const { config, readFile, cleanup } = makeConfig();
		try {
			config.setPayloadRetentionHours(12);
			expect(config.getPayloadRetentionHours()).toBe(12);
			expect(readFile().payload_retention_hours).toBe(12);
		} finally {
			cleanup();
		}
	});

	describe("legacy data_retention_days migration", () => {
		it("converts a legacy 1-day file value to 24 hours", () => {
			const { config, cleanup } = makeConfig({ data_retention_days: 1 });
			try {
				expect(config.getPayloadRetentionHours()).toBe(24);
			} finally {
				cleanup();
			}
		});

		it("converts a legacy 3-day file value to 72 hours", () => {
			const { config, cleanup } = makeConfig({ data_retention_days: 3 });
			try {
				expect(config.getPayloadRetentionHours()).toBe(72);
			} finally {
				cleanup();
			}
		});

		it("exposes the converted value in getAllSettings() and drops the legacy key", () => {
			const { config, cleanup } = makeConfig({ data_retention_days: 3 });
			try {
				const settings = config.getAllSettings();
				expect(settings.payload_retention_hours).toBe(72);
				expect(settings).not.toHaveProperty("data_retention_days");
			} finally {
				cleanup();
			}
		});

		it("lets payload_retention_hours win when both keys are present", () => {
			const { config, cleanup } = makeConfig({
				data_retention_days: 3,
				payload_retention_hours: 6,
			});
			try {
				expect(config.getPayloadRetentionHours()).toBe(6);
				const settings = config.getAllSettings();
				expect(settings.payload_retention_hours).toBe(6);
				expect(settings).not.toHaveProperty("data_retention_days");
			} finally {
				cleanup();
			}
		});

		it("does not resurrect the legacy key when an unrelated setting is written", () => {
			// set() serializes the WHOLE of this.data, so a migration that only
			// stripped the legacy key on the payload-retention write path would
			// re-persist data_retention_days here.
			const { config, readFile, cleanup } = makeConfig({
				data_retention_days: 3,
			});
			try {
				config.setRequestRetentionDays(90);
				const onDisk = readFile();
				expect(onDisk).not.toHaveProperty("data_retention_days");
				expect(onDisk.payload_retention_hours).toBe(72);
				expect(onDisk.request_retention_days).toBe(90);
			} finally {
				cleanup();
			}
		});

		it("clamps an oversized legacy value to 8760 hours", () => {
			const { config, cleanup } = makeConfig({ data_retention_days: 9999 });
			try {
				expect(config.getPayloadRetentionHours()).toBe(8760);
			} finally {
				cleanup();
			}
		});
	});

	describe("clamping", () => {
		it("clamps set values below the minimum to 1 hour", () => {
			const { config, cleanup } = makeConfig();
			try {
				config.setPayloadRetentionHours(0);
				expect(config.getPayloadRetentionHours()).toBe(1);
				config.setPayloadRetentionHours(-5);
				expect(config.getPayloadRetentionHours()).toBe(1);
			} finally {
				cleanup();
			}
		});

		it("clamps set values above the maximum to 8760 hours", () => {
			const { config, cleanup } = makeConfig();
			try {
				config.setPayloadRetentionHours(99999);
				expect(config.getPayloadRetentionHours()).toBe(8760);
			} finally {
				cleanup();
			}
		});

		it("clamps a raw on-disk value on read", () => {
			const { config, cleanup } = makeConfig({
				payload_retention_hours: 99999,
			});
			try {
				expect(config.getPayloadRetentionHours()).toBe(8760);
			} finally {
				cleanup();
			}
		});
	});

	describe("environment precedence", () => {
		it("PAYLOAD_RETENTION_HOURS beats both file keys", () => {
			process.env.PAYLOAD_RETENTION_HOURS = "6";
			const { config, cleanup } = makeConfig({
				data_retention_days: 3,
				payload_retention_hours: 48,
			});
			try {
				expect(config.getPayloadRetentionHours()).toBe(6);
			} finally {
				cleanup();
			}
		});

		it("honours the deprecated DATA_RETENTION_DAYS env var (×24) over the file", () => {
			// Pre-hours deployments ship DATA_RETENTION_DAYS=3; dropping this reader
			// would silently shrink their window from 72h to 24h and delete payloads.
			process.env.DATA_RETENTION_DAYS = "3";
			const { config, cleanup } = makeConfig({ payload_retention_hours: 48 });
			try {
				expect(config.getPayloadRetentionHours()).toBe(72);
			} finally {
				cleanup();
			}
		});

		it("prefers PAYLOAD_RETENTION_HOURS over the deprecated DATA_RETENTION_DAYS", () => {
			process.env.PAYLOAD_RETENTION_HOURS = "6";
			process.env.DATA_RETENTION_DAYS = "3";
			const { config, cleanup } = makeConfig();
			try {
				expect(config.getPayloadRetentionHours()).toBe(6);
			} finally {
				cleanup();
			}
		});

		it("clamps env values into the 1..8760 range", () => {
			process.env.PAYLOAD_RETENTION_HOURS = "99999";
			const { config, cleanup } = makeConfig();
			try {
				expect(config.getPayloadRetentionHours()).toBe(8760);
			} finally {
				cleanup();
			}
		});

		it("falls through to the next source when PAYLOAD_RETENTION_HOURS is non-numeric", () => {
			process.env.PAYLOAD_RETENTION_HOURS = "soon";
			const { config, cleanup } = makeConfig({ payload_retention_hours: 12 });
			try {
				expect(config.getPayloadRetentionHours()).toBe(12);
			} finally {
				cleanup();
			}
		});

		it("falls through to the file when DATA_RETENTION_DAYS is non-numeric", () => {
			process.env.DATA_RETENTION_DAYS = "forever";
			const { config, cleanup } = makeConfig({ payload_retention_hours: 12 });
			try {
				expect(config.getPayloadRetentionHours()).toBe(12);
			} finally {
				cleanup();
			}
		});
	});

	describe("getPayloadRetentionMs()", () => {
		it("returns the configured hours in milliseconds", () => {
			const { config, cleanup } = makeConfig({ payload_retention_hours: 12 });
			try {
				expect(config.getPayloadRetentionMs()).toBe(12 * 3_600_000);
				expect(config.getPayloadRetentionMs()).toBe(
					config.getPayloadRetentionHours() * 3_600_000,
				);
			} finally {
				cleanup();
			}
		});

		it("returns the default window in milliseconds", () => {
			const { config, cleanup } = makeConfig();
			try {
				expect(config.getPayloadRetentionMs()).toBe(24 * 3_600_000);
				expect(config.getPayloadRetentionMs()).toBe(
					config.getPayloadRetentionHours() * 3_600_000,
				);
			} finally {
				cleanup();
			}
		});
	});
});
