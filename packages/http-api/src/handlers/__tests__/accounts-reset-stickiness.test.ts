import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { DatabaseOperations } from "@clankermux/database";
import { registerAffinityClearer } from "@clankermux/proxy";
import { createAccountResetStickinessHandler } from "../accounts";

// A unique server id per test run so the registered clearer doesn't collide
// with any real server's clearer and is trivially identifiable.
const TEST_SERVER_ID = "test-reset-stickiness-server";

function makeDbOps(options: {
	accounts: Array<{ id: string; name: string }>;
	onClearSessionAnchor?: (accountId: string) => void;
}): DatabaseOperations {
	return {
		getAdapter: () => ({
			get: async (_sql: string, params?: unknown[]) => {
				const accountId = Array.isArray(params) ? params[0] : undefined;
				return options.accounts.find((a) => a.id === accountId) ?? null;
			},
		}),
		clearAccountSessionAnchor: async (accountId: string): Promise<number> => {
			options.onClearSessionAnchor?.(accountId);
			return 1;
		},
	} as unknown as DatabaseOperations;
}

describe("createAccountResetStickinessHandler", () => {
	// Registering a null clearer keeps clearAccountAffinity() side-effect-free
	// across tests unless a test overrides it.
	beforeEach(() => {
		registerAffinityClearer(TEST_SERVER_ID, () => 0);
	});

	afterEach(() => {
		registerAffinityClearer(TEST_SERVER_ID, () => 0);
	});

	it("returns 404 for an unknown account id", async () => {
		const handler = createAccountResetStickinessHandler(
			makeDbOps({ accounts: [] }),
		);

		const response = await handler({} as Request, "missing-account");

		expect(response.status).toBe(404);
	});

	it("clears affinity pins and the session anchor on success", async () => {
		const clearedAnchorFor: string[] = [];
		const affinityClearedFor: string[] = [];

		// Register a clearer that reports it cleared 3 pins for the target.
		// Filter by id so this clearer stays neutral (returns 0) for the account
		// ids other test files probe against the shared proxy registry.
		registerAffinityClearer(TEST_SERVER_ID, (accountId) => {
			if (accountId !== "acc-1") return 0;
			affinityClearedFor.push(accountId);
			return 3;
		});

		const handler = createAccountResetStickinessHandler(
			makeDbOps({
				accounts: [{ id: "acc-1", name: "Account One" }],
				onClearSessionAnchor: (id) => clearedAnchorFor.push(id),
			}),
		);

		const response = await handler({} as Request, "acc-1");
		const body = (await response.json()) as {
			success: boolean;
			message: string;
			cleared: number;
		};

		expect(response.status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.message).toBe("Session stickiness reset for 'Account One'");
		// Affinity clearer invoked for this account; its 3 pins are reflected in
		// the response. `clearAccountAffinity` sums across ALL registered servers
		// (a module-level singleton in @clankermux/proxy that other test files in
		// the same run may also populate), so assert our contribution is present
		// rather than an exact total.
		expect(affinityClearedFor).toContain("acc-1");
		expect(body.cleared).toBeGreaterThanOrEqual(3);
		// Persisted session anchor also expired.
		expect(clearedAnchorFor).toEqual(["acc-1"]);
	});
});
