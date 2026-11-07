import { describe, expect, it } from "bun:test";
import { clientFacingProxyRefusal } from "./proxy-refusal";

const coded = (message: string, code: string) =>
	Object.assign(new Error(message), { code, statusCode: 400 });

describe("clientFacingProxyRefusal", () => {
	it.each([
		[
			"MODEL_NOT_SERVED",
			"Every account attempted (2) rejected its resolved model",
		],
		["REQUEST_UNTRANSLATABLE", "unsupported image source url scheme: file"],
	])("passes the message of a %s refusal through", (code, message) => {
		expect(clientFacingProxyRefusal(coded(message, code))).toBe(message);
	});

	it.each([
		["another coded error", coded("db path /var/x", "DATABASE_ERROR")],
		["an uncoded error", new Error("internal detail")],
		[
			"a plain object with the code",
			{ code: "MODEL_NOT_SERVED", message: "x" },
		],
		["a string", "MODEL_NOT_SERVED"],
		["null", null],
	])("returns null for %s", (_label, value) => {
		expect(clientFacingProxyRefusal(value)).toBeNull();
	});
});
