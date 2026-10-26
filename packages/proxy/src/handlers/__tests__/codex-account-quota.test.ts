import { describe, expect, it } from "bun:test";
import { resolveLiveCodexAccountQuota429 } from "../codex-account-quota";

const NOW = Date.UTC(2026, 9, 21, 7, 35, 41);
const HOUR = 3_600_000;
const WEEKLY_RESET = NOW + 515_526_000;

const account = { provider: "codex", custom_endpoint: null };

/** Header shape of a weekly-exhausted ChatGPT-backend 429 (2026-10-21). */
function codex429(overrides: Record<string, string | null> = {}): Response {
	const headers: Record<string, string> = {
		"x-codex-active-limit": "premium",
		"x-codex-plan-type": "prolite",
		"x-codex-primary-used-percent": "100",
		"x-codex-primary-window-minutes": "10080",
		"x-codex-primary-reset-at": String(WEEKLY_RESET / 1000),
		"x-codex-primary-reset-after-seconds": "515526",
		"x-codex-secondary-used-percent": "0",
		"x-codex-secondary-window-minutes": "0",
		"x-codex-secondary-reset-at": "",
		"x-codex-secondary-reset-after-seconds": "0",
	};
	for (const [key, value] of Object.entries(overrides)) {
		if (value === null) delete headers[key];
		else headers[key] = value;
	}
	return new Response("{}", { status: 429, headers });
}

describe("resolveLiveCodexAccountQuota429", () => {
	it("binds the weekly window to its own reset", () => {
		expect(resolveLiveCodexAccountQuota429(account, codex429(), NOW)).toEqual({
			binding: "weekly",
			reason: "weekly_exhausted_429",
			resetTime: WEEKLY_RESET,
		});
	});

	it("binds a five-hour window as a session limit", () => {
		const sessionReset = NOW + 2 * HOUR;
		expect(
			resolveLiveCodexAccountQuota429(
				account,
				codex429({
					"x-codex-primary-used-percent": "40",
					"x-codex-secondary-used-percent": "100",
					"x-codex-secondary-window-minutes": "300",
					"x-codex-secondary-reset-at": String(sessionReset / 1000),
				}),
				NOW,
			),
		).toEqual({
			binding: "session",
			reason: "session_exhausted_429",
			resetTime: sessionReset,
		});
	});

	it("drops a spent five-hour reset that lies past its own horizon", () => {
		const sessionReset = WEEKLY_RESET + HOUR;
		const result = resolveLiveCodexAccountQuota429(
			account,
			codex429({
				"x-codex-secondary-used-percent": "100",
				"x-codex-secondary-window-minutes": "300",
				"x-codex-secondary-reset-at": String(sessionReset / 1000),
			}),
			NOW,
		);
		expect(result).toEqual({
			binding: "weekly",
			reason: "weekly_exhausted_429",
			resetTime: WEEKLY_RESET,
		});
	});

	it("keeps the cause without a reset when the spent window names none usable", () => {
		expect(
			resolveLiveCodexAccountQuota429(
				account,
				codex429({
					"x-codex-primary-reset-at": String((NOW - HOUR) / 1000),
					"x-codex-primary-reset-after-seconds": null,
				}),
				NOW,
			),
		).toEqual({ binding: "weekly", reason: "weekly_exhausted_429" });
	});

	it("rejects a weekly reset beyond the window's own horizon", () => {
		expect(
			resolveLiveCodexAccountQuota429(
				account,
				codex429({
					"x-codex-primary-reset-at": String((NOW + 8 * 24 * HOUR) / 1000),
					"x-codex-primary-reset-after-seconds": null,
				}),
				NOW,
			),
		).toEqual({ binding: "weekly", reason: "weekly_exhausted_429" });
	});

	it("is null when no window reports itself spent", () => {
		expect(
			resolveLiveCodexAccountQuota429(
				account,
				codex429({ "x-codex-primary-used-percent": "87" }),
				NOW,
			),
		).toBeNull();
	});

	it("never reads a missing percentage as spent", () => {
		expect(
			resolveLiveCodexAccountQuota429(
				account,
				codex429({ "x-codex-primary-used-percent": null }),
				NOW,
			),
		).toBeNull();
	});

	it("ignores a spent per-model family limit", () => {
		expect(
			resolveLiveCodexAccountQuota429(
				account,
				codex429({
					"x-codex-primary-used-percent": "12",
					"x-codex-bengalfox-limit-name": "GPT-5.3-Codex-Spark",
					"x-codex-bengalfox-primary-used-percent": "100",
					"x-codex-bengalfox-primary-window-minutes": "10080",
					"x-codex-bengalfox-primary-reset-at": String(WEEKLY_RESET / 1000),
				}),
				NOW,
			),
		).toBeNull();
	});

	it.each([
		["a non-429 status", account, 200],
		["another provider", { provider: "anthropic", custom_endpoint: null }, 429],
		[
			"a custom endpoint",
			{ provider: "codex", custom_endpoint: "https://codex.example.test/v1" },
			429,
		],
	])("is null for %s", (_label, who, status) => {
		const response = codex429();
		expect(
			resolveLiveCodexAccountQuota429(
				who,
				new Response("{}", { status, headers: response.headers }),
				NOW,
			),
		).toBeNull();
	});
});
