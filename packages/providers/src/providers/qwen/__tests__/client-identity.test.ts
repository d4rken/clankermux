import { describe, expect, it } from "bun:test";
import {
	QWEN_CODE_ARCH,
	QWEN_CODE_IDENTITY_PROMPT,
	QWEN_CODE_PLATFORM,
	QWEN_CODE_PRODUCT_NAME,
	QWEN_CODE_SDK_VERSION,
	QWEN_CODE_USER_AGENT,
	QWEN_STAINLESS_HEADERS,
	qwenDeviceAuthorizationHeaders,
	qwenInferenceHeaders,
	qwenTokenHeaders,
} from "../client-identity";

describe("Qwen Code client identity", () => {
	it("builds the User-Agent from the SDK version and pinned platform", () => {
		expect(QWEN_CODE_USER_AGENT).toBe(
			`QwenCode/sdk-typescript-v${QWEN_CODE_SDK_VERSION} (${QWEN_CODE_PLATFORM}; ${QWEN_CODE_ARCH})`,
		);
	});

	it("names the same architecture in the User-Agent and the Stainless block", () => {
		expect(QWEN_STAINLESS_HEADERS["X-Stainless-Arch"]).toBe(QWEN_CODE_ARCH);
	});

	it("freezes the Stainless block", () => {
		expect(Object.isFrozen(QWEN_STAINLESS_HEADERS)).toBe(true);
	});

	it("introduces itself by the product name", () => {
		expect(QWEN_CODE_IDENTITY_PROMPT).toStartWith(
			`You are ${QWEN_CODE_PRODUCT_NAME},`,
		);
	});

	describe("qwenInferenceHeaders", () => {
		// Header iteration is sorted, so the goldens cannot see the order the
		// headers are set in. This pins it.
		it("sets headers in a fixed order, authorization first", () => {
			expect(Object.keys(qwenInferenceHeaders("tok"))).toEqual([
				"Authorization",
				"Content-Type",
				"User-Agent",
				"X-DashScope-CacheControl",
				"X-DashScope-UserAgent",
				"X-DashScope-AuthType",
				"X-Stainless-Lang",
				"X-Stainless-Runtime",
				"X-Stainless-Runtime-Version",
				"X-Stainless-Os",
				"X-Stainless-Arch",
				"X-Stainless-Package-Version",
				"X-Stainless-Retry-Count",
				"Accept-Language",
				"Accept-Encoding",
				"Sec-Fetch-Mode",
				"Connection",
			]);
		});

		it("carries the token as a bearer credential", () => {
			expect(qwenInferenceHeaders("tok").Authorization).toBe("Bearer tok");
		});

		it("omits authorization for a missing or empty token", () => {
			expect(qwenInferenceHeaders()).not.toHaveProperty("Authorization");
			expect(qwenInferenceHeaders("")).not.toHaveProperty("Authorization");
		});

		it("sends the same agent string to DashScope as the User-Agent", () => {
			const headers = qwenInferenceHeaders("tok");
			expect(headers["X-DashScope-UserAgent"]).toBe(headers["User-Agent"]);
		});

		it("returns a fresh object each call", () => {
			const first = qwenInferenceHeaders("tok");
			first["User-Agent"] = "changed";
			expect(qwenInferenceHeaders("tok")["User-Agent"]).toBe(
				QWEN_CODE_USER_AGENT,
			);
		});
	});

	describe("OAuth headers", () => {
		it("send a form body to both OAuth endpoints", () => {
			const form = { "Content-Type": "application/x-www-form-urlencoded" };
			expect(qwenDeviceAuthorizationHeaders()).toEqual(form);
			expect(qwenTokenHeaders()).toEqual(form);
		});

		it("return a fresh object each call", () => {
			expect(qwenTokenHeaders()).not.toBe(qwenTokenHeaders());
			expect(qwenDeviceAuthorizationHeaders()).not.toBe(
				qwenDeviceAuthorizationHeaders(),
			);
		});
	});
});
