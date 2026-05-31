import { afterEach, describe, expect, it } from "bun:test";
import type { DatabaseOperations } from "@clankermux/database";
import { getForcedAccount, setForcedAccount } from "@clankermux/proxy";
import {
	createAccountForceClearHandler,
	createAccountForceGetHandler,
	createAccountForceHandler,
} from "../accounts";

function makeDbOps(
	accounts: Array<{ id: string; name: string }>,
): DatabaseOperations {
	return {
		getAdapter: () => ({
			get: async (_sql: string, params?: unknown[]) => {
				const accountId = Array.isArray(params) ? params[0] : undefined;
				return accounts.find((a) => a.id === accountId) ?? null;
			},
		}),
	} as unknown as DatabaseOperations;
}

describe("force-account endpoints", () => {
	afterEach(() => {
		// Keep the shared @clankermux/proxy singleton deterministic across tests.
		setForcedAccount(null);
	});

	describe("createAccountForceHandler (set)", () => {
		it("returns 404 for an unknown account id and does not set force", async () => {
			const handler = createAccountForceHandler(makeDbOps([]));
			const response = await handler({} as Request, "missing-account");

			expect(response.status).toBe(404);
			expect(getForcedAccount()).toBeNull();
		});

		it("sets the force and returns success on a known account", async () => {
			const handler = createAccountForceHandler(
				makeDbOps([{ id: "acc-1", name: "Account One" }]),
			);
			const response = await handler({} as Request, "acc-1");
			const body = (await response.json()) as {
				success: boolean;
				message: string;
				accountId: string;
			};

			expect(response.status).toBe(200);
			expect(body.success).toBe(true);
			expect(body.accountId).toBe("acc-1");
			expect(body.message).toContain("Account One");
			expect(getForcedAccount()).toBe("acc-1");
		});

		it("replaces the previously forced account (one at a time)", async () => {
			const handler = createAccountForceHandler(
				makeDbOps([
					{ id: "acc-1", name: "Account One" },
					{ id: "acc-2", name: "Account Two" },
				]),
			);
			await handler({} as Request, "acc-1");
			expect(getForcedAccount()).toBe("acc-1");
			await handler({} as Request, "acc-2");
			expect(getForcedAccount()).toBe("acc-2");
		});
	});

	describe("createAccountForceClearHandler", () => {
		it("clears the force and returns success", async () => {
			setForcedAccount("acc-1");
			const handler = createAccountForceClearHandler();
			const response = await handler();
			const body = (await response.json()) as { success: boolean };

			expect(response.status).toBe(200);
			expect(body.success).toBe(true);
			expect(getForcedAccount()).toBeNull();
		});
	});

	describe("createAccountForceGetHandler", () => {
		it("returns null when no account is forced", async () => {
			const handler = createAccountForceGetHandler();
			const response = await handler();
			const body = (await response.json()) as { accountId: string | null };

			expect(response.status).toBe(200);
			expect(body.accountId).toBeNull();
		});

		it("returns the current forced account id", async () => {
			setForcedAccount("acc-9");
			const handler = createAccountForceGetHandler();
			const response = await handler();
			const body = (await response.json()) as { accountId: string | null };

			expect(response.status).toBe(200);
			expect(body.accountId).toBe("acc-9");
		});
	});
});
