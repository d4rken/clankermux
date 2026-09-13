/**
 * The smoke script's shutdown verdict.
 *
 * `stopServer` sends SIGTERM, waits out a grace period, then escalates to
 * SIGKILL. A process that had to be force-killed reports
 * `{code: null, signal: "SIGKILL"}` — no exit code at all — so a verdict that
 * only inspects `code` passes the one case the shutdown assertion exists to
 * catch: a binary that ignored SIGTERM and stalled until the timeout.
 */
import { describe, expect, it } from "bun:test";
import { type ExitStatus, isCleanExit } from "./smoke-server-binary.ts";

const clean: ExitStatus = { code: 0, signal: null };
const forceKilled: ExitStatus = { code: null, signal: "SIGKILL" };
const signalled: ExitStatus = { code: null, signal: "SIGTERM" };
const failed: ExitStatus = { code: 1, signal: null };

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
