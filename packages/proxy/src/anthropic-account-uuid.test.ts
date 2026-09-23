import { describe, expect, it } from "bun:test";
import type { Account } from "@clankermux/types";
import { bindAnthropicAccountUuid } from "./anthropic-account-uuid";
import { RequestBodyContext } from "./request-body-context";

const ROUTED = "0b7c1a52-3f0e-4d7a-9c55-2d8e6f1a9b40";

function account(patch: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "Claude-1",
		provider: "anthropic",
		api_key: null,
		identity_external_id: ROUTED,
		...patch,
	} as Account;
}

function context(userId: unknown): RequestBodyContext {
	const body = {
		model: "claude-sonnet-5",
		metadata: userId === undefined ? undefined : { user_id: userId },
		messages: [],
	};
	return new RequestBodyContext(
		new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer,
	);
}

function userId(ctx: RequestBodyContext): unknown {
	const buffer = ctx.getBuffer();
	if (!buffer) return undefined;
	const body = JSON.parse(new TextDecoder().decode(buffer));
	return body.metadata?.user_id;
}

const TOKEN_CLIENT =
	'{"device_id":"e01ccdf3","account_uuid":"","session_id":"8644f453"}';

describe("bindAnthropicAccountUuid", () => {
	it("names the routed account when a token-authenticated client sent none", () => {
		const ctx = context(TOKEN_CLIENT);
		bindAnthropicAccountUuid(ctx, account());
		expect(userId(ctx)).toBe(
			`{"device_id":"e01ccdf3","account_uuid":"${ROUTED}","session_id":"8644f453"}`,
		);
	});

	it("gives each failover attempt its own account without leaking into the parent", () => {
		const base = context(TOKEN_CLIENT);
		const first = base.withPatchedModel("claude-sonnet-5");
		const second = base.withPatchedModel("claude-sonnet-5");
		if (!first || !second) throw new Error("patch failed");
		bindAnthropicAccountUuid(first, account());
		const other = "7d1f0e22-8a4b-4c3d-b1e2-f3a4b5c6d7e8";
		bindAnthropicAccountUuid(second, account({ identity_external_id: other }));
		expect(userId(first)).toContain(ROUTED);
		expect(userId(second)).toContain(other);
		expect(userId(base)).toBe(TOKEN_CLIENT);
	});

	it("binds for every official Anthropic OAuth provider name", () => {
		const ctx = context(TOKEN_CLIENT);
		bindAnthropicAccountUuid(ctx, account({ provider: "claude-oauth" }));
		expect(userId(ctx)).toContain(ROUTED);
	});

	it("leaves a logged-in client's own uuid alone", () => {
		const own =
			'{"device_id":"e01ccdf3","account_uuid":"11111111-2222-4333-8444-555555555555","session_id":"8644f453"}';
		const ctx = context(own);
		bindAnthropicAccountUuid(ctx, account());
		expect(ctx.isDirty).toBe(false);
		expect(userId(ctx)).toBe(own);
	});

	it("does nothing for API-key, non-Anthropic or unidentified accounts", () => {
		for (const acct of [
			account({ api_key: "sk-ant-api03-x" }),
			account({ provider: "codex" }),
			account({ identity_external_id: null }),
			account({ identity_external_id: "not a uuid" }),
			account({ custom_endpoint: "https://relay.example" }),
		]) {
			const ctx = context(TOKEN_CLIENT);
			bindAnthropicAccountUuid(ctx, acct);
			expect(ctx.isDirty).toBe(false);
		}
	});

	it("does nothing when user_id is absent, legacy or not JSON", () => {
		for (const value of [
			undefined,
			"user_abc_account__session_8644f453",
			'{"device_id":"e01ccdf3","session_id":"8644f453"}',
			"{not json",
			42,
		]) {
			const ctx = context(value);
			bindAnthropicAccountUuid(ctx, account());
			expect(ctx.isDirty).toBe(false);
		}
	});
});
