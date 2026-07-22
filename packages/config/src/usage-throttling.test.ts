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

describe("usage throttling flags", () => {
	it("defaults to disabled", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getUsageThrottlingFiveHourEnabled()).toBe(false);
			expect(config.getUsageThrottlingWeeklyEnabled()).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("persists set values and reads them back", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setUsageThrottlingFiveHourEnabled(true);
			config.setUsageThrottlingWeeklyEnabled(true);
			expect(config.getUsageThrottlingFiveHourEnabled()).toBe(true);
			expect(config.getUsageThrottlingWeeklyEnabled()).toBe(true);

			config.setUsageThrottlingFiveHourEnabled(false);
			config.setUsageThrottlingWeeklyEnabled(false);
			expect(config.getUsageThrottlingFiveHourEnabled()).toBe(false);
			expect(config.getUsageThrottlingWeeklyEnabled()).toBe(false);
		} finally {
			cleanup();
		}
	});
});
