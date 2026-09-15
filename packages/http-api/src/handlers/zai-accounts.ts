import { randomUUID } from "node:crypto";
import {
	patterns,
	sanitizers,
	validatePriority,
	validateString,
} from "@clankermux/core";
import type { DatabaseOperations } from "@clankermux/database";
import {
	BadRequest,
	errorResponse,
	jsonResponse,
} from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import {
	createZaiLogin,
	exchangeZaiLogin,
	usageCache,
	type ZaiCredential,
	type ZaiLogin,
} from "@clankermux/providers";
import { clearAccountRefreshCache } from "@clankermux/proxy";
import type { Account, AccountIdentity } from "@clankermux/types";
import { primeUsagePollingForNewAccount } from "./account-usage-priming";
import {
	API_KEY_ACCOUNT_TTL_MS,
	API_KEY_PROVIDERS,
	createApiKeyAccountAddHandler,
} from "./api-key-account-add";

const log = new Logger("ZaiAccounts");

/** Admin-only endpoints: credentials are accepted in POST bodies and never echoed. */
export function createZaiAccountHandlers(
	dbOps: DatabaseOperations,
	exchange: typeof exchangeZaiLogin = exchangeZaiLogin,
	createLogin: typeof createZaiLogin = createZaiLogin,
) {
	const sessions = new Map<
		string,
		{
			login: ZaiLogin;
			account: { name: string; priority: number };
			target?: Account;
		}
	>();
	const addHandler = createApiKeyAccountAddHandler(
		dbOps,
		API_KEY_PROVIDERS.zai,
	);
	const read = async (req: Request) => {
		const body: unknown = await req.json();
		if (!body || typeof body !== "object" || Array.isArray(body))
			throw BadRequest("Expected a JSON object");
		return body as Record<string, unknown>;
	};
	const redirectInput = (body: Record<string, unknown>) => {
		const code = validateString(body.code, "Z.AI redirect URL", {
			required: true,
			maxLength: 16_384,
			transform: sanitizers.trim,
		});
		if (!code) throw BadRequest("Z.AI redirect URL is required");
		return code;
	};
	const failure = (error: unknown) =>
		errorResponse(
			BadRequest(
				error instanceof Error &&
					/^(Z\.AI|name|priority|Expected)/.test(error.message)
					? error.message
					: "Z.AI account verification failed",
			),
		);
	const identityOf = (
		credential: ZaiCredential,
	): AccountIdentity | undefined =>
		credential.accountId || credential.email
			? {
					externalAccountId: credential.accountId ?? null,
					email: credential.email ?? null,
					organizationName: null,
					planTier: null,
					rateLimitTier: null,
				}
			: undefined;
	const newSession = (
		account: { name: string; priority: number },
		target?: Account,
	) => {
		for (const [id, entry] of sessions)
			if (entry.login.expiresAt <= Date.now()) sessions.delete(id);
		if (sessions.size >= 64)
			throw BadRequest(
				"Z.AI login limit reached; wait for existing links to expire",
			);
		const login = createLogin();
		const sessionId = randomUUID();
		sessions.set(sessionId, { login, account, target });
		return jsonResponse({
			sessionId,
			authUrl: login.url,
			expiresAt: login.expiresAt,
		});
	};
	/**
	 * Take a session and the redirect URL that goes with it. `reconnect` decides
	 * which half of the flow owns the session, so a reconnect session can never
	 * create an account and a login session can never re-key one.
	 */
	const consume = (body: Record<string, unknown>, reconnect: boolean) => {
		const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
		const entry = sessions.get(sessionId);
		if (
			!entry ||
			Boolean(entry.target) !== reconnect ||
			entry.login.expiresAt <= Date.now()
		) {
			sessions.delete(sessionId);
			throw BadRequest(
				reconnect
					? "Z.AI reconnect expired; start again"
					: "Z.AI login expired; start again",
			);
		}
		const input = redirectInput(body);
		sessions.delete(sessionId); // Single-use, including failed exchanges.
		return { entry, input };
	};
	const save = async (
		req: Request,
		account: { name: string; priority: number },
		credential: ZaiCredential,
	) => {
		const response = await addHandler(
			new Request(req.url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ...account, apiKey: credential.apiKey }),
				signal: req.signal,
			}),
		);
		const identity = identityOf(credential);
		if (response.ok && identity) {
			const { account: created } = (await response.clone().json()) as {
				account: { id: string };
			};
			try {
				await dbOps.setAccountIdentityFromProfile(created.id, identity);
			} catch {
				log.warn(
					"Z.AI identity persistence failed; live metadata will supply identity",
				);
			}
		}
		return response;
	};
	const reconnect = async (target: Account, credential: ZaiCredential) => {
		const identity = identityOf(credential);
		// A captured identity is the account's binding: re-keying it with a
		// different (or unidentified) sign-in would point the row at another
		// subscription while keeping its history.
		if (
			target.identity_external_id &&
			identity?.externalAccountId !== target.identity_external_id
		)
			throw BadRequest(
				"Z.AI sign-in belongs to a different account; sign in with the account shown",
			);
		const changed = await dbOps.reconnectZaiAccount(target.id, {
			apiKey: credential.apiKey,
			expiresAt: Date.now() + API_KEY_ACCOUNT_TTL_MS,
			identity,
			expectedApiKey: target.api_key,
			expectedExternalId: target.identity_external_id ?? null,
		});
		if (!changed)
			throw BadRequest(
				"Z.AI account changed during sign-in; start reconnect again",
			);
		clearAccountRefreshCache(target.id);
		usageCache.stopPolling(target.id);
		usageCache.delete(target.id);
		await primeUsagePollingForNewAccount(target);
		return jsonResponse({ success: true });
	};
	return {
		login: async (req: Request) => {
			try {
				const body = await read(req);
				const name = validateString(body.name, "name", {
					required: true,
					minLength: 1,
					maxLength: 100,
					pattern: patterns.accountName,
					transform: sanitizers.trim,
				});
				if (!name) throw BadRequest("name is required");
				return newSession({
					name,
					priority: validatePriority(body.priority ?? 0),
				});
			} catch (error) {
				return failure(error);
			}
		},
		complete: async (req: Request) => {
			try {
				const { entry, input } = consume(await read(req), false);
				return await save(
					req,
					entry.account,
					await exchange(entry.login, input, fetch, req.signal),
				);
			} catch (error) {
				return failure(error);
			}
		},
		reauthStart: async (req: Request) => {
			try {
				const body = await read(req);
				const accountId = validateString(body.accountId, "accountId", {
					required: true,
					maxLength: 128,
				});
				const target = accountId ? await dbOps.getAccount(accountId) : null;
				if (!target || target.provider !== "zai")
					throw BadRequest("Z.AI account not found");
				return newSession(
					{ name: target.name, priority: target.priority ?? 0 },
					target,
				);
			} catch (error) {
				return failure(error);
			}
		},
		reauthComplete: async (req: Request) => {
			try {
				const { entry, input } = consume(await read(req), true);
				const target = entry.target;
				if (!target) throw BadRequest("Z.AI reconnect expired; start again");
				return await reconnect(
					target,
					await exchange(entry.login, input, fetch, req.signal),
				);
			} catch (error) {
				return failure(error);
			}
		},
	};
}
