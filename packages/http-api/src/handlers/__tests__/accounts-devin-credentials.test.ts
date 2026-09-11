import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "@clankermux/config";
import { DatabaseOperations } from "@clankermux/database";
import type { AccountResponse } from "@clankermux/types";
import { createAccountsListHandler } from "../accounts";

let tmpDir: string;
let dbOps: DatabaseOperations;
const config = {
	getUsageThrottlingFiveHourEnabled: () => false,
	getUsageThrottlingWeeklyEnabled: () => false,
} as unknown as Config;
beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "clankermux-devin-credentials-"));
	dbOps = new DatabaseOperations(join(tmpDir, "test.db"));
});
afterEach(async () => {
	await dbOps.dispose();
	rmSync(tmpDir, { recursive: true, force: true });
});
describe("GET /api/accounts Devin credentials", () => {
	it.each([
		{
			name: "opaque session",
			apiKey: "opaque-session-secret",
			expiresAt: null,
			paused: 0,
			reason: null,
			status: "valid",
		},
		{
			name: "known future expiry",
			apiKey: "jwt-session-secret",
			expiresAt: Date.now() + 3_600_000,
			paused: 0,
			reason: null,
			status: "valid",
		},
		{
			name: "known past expiry",
			apiKey: "expired-session-secret",
			expiresAt: Date.now() - 3_600_000,
			paused: 0,
			reason: null,
			status: "expired",
		},
		{
			name: "missing session",
			apiKey: null,
			expiresAt: Date.now() + 3_600_000,
			paused: 0,
			reason: null,
			status: "expired",
		},
		{
			name: "blank session",
			apiKey: "  ",
			expiresAt: null,
			paused: 0,
			reason: null,
			status: "expired",
		},
		{
			name: "rejected session",
			apiKey: "rejected-session-secret",
			expiresAt: Date.now() + 3_600_000,
			paused: 1,
			reason: "oauth_invalid_grant",
			status: "expired",
		},
		{
			name: "manually paused session",
			apiKey: "paused-session-secret",
			expiresAt: null,
			paused: 1,
			reason: "manual",
			status: "valid",
		},
	])("reports $name without fabricating an expiry", async ({
		apiKey,
		expiresAt,
		paused,
		reason,
		status,
	}) => {
		await dbOps
			.getAdapter()
			.run(
				`INSERT INTO accounts (id, name, provider, api_key, refresh_token, access_token, expires_at, created_at, paused, pause_reason) VALUES ('devin-test', 'Devin', 'devin', ?, '', NULL, ?, ?, ?, ?)`,
				[apiKey, expiresAt, Date.now(), paused, reason],
			);
		const response = await createAccountsListHandler(dbOps, config)();
		expect(response.status).toBe(200);
		const accounts = (await response.json()) as AccountResponse[];
		expect(accounts[0]?.tokenStatus).toBe(status);
		expect(accounts[0]?.tokenExpiresAt).toBe(
			expiresAt === null ? null : new Date(expiresAt).toISOString(),
		);
		expect(JSON.stringify(accounts)).not.toContain("session-secret");
	});
});
