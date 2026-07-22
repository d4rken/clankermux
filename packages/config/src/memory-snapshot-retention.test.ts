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

describe("memory snapshot retention days", () => {
	it("defaults to 14 days", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getMemorySnapshotRetentionDays()).toBe(14);
		} finally {
			cleanup();
		}
	});

	it("persists set values and reads them back", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setMemorySnapshotRetentionDays(30);
			expect(config.getMemorySnapshotRetentionDays()).toBe(30);
		} finally {
			cleanup();
		}
	});

	it("clamps set values to the 1..3650 range", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setMemorySnapshotRetentionDays(0);
			expect(config.getMemorySnapshotRetentionDays()).toBe(1);
			config.setMemorySnapshotRetentionDays(99999);
			expect(config.getMemorySnapshotRetentionDays()).toBe(3650);
		} finally {
			cleanup();
		}
	});

	it("clamps a raw on-disk value on read", () => {
		const { config, cleanup } = makeConfig();
		try {
			// Raw set bypasses the clamping setter, so the clamp must happen on read.
			config.set("memory_snapshot_retention_days", 999999);
			expect(config.getMemorySnapshotRetentionDays()).toBe(3650);
		} finally {
			cleanup();
		}
	});

	it("includes the value in getAllSettings()", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setMemorySnapshotRetentionDays(21);
			expect(config.getAllSettings().memory_snapshot_retention_days).toBe(21);
		} finally {
			cleanup();
		}
	});
});
