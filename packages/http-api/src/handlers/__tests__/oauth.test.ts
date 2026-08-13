import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { DatabaseOperations } from "@clankermux/database";
import {
	DatabaseFactory,
	DatabaseOperations as DirectDbOps,
} from "@clankermux/database";
import { usageCache } from "@clankermux/providers";
import {
	clearAllPendingRotationsForTests,
	getPendingRotation,
	type PendingRotationWriter,
	recordPendingRotation,
	registerCodexUsageRefresher,
	unregisterCodexUsageRefresher,
} from "@clankermux/proxy";
import {
	createAnthropicReauthCallbackHandler,
	createAnthropicReauthInitHandler,
	createCodexReauthHandler,
	createOAuthInitHandler,
} from "../oauth";

// Test database path
const TEST_DB_PATH = "/tmp/test-oauth-handler.db";

describe("OAuth Handler - Backward Compatibility", () => {
	let dbOps: DatabaseOperations;
	let handler: (req: Request) => Promise<Response>;

	beforeAll(async () => {
		// Clean up any existing test database
		try {
			if (existsSync(TEST_DB_PATH)) {
				unlinkSync(TEST_DB_PATH);
			}
		} catch (error) {
			console.warn("Failed to clean up existing test database:", error);
		}

		// Initialize test database
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();

		// Create handler
		handler = createOAuthInitHandler(dbOps);
	});

	afterAll(() => {
		// Clean up test database
		try {
			if (existsSync(TEST_DB_PATH)) {
				unlinkSync(TEST_DB_PATH);
			}
		} catch (error) {
			console.warn("Failed to clean up test database:", error);
		}
		DatabaseFactory.reset();
	});

	describe('Deprecated "max" mode handling', () => {
		it('should accept "max" mode and convert to "claude-oauth"', async () => {
			const request = new Request("http://localhost/api/oauth/init", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "test-account",
					mode: "max",
					priority: 0,
				}),
			});

			const response = await handler(request);
			const data = await response.json();

			// Should succeed (creates OAuth session)
			expect(response.status).toBe(200);
			expect(data.success).toBe(true);
			expect(data.authUrl).toBeDefined();
			expect(data.sessionId).toBeDefined();

			// Note: We can't easily verify the warning was logged without mocking the logger,
			// but the fact that it succeeded proves the mode was converted
		});

		it('should accept "claude-oauth" mode normally', async () => {
			const request = new Request("http://localhost/api/oauth/init", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "test-account-2",
					mode: "claude-oauth",
					priority: 0,
				}),
			});

			const response = await handler(request);
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(data.success).toBe(true);
			expect(data.authUrl).toBeDefined();
		});

		it('should accept "console" mode normally', async () => {
			const request = new Request("http://localhost/api/oauth/init", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "test-account-3",
					mode: "console",
					priority: 0,
				}),
			});

			const response = await handler(request);
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(data.success).toBe(true);
			expect(data.authUrl).toBeDefined();
		});

		it("should reject invalid mode", async () => {
			const request = new Request("http://localhost/api/oauth/init", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "test-account-4",
					mode: "invalid-mode",
					priority: 0,
				}),
			});

			const response = await handler(request);

			expect(response.status).toBe(400);
			const data = await response.json();
			expect(data.error).toContain("mode");
		});

		it("should default to claude-oauth when mode is omitted", async () => {
			const request = new Request("http://localhost/api/oauth/init", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "test-account-5",
					priority: 0,
				}),
			});

			const response = await handler(request);
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(data.success).toBe(true);
		});
	});

	describe("Input validation", () => {
		it("should require account name", async () => {
			const request = new Request("http://localhost/api/oauth/init", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					mode: "claude-oauth",
					priority: 0,
				}),
			});

			const response = await handler(request);

			expect(response.status).toBe(400);
			const data = await response.json();
			expect(data.error).toContain("name");
		});

		it("should accept custom endpoint", async () => {
			const request = new Request("http://localhost/api/oauth/init", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "test-account-6",
					mode: "claude-oauth",
					priority: 0,
					customEndpoint: "https://api.anthropic.com",
				}),
			});

			const response = await handler(request);
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(data.success).toBe(true);
		});

		it("should reject invalid custom endpoint URL", async () => {
			const request = new Request("http://localhost/api/oauth/init", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "test-account-7",
					mode: "claude-oauth",
					priority: 0,
					customEndpoint: "not-a-valid-url",
				}),
			});

			const response = await handler(request);

			// Validation errors currently return 500 (caught by outer try/catch)
			expect(response.status).toBe(500);
		});
	});
});

// ---------------------------------------------------------------------------
// Codex reauth handler
// ---------------------------------------------------------------------------

// Mock initiateCodexDeviceFlow so tests never hit the network.
// bun:test mock.module must be called at top-level (before imports resolve),
// so we set up a module-level mock here and override its return value per-test
// via the exported spy.
const mockInitiateCodexDeviceFlow = mock(async () => ({
	deviceAuthId: "test-device-auth-id",
	userCode: "TEST-CODE",
	verificationUrl: "https://auth.openai.com/codex/device",
	interval: 5,
}));

mock.module("@clankermux/providers/codex", () => ({
	initiateCodexDeviceFlow: mockInitiateCodexDeviceFlow,
	pollCodexForToken: mock(async () => ({
		access_token: "at",
		refresh_token: "rt",
		expires_in: 3600,
	})),
	// The handler calls this on the success path before writing the tokens;
	// without it the whole post-token block throws and never runs.
	extractCodexIdentity: () => null,
}));

const CODEX_REAUTH_DB_PATH = "/tmp/test-codex-reauth-handler.db";

describe("createCodexReauthHandler", () => {
	let dbOps: DatabaseOperations;
	let handler: (req: Request) => Promise<Response>;

	beforeAll(async () => {
		try {
			if (existsSync(CODEX_REAUTH_DB_PATH)) {
				unlinkSync(CODEX_REAUTH_DB_PATH);
			}
		} catch {
			// ignore
		}

		// Use DirectDbOps to avoid polluting the DatabaseFactory singleton
		// (multiple describe blocks each closing the singleton causes "Database has closed").
		dbOps = new DirectDbOps(CODEX_REAUTH_DB_PATH);
		handler = createCodexReauthHandler(dbOps);
	});

	afterAll(async () => {
		await dbOps.close();
		try {
			if (existsSync(CODEX_REAUTH_DB_PATH)) {
				unlinkSync(CODEX_REAUTH_DB_PATH);
			}
		} catch {
			// ignore
		}
	});

	it("should return 400 when accountId is missing", async () => {
		const req = new Request("http://localhost/api/oauth/reauth/codex", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		const res = await handler(req);
		expect(res.status).toBe(400);
		const data = await res.json();
		expect(data.error).toBeDefined();
	});

	it("should return 404 when account does not exist", async () => {
		const req = new Request("http://localhost/api/oauth/reauth/codex", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				accountId: "00000000-0000-0000-0000-000000000000",
			}),
		});

		const res = await handler(req);
		expect(res.status).toBe(404);
		const data = await res.json();
		expect(data.error).toMatch(/not found/i);
	});

	it("should return 400 when account has wrong provider", async () => {
		// Insert a non-codex account directly
		const accountId = "aaaaaaaa-0000-0000-0000-000000000001";
		const now = Date.now();
		await dbOps.getAdapter().run(
			`INSERT INTO accounts (id, name, provider, api_key, refresh_token, access_token,
			expires_at, created_at, request_count, total_requests, priority,
			custom_endpoint, model_mappings, model_fallbacks)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, NULL, NULL, NULL)`,
			[
				accountId,
				"anthropic-account",
				"anthropic",
				null,
				"rt",
				"at",
				now + 3600000,
				now,
			],
		);

		const req = new Request("http://localhost/api/oauth/reauth/codex", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ accountId }),
		});

		const res = await handler(req);
		expect(res.status).toBe(400);
		const data = await res.json();
		expect(data.error).toMatch(/codex/i);
	});

	it("should return 200 with sessionId, verificationUrl, userCode for a valid Codex account", async () => {
		// Insert a codex account
		const accountId = "bbbbbbbb-0000-0000-0000-000000000002";
		const now = Date.now();
		await dbOps.getAdapter().run(
			`INSERT INTO accounts (id, name, provider, api_key, refresh_token, access_token,
			expires_at, created_at, request_count, total_requests, priority,
			custom_endpoint, model_mappings, model_fallbacks)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, NULL, NULL, NULL)`,
			[
				accountId,
				"codex-account",
				"codex",
				null,
				"old-rt",
				"old-at",
				now + 3600000,
				now,
			],
		);

		const req = new Request("http://localhost/api/oauth/reauth/codex", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ accountId }),
		});

		const res = await handler(req);
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.success).toBe(true);
		expect(typeof data.sessionId).toBe("string");
		expect(data.sessionId.length).toBeGreaterThan(0);
		expect(data.verificationUrl).toBe("https://auth.openai.com/codex/device");
		expect(data.userCode).toBe("TEST-CODE");
	});

	// A reauth normally follows a plan change or a revoked grant, so every usage
	// observation made under the OLD credentials is suspect. Leaving it in place
	// meant the dashboard kept serving pre-reauth limits until something else
	// happened to overwrite them.
	describe("post-reauth usage invalidation", () => {
		async function insertCodexAccount(accountId: string): Promise<void> {
			const now = Date.now();
			await dbOps.getAdapter().run(
				`INSERT INTO accounts (id, name, provider, api_key, refresh_token, access_token,
				expires_at, created_at, request_count, total_requests, priority,
				custom_endpoint, model_mappings, model_fallbacks,
				codex_usage_json, codex_usage_observed_at)
				VALUES (?, ?, 'codex', NULL, 'old-rt', 'old-at', ?, ?, 0, 0, 0, NULL, NULL, NULL, ?, ?)`,
				[
					accountId,
					`codex-${accountId}`,
					now + 3600000,
					now,
					JSON.stringify({
						five_hour: null,
						seven_day: { utilization: 99, resets_at: null },
					}),
					now - 60_000,
				],
			);
		}

		async function reauth(accountId: string): Promise<void> {
			const res = await handler(
				new Request("http://localhost/api/oauth/reauth/codex", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ accountId }),
				}),
			);
			expect(res.status).toBe(200);
			// The device-flow polling runs detached from the response; give the
			// background task its turns.
			for (let i = 0; i < 10; i++) {
				await new Promise<void>((r) => setTimeout(r, 0));
			}
		}

		function readUsageColumns(accountId: string) {
			return dbOps.getAdapter().get<{
				codex_usage_json: string | null;
				codex_usage_observed_at: number | null;
			}>(
				"SELECT codex_usage_json, codex_usage_observed_at FROM accounts WHERE id = ?",
				[accountId],
			);
		}

		it("NULLs the persisted snapshot, drops the cache entry, and triggers one free read", async () => {
			const accountId = "dddddddd-0000-0000-0000-000000000010";
			await insertCodexAccount(accountId);
			usageCache.set(accountId, {
				five_hour: { utilization: 99, resets_at: null },
				seven_day: { utilization: 99, resets_at: null },
			});

			const refreshed: string[] = [];
			registerCodexUsageRefresher("oauth-test-refresher", async (id) => {
				refreshed.push(id);
				return { success: true, message: "ok" };
			});
			try {
				await reauth(accountId);
			} finally {
				unregisterCodexUsageRefresher("oauth-test-refresher");
			}

			const row = await readUsageColumns(accountId);
			expect(row?.codex_usage_json ?? null).toBeNull();
			expect(row?.codex_usage_observed_at ?? null).toBeNull();
			expect(usageCache.peekAge(accountId)).toBeNull();
			expect(refreshed).toEqual([accountId]);
		});

		// A rotation awaiting a persist describes a generation the provider has
		// already replaced once a reauth lands; retrying it would write dead
		// credentials over the fresh ones.
		it("drops a pending refresh-token rotation for the re-authenticated account", async () => {
			const accountId = "dddddddd-0000-0000-0000-000000000012";
			await insertCodexAccount(accountId);
			recordPendingRotation(
				accountId,
				{
					accessToken: "at-pending",
					expiresAt: Date.now() + 3_600_000,
					refreshToken: "rt-pending",
					identity: null,
					attemptedRefreshToken: "old-rt",
				},
				{ updateAccountTokens: async () => true } as PendingRotationWriter,
			);

			try {
				await reauth(accountId);
				expect(getPendingRotation(accountId)).toBeUndefined();
			} finally {
				clearAllPendingRotationsForTests();
			}
		});

		it("still completes the reauth when the triggered refresh fails", async () => {
			const accountId = "dddddddd-0000-0000-0000-000000000011";
			await insertCodexAccount(accountId);

			const rejections: unknown[] = [];
			const onRejection = (reason: unknown) => rejections.push(reason);
			process.on("unhandledRejection", onRejection);
			registerCodexUsageRefresher("oauth-test-refresher-fail", async () => {
				throw new Error("refresher exploded");
			});
			try {
				await reauth(accountId);
			} finally {
				unregisterCodexUsageRefresher("oauth-test-refresher-fail");
				process.off("unhandledRejection", onRejection);
			}

			// The invalidation still happened and nothing escaped as an unhandled
			// rejection.
			const row = await readUsageColumns(accountId);
			expect(row?.codex_usage_json ?? null).toBeNull();
			expect(rejections).toHaveLength(0);
		});
	});
});

// ---------------------------------------------------------------------------
// Anthropic reauth init handler
// ---------------------------------------------------------------------------

const ANTHROPIC_REAUTH_INIT_DB_PATH =
	"/tmp/test-anthropic-reauth-init-handler.db";

describe("createAnthropicReauthInitHandler", () => {
	let dbOps: DatabaseOperations;
	// Config is required by this handler — use a minimal stub
	const stubConfig = {
		getRuntime: () => ({ clientId: "test-client-id" }),
	} as unknown as import("@clankermux/config").Config;

	let handler: (req: Request) => Promise<Response>;

	beforeAll(async () => {
		try {
			if (existsSync(ANTHROPIC_REAUTH_INIT_DB_PATH)) {
				unlinkSync(ANTHROPIC_REAUTH_INIT_DB_PATH);
			}
		} catch {
			// ignore
		}

		dbOps = new DirectDbOps(ANTHROPIC_REAUTH_INIT_DB_PATH);
		handler = createAnthropicReauthInitHandler(dbOps, stubConfig);
	});

	afterAll(async () => {
		await dbOps.close();
		try {
			if (existsSync(ANTHROPIC_REAUTH_INIT_DB_PATH)) {
				unlinkSync(ANTHROPIC_REAUTH_INIT_DB_PATH);
			}
		} catch {
			// ignore
		}
	});

	it("should return 400 when accountId is missing", async () => {
		const req = new Request("http://localhost/api/oauth/reauth/anthropic", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		const res = await handler(req);
		expect(res.status).toBe(400);
		const data = await res.json();
		expect(data.error).toBeDefined();
	});

	it("should return 404 when account does not exist", async () => {
		const req = new Request("http://localhost/api/oauth/reauth/anthropic", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				accountId: "00000000-0000-0000-0000-000000000099",
			}),
		});

		const res = await handler(req);
		expect(res.status).toBe(404);
		const data = await res.json();
		expect(data.error).toMatch(/not found/i);
	});

	it("should return 400 when account has wrong provider (codex)", async () => {
		const accountId = "cccccccc-0000-0000-0000-000000000003";
		const now = Date.now();
		await dbOps.getAdapter().run(
			`INSERT INTO accounts (id, name, provider, api_key, refresh_token, access_token,
			expires_at, created_at, request_count, total_requests, priority,
			custom_endpoint, model_mappings, model_fallbacks)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, NULL, NULL, NULL)`,
			[
				accountId,
				"codex-account-for-anthropic-test",
				"codex",
				null,
				"rt",
				"at",
				now + 3600000,
				now,
			],
		);

		const req = new Request("http://localhost/api/oauth/reauth/anthropic", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ accountId }),
		});

		const res = await handler(req);
		expect(res.status).toBe(400);
		const data = await res.json();
		expect(data.error).toMatch(/anthropic/i);
	});
});

// ---------------------------------------------------------------------------
// Anthropic reauth callback handler
// ---------------------------------------------------------------------------

const ANTHROPIC_REAUTH_CALLBACK_DB_PATH =
	"/tmp/test-anthropic-reauth-callback-handler.db";

describe("createAnthropicReauthCallbackHandler", () => {
	let dbOps: DatabaseOperations;
	const stubConfig = {
		getRuntime: () => ({ clientId: "test-client-id" }),
	} as unknown as import("@clankermux/config").Config;

	let handler: (req: Request) => Promise<Response>;

	beforeAll(async () => {
		try {
			if (existsSync(ANTHROPIC_REAUTH_CALLBACK_DB_PATH)) {
				unlinkSync(ANTHROPIC_REAUTH_CALLBACK_DB_PATH);
			}
		} catch {
			// ignore
		}

		dbOps = new DirectDbOps(ANTHROPIC_REAUTH_CALLBACK_DB_PATH);
		handler = createAnthropicReauthCallbackHandler(dbOps, stubConfig);
	});

	afterAll(async () => {
		await dbOps.close();
		try {
			if (existsSync(ANTHROPIC_REAUTH_CALLBACK_DB_PATH)) {
				unlinkSync(ANTHROPIC_REAUTH_CALLBACK_DB_PATH);
			}
		} catch {
			// ignore
		}
	});

	it("should return 400 for non-POST method", async () => {
		const req = new Request(
			"http://localhost/api/oauth/reauth/anthropic/callback",
			{
				method: "GET",
			},
		);

		const res = await handler(req);
		expect(res.status).toBe(400);
		const data = await res.json();
		expect(data.error).toMatch(/post/i);
	});

	it("should return 400 when sessionId is missing", async () => {
		const req = new Request(
			"http://localhost/api/oauth/reauth/anthropic/callback",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ code: "some-auth-code" }),
			},
		);

		const res = await handler(req);
		expect(res.status).toBe(400);
		const data = await res.json();
		expect(data.error).toBeDefined();
	});

	it("should return 400 when code is missing", async () => {
		const req = new Request(
			"http://localhost/api/oauth/reauth/anthropic/callback",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					sessionId: "00000000-0000-0000-0000-000000000000",
				}),
			},
		);

		const res = await handler(req);
		expect(res.status).toBe(400);
		const data = await res.json();
		expect(data.error).toBeDefined();
	});

	it("should return 400 when OAuth session is not found in DB (expired)", async () => {
		const req = new Request(
			"http://localhost/api/oauth/reauth/anthropic/callback",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					sessionId: "deadbeef-dead-dead-dead-deaddeadbeef",
					code: "some-auth-code",
				}),
			},
		);

		const res = await handler(req);
		expect(res.status).toBe(400);
		const data = await res.json();
		expect(data.error).toMatch(/session/i);
	});
});
