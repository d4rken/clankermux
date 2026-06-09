import { describe, expect, it } from "bun:test";
import { type AccountRow, toAccount, toAccountResponse } from "./account";

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
