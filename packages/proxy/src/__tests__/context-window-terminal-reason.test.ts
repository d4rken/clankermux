/**
 * The context_window_exceeded 400 explains why no LARGER-context backend picked
 * the request up. That explanation was a hardcoded "rate-limited or paused",
 * which is false for Codex CLI traffic: the /v1/responses adapter sets an
 * unconditional floor (`excludeOfficialAnthropic`) that drops every official
 * Anthropic account from selection regardless of their health. In the
 * 2026-08-20 incident the message blamed availability while all four Anthropic
 * accounts sat at 14-75% headroom.
 */
import { describe, expect, it } from "bun:test";
import type { Account } from "@clankermux/types";
import { createContextWindowExceededResponse } from "../handlers/proxy-operations";

function codexAccount(): Account {
	return {
		id: "acct-codex",
		name: "Codex-Main",
		provider: "codex",
		api_key: null,
		refresh_token: "r",
		access_token: "a",
		expires_at: Date.now() + 3_600_000,
		created_at: Date.now(),
		last_used: null,
		request_count: 0,
		total_requests: 0,
		paused: false,
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		custom_endpoint: null,
		model_mappings: null,
	} as unknown as Account;
}

async function messageOf(res: Response): Promise<string> {
	const body = (await res.json()) as { error: { message: string } };
	return body.error.message;
}

describe("context_window_exceeded terminal reason", () => {
	const excluded = [{ account: codexAccount(), model: "claude-opus-4-8" }];

	it("names the Codex CLI floor when official Anthropic accounts are barred", async () => {
		const res = createContextWindowExceededResponse(
			430_847,
			excluded,
			"gpt-5.6-sol",
			true,
		);

		const message = await messageOf(res);
		expect(message).toContain("Codex CLI");
		// The old wording asserted a condition nobody had checked.
		expect(message).not.toContain("rate-limited or paused");
		// And do not swap one false claim for another: Anthropic's 200k window is
		// SMALLER than gpt-5.6-sol's 353k, so those accounts are not the
		// larger-context option here. The flag proves exclusion and nothing more —
		// not that such an account exists, nor that it would have had room.
		expect(message).not.toContain("larger context");
	});

	it("keeps the availability wording for ordinary traffic", async () => {
		const res = createContextWindowExceededResponse(
			430_847,
			excluded,
			"claude-opus-4-8",
			false,
		);

		expect(await messageOf(res)).toContain("rate-limited or paused");
	});

	it("defaults to the availability wording when the flag is absent", async () => {
		const res = createContextWindowExceededResponse(
			430_847,
			excluded,
			"claude-opus-4-8",
		);

		expect(await messageOf(res)).toContain("rate-limited or paused");
	});

	it("still reports the estimate and the excluded backend either way", async () => {
		const res = createContextWindowExceededResponse(
			430_847,
			excluded,
			"gpt-5.6-sol",
			true,
		);

		const body = (await res.json()) as {
			error: {
				type: string;
				estimated_tokens: number;
				excluded_backends: { name: string }[];
			};
		};
		expect(res.status).toBe(400);
		expect(body.error.type).toBe("context_window_exceeded");
		expect(body.error.estimated_tokens).toBe(430_847);
		expect(body.error.excluded_backends[0].name).toBe("Codex-Main");
	});
});
