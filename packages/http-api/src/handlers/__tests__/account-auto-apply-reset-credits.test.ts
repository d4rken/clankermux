import { describe, expect, it, mock } from "bun:test";
import type {
	CodexResetCreditEventRow,
	DatabaseOperations,
} from "@clankermux/database";
import type { CodexResetCreditEventResponse } from "@clankermux/types";
import {
	createAccountAutoApplyResetCreditsHandler,
	createAccountResetCreditEventsHandler,
} from "../accounts";

interface AccountLookupRow {
	name: string;
	provider: string;
}

function makeDbOps(options: {
	account: AccountLookupRow | null;
	setEnabled?: ReturnType<typeof mock>;
	getEvents?: ReturnType<typeof mock>;
}): DatabaseOperations {
	return {
		getAdapter: () => ({
			get: async (_sql: string, params: unknown[]) =>
				params[0] === "account-1" ? options.account : null,
		}),
		setCodexAutoApplyResetCreditsEnabled:
			options.setEnabled ?? mock(async () => {}),
		getRecentCodexResetCreditEvents: options.getEvents ?? mock(async () => []),
	} as unknown as DatabaseOperations;
}

function toggleRequest(body: unknown): Request {
	return new Request(
		"http://localhost/api/accounts/account-1/rate-limit-reset-credits/auto-apply",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
	);
}

function eventsUrl(query = ""): URL {
	return new URL(
		`http://localhost/api/accounts/account-1/rate-limit-reset-credits/events${query}`,
	);
}

function makeEventRow(
	overrides: Partial<CodexResetCreditEventRow> = {},
): CodexResetCreditEventRow {
	return {
		id: "account-1:credit-1:1",
		account_id: "account-1",
		account_name: "Codex One",
		credit_id: "credit-1",
		trigger: "auto",
		attempt_seq: 1,
		idempotency_key: "idem-1",
		status: "reset",
		windows_reset: 2,
		error_message: null,
		credit_expires_at: 1_785_527_292, // unix SECONDS
		created_at: 1_784_000_000_000, // ms
		resolved_at: 1_784_000_060_000, // ms
		...overrides,
	};
}

describe("createAccountAutoApplyResetCreditsHandler", () => {
	const codexAccount: AccountLookupRow = {
		name: "Codex One",
		provider: "codex",
	};

	it("rejects a missing enabled field", async () => {
		const setEnabled = mock(async () => {});
		const handler = createAccountAutoApplyResetCreditsHandler(
			makeDbOps({ account: codexAccount, setEnabled }),
		);

		const response = await handler(toggleRequest({}), "account-1");

		expect(response.status).toBe(400);
		expect(setEnabled).not.toHaveBeenCalled();
	});

	it("rejects an enabled value outside 0/1", async () => {
		const setEnabled = mock(async () => {});
		const handler = createAccountAutoApplyResetCreditsHandler(
			makeDbOps({ account: codexAccount, setEnabled }),
		);

		const response = await handler(toggleRequest({ enabled: 2 }), "account-1");

		expect(response.status).toBe(400);
		expect(setEnabled).not.toHaveBeenCalled();
	});

	it("returns 404 for an unknown account", async () => {
		const handler = createAccountAutoApplyResetCreditsHandler(
			makeDbOps({ account: null }),
		);

		const response = await handler(toggleRequest({ enabled: 1 }), "account-1");

		expect(response.status).toBe(404);
	});

	it("returns 400 for non-codex accounts and mentions the Codex-only rule", async () => {
		const setEnabled = mock(async () => {});
		const handler = createAccountAutoApplyResetCreditsHandler(
			makeDbOps({
				account: { name: "Claude", provider: "anthropic" },
				setEnabled,
			}),
		);

		const response = await handler(toggleRequest({ enabled: 1 }), "account-1");
		const body = (await response.json()) as { error: string };

		expect(response.status).toBe(400);
		expect(body.error).toContain("Codex");
		expect(setEnabled).not.toHaveBeenCalled();
	});

	it("enables auto-apply and reports the new state", async () => {
		const setEnabled = mock(async () => {});
		const handler = createAccountAutoApplyResetCreditsHandler(
			makeDbOps({ account: codexAccount, setEnabled }),
		);

		const response = await handler(toggleRequest({ enabled: 1 }), "account-1");
		const body = (await response.json()) as Record<string, unknown>;

		expect(response.status).toBe(200);
		expect(setEnabled).toHaveBeenCalledWith("account-1", true);
		expect(body.success).toBe(true);
		expect(body.autoApplyResetCreditsEnabled).toBe(true);
		expect(String(body.message)).toContain("Codex One");
	});

	it("disables auto-apply and reports the new state", async () => {
		const setEnabled = mock(async () => {});
		const handler = createAccountAutoApplyResetCreditsHandler(
			makeDbOps({ account: codexAccount, setEnabled }),
		);

		const response = await handler(toggleRequest({ enabled: 0 }), "account-1");
		const body = (await response.json()) as Record<string, unknown>;

		expect(response.status).toBe(200);
		expect(setEnabled).toHaveBeenCalledWith("account-1", false);
		expect(body.success).toBe(true);
		expect(body.autoApplyResetCreditsEnabled).toBe(false);
	});
});

describe("createAccountResetCreditEventsHandler", () => {
	const codexAccount: AccountLookupRow = {
		name: "Codex One",
		provider: "codex",
	};

	it("returns 404 for an unknown account", async () => {
		const handler = createAccountResetCreditEventsHandler(
			makeDbOps({ account: null }),
		);

		const response = await handler(eventsUrl(), "account-1");

		expect(response.status).toBe(404);
	});

	it("returns 400 for non-codex accounts", async () => {
		const getEvents = mock(async () => []);
		const handler = createAccountResetCreditEventsHandler(
			makeDbOps({
				account: { name: "Claude", provider: "anthropic" },
				getEvents,
			}),
		);

		const response = await handler(eventsUrl(), "account-1");
		const body = (await response.json()) as { error: string };

		expect(response.status).toBe(400);
		expect(body.error).toContain("Codex");
		expect(getEvents).not.toHaveBeenCalled();
	});

	it("defaults the limit to 20", async () => {
		const getEvents = mock(async () => []);
		const handler = createAccountResetCreditEventsHandler(
			makeDbOps({ account: codexAccount, getEvents }),
		);

		const response = await handler(eventsUrl(), "account-1");

		expect(response.status).toBe(200);
		expect(getEvents).toHaveBeenCalledWith("account-1", 20);
	});

	it("clamps the limit into [1, 100] and falls back to the default when non-numeric", async () => {
		const getEvents = mock(async () => []);
		const handler = createAccountResetCreditEventsHandler(
			makeDbOps({ account: codexAccount, getEvents }),
		);

		await handler(eventsUrl("?limit=0"), "account-1");
		expect(getEvents).toHaveBeenLastCalledWith("account-1", 1);

		await handler(eventsUrl("?limit=500"), "account-1");
		expect(getEvents).toHaveBeenLastCalledWith("account-1", 100);

		await handler(eventsUrl("?limit=abc"), "account-1");
		expect(getEvents).toHaveBeenLastCalledWith("account-1", 20);

		await handler(eventsUrl("?limit=7"), "account-1");
		expect(getEvents).toHaveBeenLastCalledWith("account-1", 7);
	});

	it("maps ledger rows to the API response shape with ISO timestamps", async () => {
		const getEvents = mock(async () => [makeEventRow()]);
		const handler = createAccountResetCreditEventsHandler(
			makeDbOps({ account: codexAccount, getEvents }),
		);

		const response = await handler(eventsUrl(), "account-1");
		const body = (await response.json()) as {
			events: CodexResetCreditEventResponse[];
		};

		expect(response.status).toBe(200);
		expect(body.events).toEqual([
			{
				id: "account-1:credit-1:1",
				creditId: "credit-1",
				trigger: "auto",
				attemptSeq: 1,
				status: "reset",
				windowsReset: 2,
				errorMessage: null,
				// unix SECONDS * 1000 → ISO
				creditExpiresAt: "2026-07-31T19:48:12.000Z",
				// ms → ISO
				createdAt: "2026-07-14T03:33:20.000Z",
				resolvedAt: "2026-07-14T03:34:20.000Z",
			},
		]);
		// The internal idempotency key must not cross the API boundary.
		expect(JSON.stringify(body)).not.toContain("idem-1");
	});

	it("maps null credit_expires_at and resolved_at to null", async () => {
		const getEvents = mock(async () => [
			makeEventRow({
				credit_id: null,
				trigger: "manual",
				attempt_seq: null,
				status: "pending",
				windows_reset: null,
				error_message: "boom",
				credit_expires_at: null,
				resolved_at: null,
			}),
		]);
		const handler = createAccountResetCreditEventsHandler(
			makeDbOps({ account: codexAccount, getEvents }),
		);

		const response = await handler(eventsUrl(), "account-1");
		const body = (await response.json()) as {
			events: CodexResetCreditEventResponse[];
		};

		expect(body.events[0]).toMatchObject({
			creditId: null,
			trigger: "manual",
			attemptSeq: null,
			status: "pending",
			windowsReset: null,
			errorMessage: "boom",
			creditExpiresAt: null,
			resolvedAt: null,
		});
	});
});
