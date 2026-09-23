/** The smoke script's pure helpers. */
import { describe, expect, it } from "bun:test";
import {
	differentSetupCode,
	type ExitStatus,
	extractSetupCodes,
	isCleanExit,
} from "./smoke-server-binary.ts";

const clean: ExitStatus = { code: 0, signal: null };
const forceKilled: ExitStatus = { code: null, signal: "SIGKILL" };
const signalled: ExitStatus = { code: null, signal: "SIGTERM" };
const failed: ExitStatus = { code: 1, signal: null };

/**
 * `stopServer` sends SIGTERM, waits out a grace period, then escalates to
 * SIGKILL. A process that had to be force-killed reports
 * `{code: null, signal: "SIGKILL"}` — no exit code at all — so a verdict that
 * only inspects `code` passes the one case the shutdown assertion exists to
 * catch: a binary that ignored SIGTERM and stalled until the timeout.
 */
describe("isCleanExit", () => {
	it("accepts a voluntary exit 0", () => {
		expect(isCleanExit(clean)).toBe(true);
	});

	it("rejects a force-killed exit: SIGKILL after the grace period is not a clean shutdown", () => {
		expect(isCleanExit(forceKilled)).toBe(false);
	});

	it("rejects an exit terminated by SIGTERM rather than by returning", () => {
		expect(isCleanExit(signalled)).toBe(false);
	});

	it("rejects a non-zero exit code", () => {
		expect(isCleanExit(failed)).toBe(false);
	});
});

/** The block `printSetupCodeAnnouncement` prints, for a given code. */
function announcement(code: string): string {
	const rule = "-".repeat(64);
	return [
		"",
		rule,
		"No management password is set. One-time setup code:",
		"",
		`    ${code}`,
		"",
		"Open the dashboard at http://127.0.0.1:4123/dashboard and enter this code to choose a password.",
		"Each restart prints a new code.",
		"",
		"Or set the password from a shell on this machine:",
		"    clankermux-server auth password --set",
		"    (from a source checkout: bun run auth:password --set)",
		rule,
		"",
	].join("\n");
}

const startupNoise = [
	"[INFO] [Server] Starting ClankerMux",
	"request 12345678-ABCD-EF01-2345-6789ABCDEF01 accepted",
	"🌍 Host: 127.0.0.1",
].join("\n");

describe("extractSetupCodes", () => {
	it("finds the code in the announcement block", () => {
		const output = `${startupNoise}\n${announcement("7K2M-QX9P-4RTV")}\n${startupNoise}\n`;
		expect(extractSetupCodes(output)).toEqual(["7K2M-QX9P-4RTV"]);
	});

	it("returns nothing for output without an announcement", () => {
		expect(extractSetupCodes(`${startupNoise}\n`)).toEqual([]);
	});

	it("ignores a code-shaped fragment outside an announcement", () => {
		expect(extractSetupCodes("    ABCD-EF01-2345\n")).toEqual([]);
	});

	it("reports a code announced twice once", () => {
		const output = `${announcement("7K2M-QX9P-4RTV")}${announcement("7K2M-QX9P-4RTV")}`;
		expect(extractSetupCodes(output)).toEqual(["7K2M-QX9P-4RTV"]);
	});

	it("reports both codes when two different ones were announced", () => {
		const output = `${announcement("7K2M-QX9P-4RTV")}${startupNoise}\n${announcement("0000-ZZZZ-1234")}`;
		expect(extractSetupCodes(output)).toEqual([
			"7K2M-QX9P-4RTV",
			"0000-ZZZZ-1234",
		]);
	});
});

describe("differentSetupCode", () => {
	it("changes only the first character, within the alphabet", () => {
		expect(differentSetupCode("7K2M-QX9P-4RTV")).toBe("8K2M-QX9P-4RTV");
	});

	it("wraps the last alphabet character around to the first", () => {
		expect(differentSetupCode("ZK2M-QX9P-4RTV")).toBe("0K2M-QX9P-4RTV");
	});
});
