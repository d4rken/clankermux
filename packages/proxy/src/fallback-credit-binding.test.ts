import { describe, expect, it } from "bun:test";
import type { Account } from "@clankermux/types";
import { bindFallbackCredit } from "./fallback-credit-binding";
import { RequestBodyContext } from "./request-body-context";

const TOKEN = "fbc_opaque_credit";
const ISSUER = { accountId: "acc-issuer", identityExternalId: "org-issuer" };

function account(patch: Partial<Account> = {}): Account {
	return {
		id: "acc-issuer",
		name: "Claude-1",
		provider: "anthropic",
		api_key: null,
		identity_external_id: "org-issuer",
		...patch,
	} as Account;
}

function encode(body: Record<string, unknown>): ArrayBuffer {
	return new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer;
}

function context(token: unknown = TOKEN): RequestBodyContext {
	return new RequestBodyContext(
		encode({
			model: "claude-sonnet-5",
			messages: [{ role: "user", content: "hi" }],
			fallback_credit_token: token,
		}),
	);
}

/** The sent body's own field, or `ABSENT` when the key is gone. */
const ABSENT = Symbol("absent");
function sentToken(ctx: RequestBodyContext): unknown {
	const buffer = ctx.getBuffer();
	if (!buffer) throw new Error("no body");
	const body = JSON.parse(new TextDecoder().decode(buffer));
	return Object.hasOwn(body, "fallback_credit_token")
		? body.fallback_credit_token
		: ABSENT;
}

describe("bindFallbackCredit", () => {
	it("keeps the credit on the issuing account under the same identity", () => {
		const ctx = context();
		bindFallbackCredit(ctx, account(), ISSUER, "req-1");
		expect(ctx.isDirty).toBe(false);
		expect(sentToken(ctx)).toBe(TOKEN);
	});

	it("keeps the credit when neither side has an identity", () => {
		const ctx = context();
		bindFallbackCredit(
			ctx,
			account({ identity_external_id: null }),
			{ accountId: "acc-issuer", identityExternalId: null },
			"req-1",
		);
		expect(sentToken(ctx)).toBe(TOKEN);
	});

	it("strips the credit on any other account", () => {
		const ctx = context();
		bindFallbackCredit(
			ctx,
			account({ id: "acc-other", identity_external_id: "org-other" }),
			ISSUER,
			"req-1",
		);
		expect(sentToken(ctx)).toBe(ABSENT);
	});

	it("strips the credit when its issuer is unknown", () => {
		for (const issuer of [
			null,
			undefined,
			{ accountId: null, identityExternalId: "org-issuer" },
			{ accountId: "", identityExternalId: "org-issuer" },
		]) {
			const ctx = context();
			bindFallbackCredit(ctx, account(), issuer, "req-1");
			expect(sentToken(ctx)).toBe(ABSENT);
		}
	});

	it("strips the credit when the issuing account's identity changed", () => {
		for (const identity of ["org-replaced", null]) {
			const ctx = context();
			bindFallbackCredit(
				ctx,
				account({ identity_external_id: identity }),
				ISSUER,
				"req-1",
			);
			expect(sentToken(ctx)).toBe(ABSENT);
		}
	});

	it("removes a malformed field even on the issuing account", () => {
		for (const value of ["", 42, null, [TOKEN], { token: TOKEN }]) {
			const ctx = context(value);
			bindFallbackCredit(ctx, account(), ISSUER, "req-1");
			expect(sentToken(ctx)).toBe(ABSENT);
		}
	});

	it("strips per attempt without touching the parent or another attempt", () => {
		const base = context();
		const first = base.withPatchedModel("claude-sonnet-5");
		const second = base.withPatchedModel("claude-sonnet-5");
		if (!first || !second) throw new Error("patch failed");
		bindFallbackCredit(first, account({ id: "acc-other" }), ISSUER, "req-1");
		bindFallbackCredit(second, account(), ISSUER, "req-1");
		expect(sentToken(first)).toBe(ABSENT);
		expect(sentToken(second)).toBe(TOKEN);
		expect(sentToken(base)).toBe(TOKEN);

		const third = base.withPatchedModel("claude-sonnet-5");
		if (!third) throw new Error("patch failed");
		bindFallbackCredit(third, account({ id: "acc-other" }), ISSUER, "req-1");
		expect(sentToken(third)).toBe(ABSENT);
		expect(sentToken(second)).toBe(TOKEN);
		expect(sentToken(base)).toBe(TOKEN);
	});

	it("leaves a body without the field byte-identical", () => {
		const buffer = encode({ model: "claude-sonnet-5", messages: [] });
		const ctx = new RequestBodyContext(buffer);
		bindFallbackCredit(ctx, account({ id: "acc-other" }), null, "req-1");
		expect(ctx.isDirty).toBe(false);
		expect(ctx.getBuffer()).toBe(buffer);
	});
});
