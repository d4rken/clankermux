/**
 * An in-process ClankerMux front door for the SDK bridge tests: the real
 * router, adapters, proxy, recorder and bridge wiring on a temp database, with
 * none of the server's schedulers or pollers. Official Anthropic OAuth
 * accounts point their custom endpoint at a loopback mock upstream.
 *
 * Every fetch this process makes to a non-loopback host throws, so nothing
 * here can reach Anthropic even by mistake. Claude Code runs as a child
 * process the guard cannot see; the tests that start the real binary run it
 * inside a loopback-only network namespace.
 */
import { join } from "node:path";
import type { ClaudeSdkBridgeDeps } from "@clankermux/claude-sdk-bridge";
import { Config } from "@clankermux/config";
import { AsyncDbWriter, DatabaseOperations } from "@clankermux/database";
import {
	APIRouter,
	AuthService,
	generateApiKey,
	SessionAuthService,
} from "@clankermux/http-api";
import { SessionStrategy } from "@clankermux/load-balancer";
import { handleChatCompletionsRequest } from "@clankermux/openai-chat-adapter";
import { handleResponsesRequest } from "@clankermux/openai-responses-adapter";
import { getProvider } from "@clankermux/providers";
import {
	AccountModelPermissionService,
	dispatchProxyRequest,
	getValidAccessToken,
	handleProxy,
	type ProxyContext,
	RequestRecorder,
	setRequestRecorder,
} from "@clankermux/proxy";
import type { StrategyStore } from "@clankermux/types";
import {
	installSdkBridge,
	type SdkBridgeWiring,
} from "../../claude-sdk-bridge-wiring";
import { type RequestRouterDeps, routeRequest } from "../../request-router";

export interface GatewayAccount {
	id: string;
	name: string;
	/** The account's OAuth access token; the mock upstream sees it as Bearer. */
	token: string;
}

export interface Gateway {
	/** Base URL of the front door, e.g. http://127.0.0.1:PORT */
	url: string;
	apiKey: string;
	apiKeyId: string;
	dbOps: DatabaseOperations;
	proxyContext: ProxyContext;
	bridge: SdkBridgeWiring;
	/** Hosts a guarded fetch refused, in order. Must stay empty. */
	blockedEgress: string[];
	/** Read the gateway's database. */
	query<R>(sql: string, params?: unknown[]): Promise<R[]>;
	stop(): Promise<void>;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function guardEgress(blocked: string[]): () => void {
	const original = globalThis.fetch;
	const guarded = ((input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(
			input instanceof Request ? input.url : input.toString(),
		);
		if (!LOOPBACK.has(url.hostname)) {
			blocked.push(url.host);
			return Promise.reject(
				new Error(`test egress guard: refused ${url.host}`),
			);
		}
		return original(input, init);
	}) as typeof fetch;
	globalThis.fetch = Object.assign(guarded, original);
	return () => {
		globalThis.fetch = original;
	};
}

export async function startGateway(opts: {
	/** A fresh directory this gateway owns. */
	root: string;
	upstreamUrl: string;
	accounts: readonly GatewayAccount[];
	/** Models every account permits, as manual ids. */
	models: readonly string[];
	/** Bridge dependencies the test injects (fake query, timings, limits). */
	bridge?: Partial<ClaudeSdkBridgeDeps>;
}): Promise<Gateway> {
	const blockedEgress: string[] = [];
	const restoreFetch = guardEgress(blockedEgress);

	const config = new Config(join(opts.root, "config.json"));
	// Payload rows would start the off-thread payload writer; nothing here
	// reads them.
	config.setStorePayloads(false);
	const dbOps = new DatabaseOperations(join(opts.root, "clankermux.db"));
	const asyncWriter = new AsyncDbWriter({
		createPayloadWriter: dbOps.createPayloadWriterFactory({
			getPayloadRetentionMs: () => config.getPayloadRetentionMs(),
		}),
	});
	const requestRecorder = new RequestRecorder({
		dbOps,
		asyncWriter,
		getStorePayloads: () => false,
		getStoreHeaders: () => config.getStoreHeaders(),
		emitSummaryEvent: () => {},
	});
	setRequestRecorder(requestRecorder);

	const adapter = dbOps.getAdapter();
	const now = Date.now();
	for (const [priority, a] of opts.accounts.entries())
		await adapter.run(
			`INSERT INTO accounts (id, name, provider, access_token, refresh_token, expires_at, created_at, priority, custom_endpoint)
			 VALUES (?, ?, 'anthropic', ?, ?, ?, ?, ?, ?)`,
			[
				a.id,
				a.name,
				a.token,
				`fake-refresh-${a.id}`,
				now + 30 * 24 * 3600_000,
				now,
				priority,
				opts.upstreamUrl,
			],
		);

	const provider = getProvider("anthropic");
	if (!provider) throw new Error("anthropic provider missing");
	const strategy = new SessionStrategy(5 * 3600_000);
	strategy.initialize?.(dbOps as unknown as StrategyStore);
	let proxyContext: ProxyContext;
	const modelPermissions = new AccountModelPermissionService({
		repository: dbOps.routing,
		listAccounts: () => dbOps.getAllAccounts(),
		getAccessToken: (account) => getValidAccessToken(account, proxyContext),
	});
	for (const account of await dbOps.getAllAccounts()) {
		const current = await modelPermissions.permissions(account);
		await dbOps.routing.setManualModels(
			account.id,
			current.scope,
			[...opts.models],
			false,
			current.generation,
		);
	}
	proxyContext = {
		modelPermissions,
		strategy,
		dbOps,
		runtime: {
			clientId: "sdk-bridge-test",
			sessionDurationMs: 5 * 3600_000,
			port: 0,
		},
		config,
		provider,
		refreshInFlight: new Map(),
		asyncWriter,
		requestRecorder,
	};
	const bridge = await installSdkBridge({
		proxyContext,
		config,
		turnRepo: dbOps.sdkBridgeTurns,
		workRoot: join(opts.root, "claude-agent-sdk"),
		...(opts.bridge ? { overrides: opts.bridge } : {}),
	});

	const key = await generateApiKey(dbOps, "sdk-bridge-client", {
		accountId: null,
		providers: null,
		excludedProviders: null,
	});
	const sessionAuth = new SessionAuthService(dbOps);
	const authService = new AuthService(dbOps, undefined, sessionAuth);
	const apiRouter = new APIRouter({
		db: adapter,
		config,
		dbOps,
		sessionAuth,
		modelPermissions,
		getSdkBridgeStatus: () => bridge.status(),
	});
	const deps: RequestRouterDeps = {
		handleApiRequest: (url, req) => apiRouter.handleRequest(url, req),
		handlePublicRequest: async () => null,
		handleClientRequest: async () => null,
		authenticate: (req, path, method, requirement, options) =>
			authService.authenticateRequest(req, path, method, requirement, options),
		dispatchProxy: (req, url, apiKeyId, apiKeyName) =>
			dispatchProxyRequest(req, url, proxyContext, apiKeyId, apiKeyName),
		handleChatCompletions: (req, url, apiKeyId, apiKeyName) =>
			handleChatCompletionsRequest(
				req,
				url,
				handleProxy as Parameters<typeof handleChatCompletionsRequest>[2],
				proxyContext,
				apiKeyId,
				apiKeyName,
			),
		handleResponses: (req, url, apiKeyId, apiKeyName) =>
			handleResponsesRequest(
				req,
				url,
				handleProxy as Parameters<typeof handleResponsesRequest>[2],
				proxyContext,
				apiKeyId,
				apiKeyName,
			),
		handleModels: async () => new Response(null, { status: 404 }),
		withDashboard: false,
		dashboardManifest: null,
		serveDashboardFile: () => new Response(null, { status: 404 }),
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		fetch(req, srv) {
			proxyContext.server = srv;
			return routeRequest(req, deps);
		},
	});
	proxyContext.server = server;

	let stopped = false;
	return {
		url: `http://127.0.0.1:${server.port}`,
		apiKey: key.apiKey,
		apiKeyId: key.id,
		dbOps,
		proxyContext,
		bridge,
		blockedEgress,
		query: <R>(sql: string, params: unknown[] = []) =>
			adapter.query<R>(sql, params),
		async stop() {
			if (stopped) return;
			stopped = true;
			bridge.beginShutdown();
			await bridge.dispose();
			server.stop(true);
			await requestRecorder.dispose();
			await asyncWriter.dispose();
			await dbOps.close();
			restoreFetch();
		},
	};
}
