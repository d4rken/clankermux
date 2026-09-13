import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { isDebugEnabled, readEnv } from "./env";

// Every key any test here writes, so each case starts from a known state and
// leaves process.env exactly as it found it.
const TOUCHED_KEYS = [
	"CLANKERMUX_DB_PATH",
	"BETTER_CCFLARE_DB_PATH",
	"ccflare_DB_PATH",
	"DB_PATH",
	"CLANKERMUX_HOST",
	"HOST",
	"CLANKERMUX_DEBUG",
	"BETTER_CCFLARE_DEBUG",
	"ccflare_DEBUG",
	"DEBUG",
] as const;

let saved: Map<string, string | undefined>;

beforeEach(() => {
	saved = new Map(TOUCHED_KEYS.map((key) => [key, process.env[key]]));
	for (const key of TOUCHED_KEYS) {
		delete process.env[key];
	}
});

afterEach(() => {
	for (const [key, value] of saved) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
});

describe("readEnv", () => {
	it("resolves the CLANKERMUX_ prefix", () => {
		process.env.CLANKERMUX_DB_PATH = "/tmp/current.db";
		expect(readEnv("DB_PATH")).toBe("/tmp/current.db");
	});

	it("ignores the retired BETTER_CCFLARE_ and ccflare_ prefixes", () => {
		process.env.BETTER_CCFLARE_DB_PATH = "/tmp/legacy.db";
		process.env.ccflare_DB_PATH = "/tmp/deep-legacy.db";
		expect(readEnv("DB_PATH")).toBeUndefined();
	});

	it("ignores an unprefixed variable", () => {
		process.env.DB_PATH = "/tmp/bare.db";
		process.env.HOST = "10.0.0.1";
		expect(readEnv("DB_PATH")).toBeUndefined();
		expect(readEnv("HOST")).toBeUndefined();
	});

	it("reads the prefixed form of a variable that also exists unprefixed", () => {
		process.env.HOST = "10.0.0.1";
		process.env.CLANKERMUX_HOST = "127.0.0.1";
		expect(readEnv("HOST")).toBe("127.0.0.1");
	});
});

describe("isDebugEnabled", () => {
	it("is off when nothing is set", () => {
		expect(isDebugEnabled()).toBe(false);
		expect(isDebugEnabled("proxy")).toBe(false);
	});

	it("reads CLANKERMUX_DEBUG", () => {
		process.env.CLANKERMUX_DEBUG = "1";
		expect(isDebugEnabled()).toBe(true);
		process.env.CLANKERMUX_DEBUG = "true";
		expect(isDebugEnabled()).toBe(true);
	});

	it("reads the namespace form of CLANKERMUX_DEBUG", () => {
		process.env.CLANKERMUX_DEBUG = "model,proxy";
		expect(isDebugEnabled("model")).toBe(true);
		expect(isDebugEnabled("proxy")).toBe(true);
		expect(isDebugEnabled("database")).toBe(false);
		expect(isDebugEnabled()).toBe(false);
	});

	it("ignores the retired prefixes and a bare DEBUG", () => {
		process.env.BETTER_CCFLARE_DEBUG = "1";
		process.env.ccflare_DEBUG = "1";
		process.env.DEBUG = "1";
		expect(isDebugEnabled()).toBe(false);
		expect(isDebugEnabled("proxy")).toBe(false);
	});
});
