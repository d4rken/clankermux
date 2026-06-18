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
	USAGE_SNAPSHOT_RETENTION_DAYS: process.env.USAGE_SNAPSHOT_RETENTION_DAYS,
};

function makeConfig(): { config: Config; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-config-"));
	return {
		config: new Config(join(dir, "config.json")),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("usage snapshot retention days", () => {
	afterEach(() => {
		if (ORIGINAL_ENV.USAGE_SNAPSHOT_RETENTION_DAYS === undefined) {
			delete process.env.USAGE_SNAPSHOT_RETENTION_DAYS;
		} else {
			process.env.USAGE_SNAPSHOT_RETENTION_DAYS =
				ORIGINAL_ENV.USAGE_SNAPSHOT_RETENTION_DAYS;
		}
	});

	it("defaults to 3650 days", () => {
		delete process.env.USAGE_SNAPSHOT_RETENTION_DAYS;
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getUsageSnapshotRetentionDays()).toBe(3650);
		} finally {
			cleanup();
		}
	});

	it("persists set values and reads them back", () => {
		delete process.env.USAGE_SNAPSHOT_RETENTION_DAYS;
		const { config, cleanup } = makeConfig();
		try {
			config.setUsageSnapshotRetentionDays(180);
			expect(config.getUsageSnapshotRetentionDays()).toBe(180);
		} finally {
			cleanup();
		}
	});

	it("clamps set values to the 1..3650 range", () => {
		delete process.env.USAGE_SNAPSHOT_RETENTION_DAYS;
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

	it("lets the env override win and clamps it", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setUsageSnapshotRetentionDays(30);
			process.env.USAGE_SNAPSHOT_RETENTION_DAYS = "200";
			expect(config.getUsageSnapshotRetentionDays()).toBe(200);
			process.env.USAGE_SNAPSHOT_RETENTION_DAYS = "999999";
			expect(config.getUsageSnapshotRetentionDays()).toBe(3650);
		} finally {
			cleanup();
		}
	});

	it("includes the value in getAllSettings()", () => {
		delete process.env.USAGE_SNAPSHOT_RETENTION_DAYS;
		const { config, cleanup } = makeConfig();
		try {
			config.setUsageSnapshotRetentionDays(45);
			expect(config.getAllSettings().usage_snapshot_retention_days).toBe(45);
		} finally {
			cleanup();
		}
	});
});
