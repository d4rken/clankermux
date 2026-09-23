/**
 * The exact headers each Anthropic request ClankerMux originates puts on the
 * wire, captured at the fetch (or in-process dispatch) boundary: lower-cased
 * name and value, sorted. A change here changes the identity Anthropic sees,
 * so it must be deliberate.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import {
	trackClaudeCliStainlessHeaders,
	trackClientVersion,
} from "@clankermux/core";
import {
	BunSqlAdapter,
	ensureSchema,
	RoutingRepository,
} from "@clankermux/database";
import type { Account } from "@clankermux/types";
import { AccountModelPermissionService } from "../account-model-permissions";
import { AnthropicModelCatalogCache } from "../anthropic-model-catalog-cache";
import { AutoRefreshScheduler } from "../auto-refresh-scheduler";
import { ClaudeDeviceRegistry } from "../claude-device-registry";

function sorted(headers: HeadersInit | undefined): Array<[string, string]> {
	return Array.from(new Headers(headers).entries()).sort(([a], [b]) =>
		a.localeCompare(b),
	);
}

function anthropicAccount(patch: Partial<Account> = {}): Account {
	return {
		id: "anthropic-1",
		name: "Claude-1",
		provider: "anthropic",
		api_key: null,
		custom_endpoint: null,
		paused: false,
		...patch,
	} as Account;
}

const databases: Database[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

describe("Claude identity at the fetch boundary", () => {
	it("auto-refresh keepalive names the last client seen", async () => {
		trackClientVersion("claude-cli/2.1.63 (external, cli)");
		trackClaudeCliStainlessHeaders(
			new Headers({
				"user-agent": "claude-cli/2.1.63 (external, cli)",
				"x-stainless-arch": "x64",
				"x-stainless-lang": "js",
				"x-stainless-os": "Linux",
				"x-stainless-package-version": "0.112.7",
				"x-stainless-retry-count": "1",
				"x-stainless-runtime": "node",
				"x-stainless-runtime-version": "v26.3.9",
			}),
		);
		const devices = new ClaudeDeviceRegistry();
		devices.record("acc-1", "e01ccdf3".repeat(8));
		const dispatched: Request[] = [];
		const scheduler = new AutoRefreshScheduler(
			{
				query: async () => [{ auto_refresh_enabled: 1 }],
				run: async () => {},
				runWithChanges: async () => 1,
			} as never,
			{
				runtime: { port: 8080, clientId: "test-client" },
				refreshInFlight: new Map(),
				claudeDevices: devices,
			} as never,
			undefined,
			(async (req: Request) => {
				dispatched.push(req);
				return new Response("", { status: 500 });
			}) as never,
		) as never as {
			sendTranslatedClaudePrime(row: Record<string, unknown>): Promise<boolean>;
		};

		await scheduler.sendTranslatedClaudePrime({
			id: "acc-1",
			name: "backup",
			provider: "anthropic",
			refresh_token: "rt",
			access_token: "at",
			expires_at: null,
			rate_limit_reset: null,
			custom_endpoint: null,
			paused: 0,
			auto_pause_on_overage_enabled: 0,
			pause_reason: null,
		});

		expect(dispatched[0]?.url).toBe("http://internal.clankermux/v1/messages");
		const sessionId = dispatched[0]?.headers.get("x-claude-code-session-id");
		expect(sessionId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(await dispatched[0]?.text()).toBe(
			`{"model":"claude-haiku-4-5-20251001","max_tokens":1,"messages":[{"role":"user","content":"quota"}],"metadata":{"user_id":"{\\"device_id\\":\\"${"e01ccdf3".repeat(8)}\\",\\"account_uuid\\":\\"\\",\\"session_id\\":\\"${sessionId}\\"}"}}`,
		);
		expect(sorted(dispatched[0]?.headers)).toEqual([
			["accept", "application/json"],
			[
				"anthropic-beta",
				"interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219,advisor-tool-2026-03-01,oauth-2025-04-20",
			],
			["anthropic-dangerous-direct-browser-access", "true"],
			["anthropic-version", "2023-06-01"],
			["connection", "keep-alive"],
			["content-type", "application/json"],
			["user-agent", "claude-cli/2.1.63 (external, cli)"],
			["x-app", "cli"],
			["x-clankermux-account-id", "acc-1"],
			["x-clankermux-auto-refresh", "true"],
			["x-clankermux-bypass-session", "true"],
			["x-claude-code-session-id", sessionId as string],
			["x-stainless-arch", "x64"],
			["x-stainless-lang", "js"],
			["x-stainless-os", "Linux"],
			["x-stainless-package-version", "0.112.7"],
			["x-stainless-retry-count", "0"],
			["x-stainless-runtime", "node"],
			["x-stainless-runtime-version", "v26.3.9"],
			["x-stainless-timeout", "600"],
		]);
	});

	it("model catalogue", async () => {
		const seen: Array<[string, RequestInit | undefined]> = [];
		const cache = new AnthropicModelCatalogCache({
			listAccounts: async () => [anthropicAccount()],
			getAccessToken: async () => "tok",
			fetchImpl: (async (input: string, init?: RequestInit) => {
				seen.push([String(input), init]);
				return Response.json({
					data: [{ id: "claude-opus-9", display_name: "Claude Opus 9" }],
				});
			}) as unknown as typeof fetch,
			now: () => 1_000,
		});

		await cache.get();

		expect(seen[0]?.[0]).toBe("https://api.anthropic.com/v1/models?limit=1000");
		expect(sorted(seen[0]?.[1]?.headers)).toEqual([
			["accept", "application/json"],
			["anthropic-beta", "oauth-2025-04-20"],
			["anthropic-version", "2023-06-01"],
			["authorization", "Bearer tok"],
		]);
	});

	describe("account model permissions", () => {
		async function discoveryHeaders(account: Account) {
			const db = new Database(":memory:");
			databases.push(db);
			ensureSchema(db);
			const seen: Array<[string, RequestInit | undefined]> = [];
			const service = new AccountModelPermissionService({
				repository: new RoutingRepository(new BunSqlAdapter(db)),
				listAccounts: async () => [account],
				getAccessToken: async () => "tok",
				fetchImpl: (async (
					input: string | URL | Request,
					init?: RequestInit,
				) => {
					seen.push([String(input), init]);
					return Response.json({ data: [{ id: "m" }], has_more: false });
				}) as typeof fetch,
				requestBudgetMs: 1_000,
				backgroundBudgetMs: 1_000,
			});
			await service.refresh(account);
			expect(seen[0]?.[0]).toBe(
				"https://api.anthropic.com/v1/models?limit=1000",
			);
			return sorted(seen[0]?.[1]?.headers);
		}

		it("OAuth", async () => {
			expect(await discoveryHeaders(anthropicAccount())).toEqual([
				["accept", "application/json"],
				["anthropic-beta", "oauth-2025-04-20"],
				["anthropic-version", "2023-06-01"],
				["authorization", "Bearer tok"],
			]);
		});

		it("API key", async () => {
			expect(
				await discoveryHeaders(anthropicAccount({ api_key: "account-key" })),
			).toEqual([
				["accept", "application/json"],
				["anthropic-version", "2023-06-01"],
				["x-api-key", "account-key"],
			]);
		});
	});
});
