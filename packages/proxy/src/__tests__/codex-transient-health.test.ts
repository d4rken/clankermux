import { afterEach, describe, expect, it } from "bun:test";
import {
	clearCodexTransientFailure,
	getCodexTransientFailureUntil,
	isCodexTransientError,
	recordCodexTransientFailure,
	resetCodexTransientHealthForTests,
} from "../codex-transient-health";

afterEach(resetCodexTransientHealthForTests);

describe("Codex transient account health", () => {
	it("expires after one minute and does not affect another account", () => {
		recordCodexTransientFailure("a", 1000);
		expect(getCodexTransientFailureUntil("a", 1001)).toBe(61000);
		expect(getCodexTransientFailureUntil("b", 1001)).toBeNull();
		expect(getCodexTransientFailureUntil("a", 61000)).toBeNull();
	});

	it("only a success started after the latest failure clears it", () => {
		recordCodexTransientFailure("a", 1000);
		recordCodexTransientFailure("a", 2000);
		clearCodexTransientFailure("a", 1500);
		expect(getCodexTransientFailureUntil("a", 2001)).toBe(62000);
		clearCodexTransientFailure("a", 2000);
		expect(getCodexTransientFailureUntil("a", 2001)).toBe(62000);
		clearCodexTransientFailure("a", 2001);
		expect(getCodexTransientFailureUntil("a", 2002)).toBeNull();
	});

	it("recognizes only explicit transient server errors", () => {
		for (const reason of [
			"server_error",
			"service_unavailable_error",
			"server_is_overloaded",
		]) {
			expect(isCodexTransientError(reason)).toBe(true);
		}
		for (const reason of [
			null,
			"api_error",
			"rate_limit_exceeded",
			"slow_down",
			"insufficient_quota",
			"context_length_exceeded",
			"invalid_request_error",
			"permission_error",
			"client_cancel",
			"stream_timeout",
			"native_responses_no_terminal",
		]) {
			expect(isCodexTransientError(reason)).toBe(false);
		}
	});
});
