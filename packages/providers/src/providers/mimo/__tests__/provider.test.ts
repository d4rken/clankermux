import { beforeEach, describe, expect, it } from "bun:test";
import { makeAccount } from "@clankermux/test-support";
import { getProvider } from "../../../index";
import { MimoProvider } from "../provider";

const SGP = "https://token-plan-sgp.xiaomimimo.com/anthropic";
const CN = "https://token-plan-cn.xiaomimimo.com/anthropic";
const AMS = "https://token-plan-ams.xiaomimimo.com/anthropic";

function accountAt(endpoint: string) {
	return makeAccount({ provider: "mimo", custom_endpoint: endpoint });
}

describe("MimoProvider", () => {
	let provider: MimoProvider;

	beforeEach(() => {
		provider = new MimoProvider();
	});

	describe("name", () => {
		it("should have the correct provider name", () => {
			expect(provider.name).toBe("mimo");
		});
	});

	describe("getEndpoint", () => {
		it("should default to the Singapore Token Plan base", () => {
			expect(provider.getEndpoint()).toBe(SGP);
		});
	});

	describe("buildUrl", () => {
		it("should use the Singapore base when the account stores no region", () => {
			expect(provider.buildUrl("/v1/messages", "")).toBe(`${SGP}/v1/messages`);
			expect(provider.buildUrl("/v1/messages", "", makeAccount())).toBe(
				`${SGP}/v1/messages`,
			);
		});

		it("should dial the region the account stores", () => {
			for (const base of [CN, SGP, AMS]) {
				expect(provider.buildUrl("/v1/messages", "", accountAt(base))).toBe(
					`${base}/v1/messages`,
				);
			}
		});

		it("should not double the separator on a base with a trailing slash", () => {
			expect(provider.buildUrl("/v1/messages", "", accountAt(`${CN}/`))).toBe(
				`${CN}/v1/messages`,
			);
		});

		it("should append /v1 to a base that stops at /anthropic", () => {
			expect(
				provider.buildUrl(
					"/v1/messages",
					"",
					accountAt("https://token-plan-cn.xiaomimimo.com/anthropic"),
				),
			).toBe("https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages");
		});

		it("should not repeat a /v1 the base already carries", () => {
			expect(
				provider.buildUrl(
					"/v1/messages",
					"",
					accountAt("https://token-plan-cn.xiaomimimo.com/anthropic/v1"),
				),
			).toBe("https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages");
		});

		it("should match whole segments, so a /v1x base keeps the request's /v1", () => {
			expect(
				provider.buildUrl(
					"/v1/messages",
					"",
					accountAt("https://token-plan-cn.xiaomimimo.com/v1x"),
				),
			).toBe("https://token-plan-cn.xiaomimimo.com/v1x/v1/messages");
		});

		it("should keep the request's own query string", () => {
			expect(
				provider.buildUrl("/v1/messages", "?beta=true", accountAt(AMS)),
			).toBe(`${AMS}/v1/messages?beta=true`);
		});

		it("should build on the path when the base carries a query of its own", () => {
			expect(
				provider.buildUrl("/v1/messages", "?beta=true", accountAt(`${CN}?x=1`)),
			).toBe(`${CN}/v1/messages?x=1&beta=true`);
			expect(
				provider.buildUrl("/v1/messages", "", accountAt(`${CN}?x=1`)),
			).toBe(`${CN}/v1/messages?x=1`);
		});
	});

	describe("prepareHeaders", () => {
		it("should send the Token Plan key as a bare x-api-key", () => {
			const prepared = provider.prepareHeaders(
				new Headers({ authorization: "Bearer client-token" }),
				undefined,
				"tp-test-key",
			);

			expect(prepared.get("x-api-key")).toBe("tp-test-key");
			expect(prepared.get("authorization")).toBeNull();
		});
	});

	describe("registry", () => {
		it("should be registered under its provider name", () => {
			expect(getProvider("mimo")).toBeInstanceOf(MimoProvider);
		});
	});
});
