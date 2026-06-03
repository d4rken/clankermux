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
	MEMORY_SNAPSHOT_RETENTION_DAYS: process.env.MEMORY_SNAPSHOT_RETENTION_DAYS,
};

function makeConfig(): { config: Config; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "clankermux-config-"));
	return {
		config: new Config(join(dir, "config.json")),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("memory snapshot retention days", () => {
	afterEach(() => {
		if (ORIGINAL_ENV.MEMORY_SNAPSHOT_RETENTION_DAYS === undefined) {
			delete process.env.MEMORY_SNAPSHOT_RETENTION_DAYS;
		} else {
			process.env.MEMORY_SNAPSHOT_RETENTION_DAYS =
				ORIGINAL_ENV.MEMORY_SNAPSHOT_RETENTION_DAYS;
		}
	});

	it("defaults to 14 days", () => {
		delete process.env.MEMORY_SNAPSHOT_RETENTION_DAYS;
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getMemorySnapshotRetentionDays()).toBe(14);
		} finally {
			cleanup();
		}
	});

	it("persists set values and reads them back", () => {
		delete process.env.MEMORY_SNAPSHOT_RETENTION_DAYS;
		const { config, cleanup } = makeConfig();
		try {
			config.setMemorySnapshotRetentionDays(30);
			expect(config.getMemorySnapshotRetentionDays()).toBe(30);
		} finally {
			cleanup();
		}
	});

	it("clamps set values to the 1..3650 range", () => {
		delete process.env.MEMORY_SNAPSHOT_RETENTION_DAYS;
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

	it("lets the env override win and clamps it", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setMemorySnapshotRetentionDays(20);
			process.env.MEMORY_SNAPSHOT_RETENTION_DAYS = "200";
			expect(config.getMemorySnapshotRetentionDays()).toBe(200);
			process.env.MEMORY_SNAPSHOT_RETENTION_DAYS = "999999";
			expect(config.getMemorySnapshotRetentionDays()).toBe(3650);
		} finally {
			cleanup();
		}
	});

	it("includes the value in getAllSettings()", () => {
		delete process.env.MEMORY_SNAPSHOT_RETENTION_DAYS;
		const { config, cleanup } = makeConfig();
		try {
			config.setMemorySnapshotRetentionDays(21);
			expect(config.getAllSettings().memory_snapshot_retention_days).toBe(21);
		} finally {
			cleanup();
		}
	});
});
