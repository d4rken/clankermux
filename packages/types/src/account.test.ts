import { describe, expect, it } from "bun:test";
import {
	type AccountResponse,
	type AccountRow,
	computeDuplicateAccountFlags,
	toAccount,
	toAccountResponse,
} from "./account";

/** A minimal AccountRow with only the required fields populated. */
function makeRow(overrides: Partial<AccountRow> = {}): AccountRow {
	return {
		id: "acc-1",
		name: "acc-1",
		provider: "anthropic",
		api_key: null,
		refresh_token: "",
		access_token: null,
		expires_at: null,
		created_at: Date.now(),
		last_used: null,
		request_count: 0,
		total_requests: 0,
		...overrides,
	};
}

describe("toAccount — notes mapping", () => {
	it("maps a present notes value through", () => {
		const account = toAccount(makeRow({ notes: "hello world" }));
		expect(account.notes).toBe("hello world");
	});

	it("maps a missing notes field to null", () => {
		const account = toAccount(makeRow());
		expect(account.notes).toBeNull();
	});

	it("maps an empty-string notes value to null", () => {
		const account = toAccount(makeRow({ notes: "" }));
		expect(account.notes).toBeNull();
	});

	it("maps an explicit null notes value to null", () => {
		const account = toAccount(makeRow({ notes: null }));
		expect(account.notes).toBeNull();
	});
});

describe("toAccountResponse — notes field", () => {
	it("includes notes when set on the account", () => {
		const response = toAccountResponse(
			toAccount(makeRow({ notes: "response note" })),
		);
		expect(response.notes).toBe("response note");
	});

	it("includes notes as null when not set", () => {
		const response = toAccountResponse(toAccount(makeRow()));
		expect(response.notes).toBeNull();
	});
});

/** Build a full AccountResponse via the real mappers, then override identity. */
function makeResponse(overrides: {
	id: string;
	provider?: string;
	identityExternalId?: string | null;
	identityEmail?: string | null;
}): AccountResponse {
	const resp = toAccountResponse(
		toAccount(makeRow({ id: overrides.id, provider: overrides.provider })),
	);
	resp.provider = overrides.provider ?? "anthropic";
	resp.identityExternalId = overrides.identityExternalId ?? null;
	resp.identityEmail = overrides.identityEmail ?? null;
	return resp;
}

describe("computeDuplicateAccountFlags", () => {
	it("flags two accounts sharing externalAccountId + provider", () => {
		const flags = computeDuplicateAccountFlags([
			makeResponse({ id: "a", identityExternalId: "ext-1" }),
			makeResponse({ id: "b", identityExternalId: "ext-1" }),
		]);
		expect(flags.get("a")).toEqual(["b"]);
		expect(flags.get("b")).toEqual(["a"]);
	});

	it("flags two accounts sharing email case-insensitively (same provider)", () => {
		const flags = computeDuplicateAccountFlags([
			makeResponse({ id: "a", identityEmail: "User@Example.com" }),
			makeResponse({ id: "b", identityEmail: "user@example.COM" }),
		]);
		expect(flags.get("a")).toEqual(["b"]);
		expect(flags.get("b")).toEqual(["a"]);
	});

	it("does NOT flag same email under different providers", () => {
		const flags = computeDuplicateAccountFlags([
			makeResponse({
				id: "a",
				provider: "anthropic",
				identityEmail: "user@example.com",
			}),
			makeResponse({
				id: "b",
				provider: "codex",
				identityEmail: "user@example.com",
			}),
		]);
		expect(flags.size).toBe(0);
	});

	it("never flags accounts with null external id AND null email", () => {
		const flags = computeDuplicateAccountFlags([
			makeResponse({ id: "a" }),
			makeResponse({ id: "b" }),
		]);
		expect(flags.size).toBe(0);
	});

	it("does not flag a single account", () => {
		const flags = computeDuplicateAccountFlags([
			makeResponse({ id: "a", identityExternalId: "ext-1" }),
		]);
		expect(flags.size).toBe(0);
	});

	it("unions external-id and email matches across a cluster", () => {
		// a<->b share external id; b<->c share email; all three cluster together.
		const flags = computeDuplicateAccountFlags([
			makeResponse({ id: "a", identityExternalId: "ext-1" }),
			makeResponse({
				id: "b",
				identityExternalId: "ext-1",
				identityEmail: "shared@example.com",
			}),
			makeResponse({ id: "c", identityEmail: "shared@example.com" }),
		]);
		expect(flags.get("a")).toEqual(["b"]);
		expect(flags.get("b")).toEqual(["a", "c"]);
		expect(flags.get("c")).toEqual(["b"]);
	});
});
