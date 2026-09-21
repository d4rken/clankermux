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

describe("header retention days", () => {
	it("defaults to 90 days", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getHeaderRetentionDays()).toBe(90);
		} finally {
			cleanup();
		}
	});

	it("clamps a saved value into the 1..3650 range", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setHeaderRetentionDays(999_999);
			expect(config.getHeaderRetentionDays()).toBe(3650);
			config.setHeaderRetentionDays(0);
			expect(config.getHeaderRetentionDays()).toBe(1);
		} finally {
			cleanup();
		}
	});

	it("round-trips an explicit value through getAllSettings", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setHeaderRetentionDays(180);
			expect(config.getAllSettings().header_retention_days).toBe(180);
		} finally {
			cleanup();
		}
	});
});

describe("store headers", () => {
	it("defaults to on", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getStoreHeaders()).toBe(true);
		} finally {
			cleanup();
		}
	});

	// The switch exists so payload storage can be turned off without also
	// putting gaps in the long-range header series.
	it("is independent of store_payloads", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setStorePayloads(false);
			expect(config.getStoreHeaders()).toBe(true);
			config.setStoreHeaders(false);
			expect(config.getStoreHeaders()).toBe(false);
			expect(config.getStorePayloads()).toBe(false);
		} finally {
			cleanup();
		}
	});
});
