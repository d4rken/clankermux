import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { AccountIdentity, DevinUsageData } from "@clankermux/types";
import { decodeJwtPayloadSafe } from "../../oauth/jwt";
import type { DevinFetch } from "./auth";
import { DevinRpcError } from "./connect";
import {
	BillingStrategy,
	type ClientModelConfig,
	type DisplayOption,
	GetCliModelConfigsRequestSchema,
	GetCliModelConfigsResponseSchema,
	GetUserJwtRequestSchema,
	GetUserJwtResponseSchema,
	GetUserStatusRequestSchema,
	type GetUserStatusResponse,
	GetUserStatusResponseSchema,
	MetadataSchema,
	TeamsTier,
} from "./vendor/devin-proto";
import {
	create,
	fromBinary,
	type MessageCodec,
	type ProtoMessage,
	toBinary,
} from "./vendor/protobuf";

export const DEVIN_ENDPOINT = "https://server.codeium.com";
export const DEVIN_CHAT_PATH =
	"/exa.api_server_pb.ApiServerService/GetChatMessage";
export const DEVIN_UPSTREAM_MODEL = "x-clankermux-upstream-model";
const MAX_UNARY_BYTES = 8 * 1024 * 1024;

/** A session rejected by two consecutive authenticated metadata attempts. */
export class DevinSessionAuthenticationError extends DevinRpcError {
	constructor() {
		super("unauthenticated", "Devin session was rejected; sign in again");
		this.name = "DevinSessionAuthenticationError";
	}
}

/** JWT expiry is display/cache evidence only; opaque sessions have no known expiry. */
export function devinSessionExpiresAt(token: string): number | null {
	const raw = token.startsWith("devin-session-token$")
		? token.slice("devin-session-token$".length)
		: token;
	const exp = decodeJwtPayloadSafe(raw)?.exp;
	if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) return null;
	const ms = exp * 1000;
	return Number.isFinite(ms) && ms <= 8.64e15 ? ms : null;
}

export function devinMetadata(token: string, userJwt = "", discovery = false) {
	return create(MetadataSchema, {
		apiKey: token.startsWith("devin-session-token$")
			? token
			: `devin-session-token$${token}`,
		userJwt,
		ideName: discovery ? "chisel" : "devin-cli",
		ideType: "chisel",
		// Official CLI release manifest inspected 2026-09-11 (see docs/devin-swe2.md).
		ideVersion: discovery ? "0.0.0-dev" : "3000.10.21",
		extensionName: "chisel",
		extensionVersion: discovery ? "0.0.0-dev" : "3000.10.21",
		locale: "en",
		os:
			process.platform === "darwin"
				? "darwin"
				: process.platform === "win32"
					? "windows"
					: "linux",
		// Discovery slots 6/7/8 are present in the upstream request but not its older enum.
		supportedModelDisplays: discovery
			? ([3, 4, 6, 7, 8] as DisplayOption[])
			: [],
	});
}

export function validateDevinEndpoint(value = DEVIN_ENDPOINT): string {
	const url = new URL(value);
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(url.protocol !== "https:" &&
			!(
				url.protocol === "http:" &&
				["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
			))
	)
		throw new Error("Invalid Devin endpoint");
	return url.href.replace(/\/+$/, "");
}

export interface DevinModel {
	id: string;
	name: string;
	disabled: boolean;
	disabledReason: string | null;
	contextWindow: number | null;
	maxTokens: number | null;
	supportsImages: boolean;
	defaultInFamily: boolean;
	effort: string | null;
}
export interface DevinAccountInfo {
	userJwt: string;
	endpoint: string;
	models: DevinModel[];
	usage: DevinUsageData;
}

/** Identity from authenticated account metadata; never decode or expose session credentials. */
export function extractDevinIdentity(
	usage: Pick<
		DevinUsageData,
		"email" | "accountId" | "planName" | "organizationName"
	>,
): AccountIdentity | null {
	const value = (raw: unknown) =>
		typeof raw === "string" ? raw.trim() || null : null;
	const email = value(usage.email);
	const externalAccountId = value(usage.accountId);
	const planTier = value(usage.planName);
	const organizationName = value(usage.organizationName);
	if (!email && !externalAccountId && !planTier && !organizationName)
		return null;
	return {
		email,
		externalAccountId,
		planTier,
		organizationName,
		rateLimitTier: null,
	};
}

function accountCacheKey(token: string, endpoint: string): string {
	return createHash("sha256").update(`${endpoint}\0${token}`).digest("hex");
}

function modelInfo(config: ClientModelConfig): DevinModel {
	const family = config.modelFamilyMetadata;
	const effort =
		family?.entries.find((e) => /effort/i.test(e.key))?.value?.name ?? null;
	return {
		id: config.modelUid,
		name: config.label || config.modelUid,
		disabled: config.disabled,
		disabledReason:
			config.disabledReason?.description ||
			config.disabledReason?.shortReason ||
			null,
		contextWindow: config.modelInfo?.maxTokens || null,
		maxTokens: config.maxTokens || config.modelInfo?.maxOutputTokens || null,
		supportsImages: config.supportsImages,
		defaultInFamily:
			config.isDefaultModelInFamily || family?.isDefaultModelInFamily === true,
		effort,
	};
}

export function normalizeDevinUsage(
	response: GetUserStatusResponse,
): DevinUsageData {
	const user = response.userStatus;
	const status = user?.planStatus;
	const plan = response.planInfo ?? status?.planInfo;
	const quotaBased = plan?.billingStrategy === BillingStrategy.QUOTA;
	const window = (
		remaining: number | undefined,
		seconds: bigint | undefined,
		hidden: boolean | undefined,
	) => {
		if (!status || hidden || (!quotaBased && !(seconds && seconds > 0n)))
			return null;
		if (remaining === undefined || !Number.isFinite(remaining)) return null;
		return {
			utilization: 100 - Math.min(100, Math.max(0, remaining)),
			resetAt: seconds && seconds > 0n ? Number(seconds) * 1000 : null,
		};
	};
	const tier = plan?.teamsTier || user?.teamsTier || TeamsTier.UNSPECIFIED;
	const tierName =
		tier === TeamsTier.UNSPECIFIED
			? null
			: TeamsTier[tier]
					?.toLowerCase()
					.replace(
						/(?:^|_)([a-z])/g,
						(_, letter, offset) =>
							`${offset ? " " : ""}${letter.toUpperCase()}`,
					);
	return {
		kind: "devin",
		quotaBased,
		daily: window(
			status?.dailyQuotaRemainingPercent,
			status?.dailyQuotaResetAtUnix,
			plan?.hideDailyQuota,
		),
		weekly: window(
			status?.weeklyQuotaRemainingPercent,
			status?.weeklyQuotaResetAtUnix,
			plan?.hideWeeklyQuota,
		),
		planName: plan?.planName.trim() || tierName || null,
		email: user?.email.trim() || null,
		accountId: user?.userId.trim() || null,
		// The organization ID is separate from the authenticated user ID.
		organizationId:
			plan?.devinInfo?.orgId.trim() || user?.teamId.trim() || null,
		organizationName: plan?.devinInfo?.accountDisplayName.trim() || null,
		canUseCli: plan?.devinInfo ? plan.devinInfo.canUseCli : null,
		overageBalanceUsd: Number(status?.overageBalanceMicros ?? 0n) / 1_000_000,
		includedCreditsRemaining: status
			? Math.max(0, status.availablePromptCredits) +
				Math.max(0, status.availableFlowCredits)
			: null,
	};
}

/** Cache keys contain only a digest; failed requests are never cached. */
export class DevinClient {
	private readonly cache = new Map<
		string,
		{ expiresAt: number; value: Promise<DevinAccountInfo> }
	>();
	constructor(
		private readonly fetcher: DevinFetch = (...args) => fetch(...args),
	) {}

	async unary<T extends ProtoMessage, R extends ProtoMessage>(
		endpoint: string,
		path: string,
		schema: MessageCodec<T>,
		request: T,
		responseSchema: MessageCodec<R>,
		signal?: AbortSignal,
	): Promise<R> {
		const timeout = AbortSignal.timeout(30_000);
		const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
		const response = await this.fetcher(
			`${validateDevinEndpoint(endpoint)}${path}`,
			{
				method: "POST",
				headers: {
					"content-type": "application/proto",
					"connect-protocol-version": "1",
					accept: "application/proto",
				},
				body: new Uint8Array(toBinary(schema, request)),
				signal: combined,
				redirect: "error",
			},
		);
		if (!response.ok) {
			await response.body?.cancel();
			throw new DevinRpcError(
				response.status === 401
					? "unauthenticated"
					: response.status === 403
						? "permission_denied"
						: response.status === 429
							? "resource_exhausted"
							: "unavailable",
				`Devin account request failed (${response.status})`,
			);
		}
		if (!response.body)
			throw new DevinRpcError("data_loss", "Empty Devin account response");
		const reader = response.body.getReader();
		const abort = () => {
			void reader.cancel(combined.reason).catch(() => {});
		};
		if (combined.aborted) abort();
		combined.addEventListener("abort", abort, { once: true });
		const parts: Uint8Array[] = [];
		let size = 0;
		try {
			for (;;) {
				const { value, done } = await reader.read();
				combined.throwIfAborted();
				if (done) break;
				size += value.length;
				if (size > MAX_UNARY_BYTES)
					throw new DevinRpcError(
						"data_loss",
						"Devin account response exceeds size limit",
					);
				parts.push(value);
			}
		} finally {
			combined.removeEventListener("abort", abort);
			await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
		let bytes: Uint8Array = Buffer.concat(parts);
		if (bytes[0] === 0x1f && bytes[1] === 0x8b)
			bytes = gunzipSync(bytes, { maxOutputLength: MAX_UNARY_BYTES });
		try {
			return fromBinary(responseSchema, bytes);
		} catch {
			throw new DevinRpcError("data_loss", "Invalid Devin account response");
		}
	}

	/** Explicit metadata refresh leaves unrelated credentials and endpoints cached. */
	invalidateAccount(token: string, endpoint = DEVIN_ENDPOINT): void {
		this.cache.delete(accountCacheKey(token, validateDevinEndpoint(endpoint)));
	}

	/** Refresh the request JWT and account metadata, sharing an already-pending refresh. */
	refreshAccount(
		token: string,
		endpoint = DEVIN_ENDPOINT,
		signal?: AbortSignal,
	): Promise<DevinAccountInfo> {
		const key = accountCacheKey(token, validateDevinEndpoint(endpoint));
		if (this.cache.get(key)?.expiresAt !== Infinity) this.cache.delete(key);
		return this.getAccount(token, endpoint, signal);
	}

	getAccount(
		token: string,
		endpoint = DEVIN_ENDPOINT,
		signal?: AbortSignal,
	): Promise<DevinAccountInfo> {
		endpoint = validateDevinEndpoint(endpoint);
		const key = accountCacheKey(token, endpoint);
		const now = Date.now();
		const hit = this.cache.get(key);
		if (hit && hit.expiresAt > now) return this.withSignal(hit.value, signal);
		for (const [key, value] of this.cache)
			if (value.expiresAt <= now) this.cache.delete(key);
		if (this.cache.size >= 256) {
			const oldest = this.cache.keys().next().value;
			if (oldest) this.cache.delete(oldest);
		}
		// A caller's cancellation must not poison a shared auth request for another caller.
		const value = this.loadAccountWithAuthRetry(token, endpoint)
			.then((info) => {
				const entry = this.cache.get(key);
				if (entry?.value === value) {
					const settledAt = Date.now();
					// Upstream may keep reporting an old reset or a JWT inside the
					// refresh skew. Briefly reuse freshly fetched evidence instead of
					// repeating all metadata RPCs on every request. Future deadlines
					// retain their exact boundary; quota values remain unchanged.
					const boundedDeadline = (deadline: number) =>
						deadline <= settledAt ? settledAt + 1_000 : deadline;
					// A reset makes the cached percentage stale; fetch again before admitting traffic.
					const resets = [info.usage.daily?.resetAt, info.usage.weekly?.resetAt]
						.filter((v): v is number => v != null)
						.map(boundedDeadline);
					const jwtExpiry = devinSessionExpiresAt(info.userJwt);
					entry.expiresAt = Math.min(
						settledAt + 30_000,
						...resets,
						jwtExpiry === null ? Infinity : boundedDeadline(jwtExpiry - 5_000),
						// Never extend reuse beyond the JWT's actual expiry, including
						// when upstream returns an already-expired JWT.
						jwtExpiry ?? Infinity,
					);
				}
				return info;
			})
			.catch((error) => {
				if (this.cache.get(key)?.value === value) this.cache.delete(key);
				throw error;
			});
		// Pending metadata remains single-flight across its bounded RPC/retry sequence.
		this.cache.set(key, { expiresAt: Infinity, value });
		return this.withSignal(value, signal);
	}

	private withSignal(
		value: Promise<DevinAccountInfo>,
		signal?: AbortSignal,
	): Promise<DevinAccountInfo> {
		if (!signal) return value;
		return new Promise((resolve, reject) => {
			const abort = () =>
				reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
			if (signal.aborted) return abort();
			signal.addEventListener("abort", abort, { once: true });
			value
				.then(resolve, reject)
				.finally(() => signal.removeEventListener("abort", abort));
		});
	}

	private async loadAccountWithAuthRetry(
		token: string,
		endpoint: string,
	): Promise<DevinAccountInfo> {
		try {
			return await this.loadAccount(token, endpoint);
		} catch (error) {
			if (!(error instanceof DevinRpcError) || error.code !== "unauthenticated")
				throw error;
		}
		try {
			return await this.loadAccount(token, endpoint);
		} catch (error) {
			if (error instanceof DevinRpcError && error.code === "unauthenticated")
				throw new DevinSessionAuthenticationError();
			throw error;
		}
	}

	private async loadAccount(
		token: string,
		endpoint: string,
	): Promise<DevinAccountInfo> {
		const metadata = devinMetadata(token);
		const auth = await this.unary(
			endpoint,
			"/exa.auth_pb.AuthService/GetUserJwt",
			GetUserJwtRequestSchema,
			create(GetUserJwtRequestSchema, { metadata }),
			GetUserJwtResponseSchema,
		);
		if (!auth.userJwt)
			throw new DevinRpcError("data_loss", "Devin returned no user JWT");
		if (auth.customApiServerUrl) {
			const next = validateDevinEndpoint(auth.customApiServerUrl);
			const url = new URL(next);
			if (
				url.origin !== new URL(endpoint).origin &&
				!(
					url.protocol === "https:" &&
					[
						"codeium.com",
						"devin.ai",
						"windsurf.com",
						"cognition.ai",
						"cognition.com",
					].some((d) => url.hostname === d || url.hostname.endsWith(`.${d}`))
				)
			)
				throw new DevinRpcError(
					"permission_denied",
					"Devin returned an untrusted API endpoint",
				);
			endpoint = next;
		}
		const [catalog, status] = await Promise.all([
			this.unary(
				endpoint,
				"/exa.api_server_pb.ApiServerService/GetCliModelConfigs",
				GetCliModelConfigsRequestSchema,
				create(GetCliModelConfigsRequestSchema, {
					metadata: devinMetadata(token, "", true),
				}),
				GetCliModelConfigsResponseSchema,
			),
			this.unary(
				endpoint,
				"/exa.seat_management_pb.SeatManagementService/GetUserStatus",
				GetUserStatusRequestSchema,
				create(GetUserStatusRequestSchema, { metadata }),
				GetUserStatusResponseSchema,
			),
		]);
		return {
			userJwt: auth.userJwt,
			endpoint,
			models: catalog.clientModelConfigs
				.filter(
					(c) =>
						c.modelUid &&
						!c.modelInfo?.isModelRouter &&
						c.modelUid !== "adaptive",
				)
				.map(modelInfo),
			usage: normalizeDevinUsage(status),
		};
	}

	/** Exact catalogue lookup. Nothing here may substitute one model for another. */
	resolveModel(models: DevinModel[], requested: string): DevinModel {
		if (requested === "adaptive")
			throw new DevinRpcError(
				"invalid_argument",
				"Select a concrete Devin model; Adaptive routing is not supported",
			);
		const exact = models.find((m) => m.id === requested);
		if (!exact)
			throw new DevinRpcError(
				"invalid_argument",
				`Unknown Devin model ${requested}; refresh the model list`,
			);
		if (exact.disabled)
			throw new DevinRpcError(
				"permission_denied",
				`Devin model ${requested} is unavailable on this account`,
			);
		return exact;
	}
}
export const devinClient = new DevinClient();
