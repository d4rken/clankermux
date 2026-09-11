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
	createDevinLogin,
	devinClient,
	devinSessionExpiresAt,
	exchangeDevinLogin,
	extractDevinIdentity,
	usageCache,
} from "@clankermux/providers";
import { clearAccountRefreshCache } from "@clankermux/proxy";
import type { Account } from "@clankermux/types";
import { primeUsagePollingForNewAccount } from "./account-usage-priming";
import {
	API_KEY_PROVIDERS,
	createApiKeyAccountAddHandler,
} from "./api-key-account-add";

const log = new Logger("DevinAccounts");

/** Admin-only endpoints: credentials are accepted in POST bodies and never echoed. */
export function createDevinAccountHandlers(
	dbOps: DatabaseOperations,
	client: Pick<typeof devinClient, "getAccount"> &
		Partial<Pick<typeof devinClient, "invalidateAccount">> = devinClient,
	exchange: typeof exchangeDevinLogin = exchangeDevinLogin,
) {
	const sessions = new Map<
		string,
		{
			login: ReturnType<typeof createDevinLogin>;
			account: { name: string; priority: number };
			target?: Account;
		}
	>();
	const addHandler = createApiKeyAccountAddHandler(
		dbOps,
		API_KEY_PROVIDERS.devin,
	);
	const read = async (req: Request) => {
		const body: unknown = await req.json();
		if (!body || typeof body !== "object" || Array.isArray(body))
			throw BadRequest("Expected a JSON object");
		return body as Record<string, unknown>;
	};
	const token = (body: Record<string, unknown>) => {
		const value = validateString(body.apiKey, "apiKey", {
			required: true,
			maxLength: 16_384,
			transform: sanitizers.trim,
		});
		if (!value) throw BadRequest("Devin session token is required");
		return value;
	};
	const loginCode = (body: Record<string, unknown>) => {
		const code = validateString(body.code, "Devin login code", {
			required: true,
			maxLength: 16_384,
			transform: sanitizers.trim,
		});
		if (!code) throw BadRequest("Devin login code is required");
		return code;
	};
	const failure = (error: unknown) =>
		errorResponse(
			BadRequest(
				error instanceof Error &&
					/^(Devin|name|priority|apiKey|Expected)/.test(error.message)
					? error.message
					: "Devin account verification failed",
			),
		);
	const save = async (req: Request, body: Record<string, unknown>) => {
		const info = await client.getAccount(token(body), undefined, req.signal);
		const response = await addHandler(
			new Request(req.url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: req.signal,
			}),
		);
		if (response.ok) {
			const { account } = (await response.clone().json()) as {
				account: { id: string; name: string; provider: string };
			};
			const identity = extractDevinIdentity(info.usage);
			if (identity) {
				try {
					await dbOps.setAccountIdentityFromProfile(account.id, identity);
				} catch {
					log.warn(
						"Devin identity persistence failed; live metadata will supply identity",
					);
				}
			}
			await primeUsagePollingForNewAccount(account);
		}
		return response;
	};
	const reconnectTarget = async (
		body: Record<string, unknown>,
	): Promise<Account> => {
		const accountId = validateString(body.accountId, "accountId", {
			required: true,
			maxLength: 128,
		});
		const target = accountId ? await dbOps.getAccount(accountId) : null;
		if (!target || target.provider !== "devin")
			throw BadRequest("Devin account not found");
		return target;
	};
	const reconnect = async (req: Request, target: Account, apiKey: string) => {
		client.invalidateAccount?.(apiKey, target.custom_endpoint ?? undefined);
		const info = await client.getAccount(
			apiKey,
			target.custom_endpoint ?? undefined,
			req.signal,
		);
		const identity = extractDevinIdentity(info.usage);
		if (!identity?.externalAccountId)
			throw BadRequest(
				"Devin did not return an account identity; reconnect was not applied",
			);
		if (
			target.identity_external_id &&
			identity.externalAccountId !== target.identity_external_id
		)
			throw BadRequest(
				"Devin sign-in belongs to a different account; sign in with the account shown",
			);
		const changed = await dbOps.reconnectDevinAccount(target.id, {
			apiKey,
			expiresAt: devinSessionExpiresAt(apiKey),
			identity,
			expectedApiKey: target.api_key,
			expectedEndpoint: target.custom_endpoint ?? null,
			expectedExternalId: target.identity_external_id ?? null,
		});
		if (!changed)
			throw BadRequest(
				"Devin account changed during sign-in; start reconnect again",
			);
		if (target.api_key)
			client.invalidateAccount?.(
				target.api_key,
				target.custom_endpoint ?? undefined,
			);
		clearAccountRefreshCache(target.id);
		usageCache.stopPolling(target.id);
		usageCache.delete(target.id);
		await primeUsagePollingForNewAccount(target);
		return jsonResponse({ success: true });
	};
	const newSession = (
		account: { name: string; priority: number },
		target?: Account,
	) => {
		for (const [id, entry] of sessions)
			if (entry.login.expiresAt <= Date.now()) sessions.delete(id);
		if (sessions.size >= 64)
			throw BadRequest(
				"Devin login limit reached; wait for existing links to expire",
			);
		const login = createDevinLogin("manual");
		const sessionId = randomUUID();
		sessions.set(sessionId, { login, account, target });
		return jsonResponse({
			sessionId,
			authUrl: login.url,
			expiresAt: login.expiresAt,
		});
	};
	return {
		reauthStart: async (req: Request) => {
			try {
				const target = await reconnectTarget(await read(req));
				return newSession(
					{ name: target.name, priority: target.priority ?? 0 },
					target,
				);
			} catch (error) {
				return failure(error);
			}
		},
		reauthToken: async (req: Request) => {
			try {
				const body = await read(req);
				return await reconnect(req, await reconnectTarget(body), token(body));
			} catch (error) {
				return failure(error);
			}
		},
		reauthComplete: async (req: Request) => {
			try {
				const body = await read(req);
				const sessionId =
					typeof body.sessionId === "string" ? body.sessionId : "";
				const entry = sessions.get(sessionId);
				if (!entry?.target || entry.login.expiresAt <= Date.now()) {
					sessions.delete(sessionId);
					throw BadRequest("Devin reconnect expired; start again");
				}
				const code = loginCode(body);
				sessions.delete(sessionId);
				return await reconnect(
					req,
					entry.target,
					await exchange(entry.login, code),
				);
			} catch (error) {
				return failure(error);
			}
		},
		add: async (req: Request) => {
			try {
				return await save(req, await read(req));
			} catch (error) {
				return failure(error);
			}
		},
		models: async (req: Request) => {
			try {
				const info = await client.getAccount(
					token(await read(req)),
					undefined,
					req.signal,
				);
				return jsonResponse({ models: info.models, usage: info.usage });
			} catch (error) {
				return failure(error);
			}
		},
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
				const priority = validatePriority(body.priority ?? 0);
				return newSession({ name, priority });
			} catch (error) {
				return failure(error);
			}
		},
		complete: async (req: Request) => {
			try {
				const body = await read(req);
				const sessionId =
					typeof body.sessionId === "string" ? body.sessionId : "";
				const entry = sessions.get(sessionId);
				if (!entry || entry.target || entry.login.expiresAt <= Date.now()) {
					sessions.delete(sessionId);
					throw BadRequest("Devin login expired; start again");
				}
				const code = loginCode(body);
				sessions.delete(sessionId); // Single-use, including failed exchanges.
				const apiKey = await exchange(entry.login, code);
				return await save(req, { ...entry.account, apiKey });
			} catch (error) {
				return failure(error);
			}
		},
	};
}
