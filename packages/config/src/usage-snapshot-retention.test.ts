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

describe("usage snapshot retention days", () => {
	it("defaults to 90 days when the key is absent", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getUsageSnapshotRetentionDays()).toBe(90);
		} finally {
			cleanup();
		}
	});

	it("honors an explicitly saved value above the new default (e.g. 3650)", () => {
		// The 3650 → 90 default change must NOT clobber a user who explicitly
		// opted into a longer window; the clamp max stays 3650.
		const { config, cleanup } = makeConfig();
		try {
			config.setUsageSnapshotRetentionDays(3650);
			expect(config.getUsageSnapshotRetentionDays()).toBe(3650);
		} finally {
			cleanup();
		}
	});

	it("honors an explicitly saved value below the new default (e.g. 30)", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setUsageSnapshotRetentionDays(30);
			expect(config.getUsageSnapshotRetentionDays()).toBe(30);
		} finally {
			cleanup();
		}
	});

	it("persists set values and reads them back", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setUsageSnapshotRetentionDays(180);
			expect(config.getUsageSnapshotRetentionDays()).toBe(180);
		} finally {
			cleanup();
		}
	});

	it("clamps set values to the 1..3650 range", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setUsageSnapshotRetentionDays(0);
			expect(config.getUsageSnapshotRetentionDays()).toBe(1);
			config.setUsageSnapshotRetentionDays(99999);
			expect(config.getUsageSnapshotRetentionDays()).toBe(3650);
		} finally {
			cleanup();
		}
	});

	it("clamps a raw on-disk value on read", () => {
		const { config, cleanup } = makeConfig();
		try {
			// Raw set bypasses the clamping setter, so the clamp must happen on read.
			config.set("usage_snapshot_retention_days", 999999);
			expect(config.getUsageSnapshotRetentionDays()).toBe(3650);
		} finally {
			cleanup();
		}
	});

	it("includes the value in getAllSettings()", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setUsageSnapshotRetentionDays(45);
			expect(config.getAllSettings().usage_snapshot_retention_days).toBe(45);
		} finally {
			cleanup();
		}
	});
});
