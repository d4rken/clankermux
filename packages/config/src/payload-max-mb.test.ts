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
 * seeds the config file BEFORE construction so on-disk values are exercised
 * through the same load path the live deployment uses.
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

// Capture and restore PAYLOAD_MAX_MB around every test (including the delete
// case) so nothing leaks into sibling suites running in the same process.
let priorEnv: string | undefined;

beforeEach(() => {
	priorEnv = process.env.PAYLOAD_MAX_MB;
	delete process.env.PAYLOAD_MAX_MB;
});

afterEach(() => {
	if (priorEnv === undefined) delete process.env.PAYLOAD_MAX_MB;
	else process.env.PAYLOAD_MAX_MB = priorEnv;
});

describe("payload max mb", () => {
	it("defaults to 0 (budget disabled) when neither the key nor the env var is present", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getPayloadMaxMb()).toBe(0);
		} finally {
			cleanup();
		}
	});

	it("returns an explicitly saved payload_max_mb verbatim", () => {
		const { config, cleanup } = makeConfig({ payload_max_mb: 4096 });
		try {
			expect(config.getPayloadMaxMb()).toBe(4096);
		} finally {
			cleanup();
		}
	});

	it("persists a value set through the setter", () => {
		const { config, readFile, cleanup } = makeConfig();
		try {
			config.setPayloadMaxMb(2048);
			expect(config.getPayloadMaxMb()).toBe(2048);
			expect(readFile().payload_max_mb).toBe(2048);
		} finally {
			cleanup();
		}
	});

	it("exposes the value in getAllSettings()", () => {
		const { config, cleanup } = makeConfig({ payload_max_mb: 512 });
		try {
			expect(config.getAllSettings().payload_max_mb).toBe(512);
		} finally {
			cleanup();
		}
	});

	describe("clamping", () => {
		it("clamps set values below the minimum to 0", () => {
			const { config, cleanup } = makeConfig();
			try {
				config.setPayloadMaxMb(-1);
				expect(config.getPayloadMaxMb()).toBe(0);
				config.setPayloadMaxMb(-9999);
				expect(config.getPayloadMaxMb()).toBe(0);
			} finally {
				cleanup();
			}
		});

		it("clamps set values above the maximum to 1048576 MB", () => {
			const { config, cleanup } = makeConfig();
			try {
				config.setPayloadMaxMb(99_999_999);
				expect(config.getPayloadMaxMb()).toBe(1_048_576);
			} finally {
				cleanup();
			}
		});

		it("clamps a raw on-disk value on read at both ends", () => {
			const high = makeConfig({ payload_max_mb: 99_999_999 });
			try {
				expect(high.config.getPayloadMaxMb()).toBe(1_048_576);
			} finally {
				high.cleanup();
			}
			const low = makeConfig({ payload_max_mb: -42 });
			try {
				expect(low.config.getPayloadMaxMb()).toBe(0);
			} finally {
				low.cleanup();
			}
		});
	});

	describe("environment precedence", () => {
		it("PAYLOAD_MAX_MB beats the file key", () => {
			process.env.PAYLOAD_MAX_MB = "1024";
			const { config, cleanup } = makeConfig({ payload_max_mb: 4096 });
			try {
				expect(config.getPayloadMaxMb()).toBe(1024);
			} finally {
				cleanup();
			}
		});

		it("honours an explicit PAYLOAD_MAX_MB=0 (disabled) over the file value", () => {
			// "0" is falsy as a string only after parsing — the reader must not treat
			// an explicit disable as "unset" and fall through to the file.
			process.env.PAYLOAD_MAX_MB = "0";
			const { config, cleanup } = makeConfig({ payload_max_mb: 4096 });
			try {
				expect(config.getPayloadMaxMb()).toBe(0);
			} finally {
				cleanup();
			}
		});

		it("clamps env values into the 0..1048576 range", () => {
			process.env.PAYLOAD_MAX_MB = "99999999";
			const { config, cleanup } = makeConfig();
			try {
				expect(config.getPayloadMaxMb()).toBe(1_048_576);
			} finally {
				cleanup();
			}
			process.env.PAYLOAD_MAX_MB = "-5";
			const negative = makeConfig();
			try {
				expect(negative.config.getPayloadMaxMb()).toBe(0);
			} finally {
				negative.cleanup();
			}
		});

		it("falls through to the file when PAYLOAD_MAX_MB is non-numeric", () => {
			process.env.PAYLOAD_MAX_MB = "plenty";
			const { config, cleanup } = makeConfig({ payload_max_mb: 256 });
			try {
				expect(config.getPayloadMaxMb()).toBe(256);
			} finally {
				cleanup();
			}
		});
	});

	describe("getPayloadMaxBytes()", () => {
		it("returns the configured megabytes in bytes", () => {
			const { config, cleanup } = makeConfig({ payload_max_mb: 3 });
			try {
				expect(config.getPayloadMaxBytes()).toBe(3 * 1024 * 1024);
				expect(config.getPayloadMaxBytes()).toBe(
					config.getPayloadMaxMb() * 1024 * 1024,
				);
			} finally {
				cleanup();
			}
		});

		it("returns 0 when the budget is disabled", () => {
			const { config, cleanup } = makeConfig();
			try {
				expect(config.getPayloadMaxBytes()).toBe(0);
			} finally {
				cleanup();
			}
		});
	});
});
