import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { api } from "../api";
import { REDACTED, redactForLog } from "./log-redaction";

describe("redactForLog", () => {
	it("blanks credentials at any depth and keeps the rest", () => {
		expect(
			redactForLog({
				name: "zai",
				apiKey: "sk-1",
				priority: 3,
				auth: { code: "c", region: "eu" },
				list: [{ refresh_token: "r" }, { name: "n" }],
			}),
		).toEqual({
			name: "zai",
			apiKey: REDACTED,
			priority: 3,
			auth: { code: REDACTED, region: "eu" },
			list: [{ refresh_token: REDACTED }, { name: "n" }],
		});
	});

	it("matches every spelling of a secret field", () => {
		const out = redactForLog({
			apiKey: 1,
			api_key: 2,
			"API-KEY": 3,
			accessToken: 4,
			id_token: 5,
			clientSecret: 6,
			password: 7,
			Authorization: 8,
			cookie: 9,
			token: 10,
		}) as Record<string, unknown>;
		for (const value of Object.values(out)) expect(value).toBe(REDACTED);
	});

	it("leaves fields that only contain a secret word", () => {
		const input = {
			apiKeys: ["k1"],
			hasRefreshToken: true,
			userCode: "ABCD-1234",
			minTokens: 1024,
			codex: "x",
		};
		expect(redactForLog(input)).toEqual(input);
	});

	it("does not mutate its input", () => {
		const input = { apiKey: "sk-1" };
		redactForLog(input);
		expect(input.apiKey).toBe("sk-1");
	});

	it("passes non-plain values through unchanged", () => {
		const error = new Error("boom");
		expect(redactForLog(error)).toBe(error);
		expect(redactForLog("text")).toBe("text");
		expect(redactForLog(null)).toBeNull();
		expect(redactForLog(undefined)).toBeUndefined();
	});

	it("survives a cycle", () => {
		const input: Record<string, unknown> = { apiKey: "sk-1" };
		input.self = input;
		const out = redactForLog(input) as Record<string, unknown>;
		expect(out.apiKey).toBe(REDACTED);
		expect(out.self).toBe(out);
	});
});

describe("api request logging", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it("never prints an account's API key to the console", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ message: "ok", account: {} }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch;
		const spies = (["log", "debug", "warn", "error"] as const).map((level) =>
			spyOn(console, level).mockImplementation(() => {}),
		);
		try {
			await api.addZaiAccount({
				name: "zai",
				apiKey: "sk-live-secret",
				priority: 0,
			});
			const printed = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
			expect(printed).toContain("/api/accounts/zai");
			expect(printed).not.toContain("sk-live-secret");
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	});
});
