import {
	codexAccountFitsRequest,
	estimateRequestTokens,
	mapModelName,
	resolveModelContextWindow,
	ServiceUnavailableError,
	trackClientVersion,
} from "@clankermux/core";
import { sanitizeRequestHeaders } from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import { usageCache } from "@clankermux/providers";
import type { Account } from "@clankermux/types";
import { cacheBodyStore } from "./cache-body-store";
import {
	type ContextWindowExcludedBackend,
	createContextWindowExceededResponse,
	createPoolExhaustedResponse,
	createRequestMetadata,
	createUsageThrottledResponse,
	ERROR_MESSAGES,
	getComboSlotInfo,
	getUsageThrottleUntil,
	isRefreshTokenLikelyExpired,
	type ProxyContext,
	prepareRequestBody,
	proxyWithAccount,
	RequestBodyContext,
	type RequestJsonBody,
	selectAccountsForRequest,
	validateProviderPath,
} from "./handlers";
import { sanitizeProjectName } from "./project-name";
import {
	ANTHROPIC_UPSTREAM_OVERLOAD_KEY,
	getProviderOverloadKey,
	getProviderOverloadUntil,
	isProviderOverloaded,
} from "./provider-overload-cooldown";
import { extractRequestAffinity } from "./request-affinity";
import type { RecordMeta, RequestRecorder } from "./request-recorder";
import { hashRoutingAffinityKey } from "./routing-telemetry";
import { shouldRecordRequest } from "./should-record-request";
import { UsageWorkerController } from "./usage-worker-controller";
import type { SummaryMessage } from "./worker-messages";

export type { ProxyContext } from "./handlers";

const log = new Logger("Proxy");

function extractSystemPrompt(body: RequestJsonBody | null): string | null {
	if (!body) return null;
	const system = body.system;

	if (typeof system === "string") {
		return system;
	}

	if (Array.isArray(system)) {
		return system
			.filter(
				(item): item is { type?: string; text: string } =>
					typeof item === "object" &&
					item !== null &&
					(item as { type?: string }).type === "text" &&
					typeof (item as { text?: unknown }).text === "string",
			)
			.map((item) => item.text)
			.join("\n");
	}

	return null;
}

function extractProjectFromRequest(
	method: string,
	path: string,
	headers: Headers,
	body: RequestJsonBody | null,
): string | null {
	if (method !== "POST" || path !== "/v1/messages") return null;

	const headerProject = headers.get("x-project");
	const sanitizedHeader = sanitizeProjectName(headerProject);
	if (sanitizedHeader) return sanitizedHeader;

	const systemPrompt = extractSystemPrompt(body);
	if (!systemPrompt) return null;

	const pathMatch = systemPrompt.match(
		/\/(?:Users|home)\/[^/]+\/(?:(?:Desktop|projects|repos|src)\/)?([^/\s]+)\//,
	);
	const sanitizedPath = sanitizeProjectName(pathMatch?.[1]);
	if (sanitizedPath) return sanitizedPath;

	const headingMatch = systemPrompt.match(/^#\s+([^\n\r]{1,100})/m);
	if (headingMatch) {
		const heading = sanitizeProjectName(headingMatch[1]);
		if (heading && !heading.toLowerCase().startsWith("claude")) {
			return heading;
		}
	}

	return null;
}

// ===== WORKER MANAGEMENT =====

// The UsageWorkerController is module-scoped and constructed before any
// ProxyContext exists, but its onSummary callback must route the worker's slim
// usage summary into the main-thread RequestRecorder (which owns persistence +
// the dashboard "summary" event). Wire the recorder via a module-level setter
// that server.ts calls once it has instantiated the recorder.
let requestRecorder: RequestRecorder | null = null;

export function setRequestRecorder(recorder: RequestRecorder): void {
	requestRecorder = recorder;
}

const usageWorkerController = new UsageWorkerController(
	(msg: SummaryMessage) => {
		// Both fields survive the slim summary shape (S4): cache-body-store needs
		// cacheCreationInputTokens to promote staged bodies; the recorder merges
		// the usage and emits the dashboard "summary" event itself.
		cacheBodyStore.onSummary(
			msg.summary.requestId,
			msg.summary.cacheCreationInputTokens,
		);
		requestRecorder?.attachUsageSummary(msg.summary.requestId, msg.summary);
	},
	() => {
		// Worker ready — no deferred config to apply. The slim worker no longer
		// stores payloads, so the storePayloads ConfigUpdate plumbing is gone
		// (S3); the recorder reads ctx.config.getStorePayloads() live instead.
	},
);

// When the usage worker is destroyed (restart or shutdown), requests whose
// "start" was already handed to that worker will never be summarized — drop
// their staged bodies so they can't leak, and waive usage on the recorder's
// un-summarized records (finished ones persist now; still-streaming ones
// persist at their own transport-finish). Pre-handoff entries are preserved:
// forwardToClient posts their start/end to the replacement worker, which can
// still summarize and promote them. Promoted per-account slots are untouched.
usageWorkerController.onWorkerGone = () => {
	cacheBodyStore.discardHandedOffStaged();
	requestRecorder?.onWorkerGone();
};

export function getUsageWorker(): UsageWorkerController {
	return usageWorkerController;
}

export function startUsageWorker(): void {
	usageWorkerController.start();
}

export function terminateUsageWorker(): Promise<void> {
	return usageWorkerController.terminate();
}

export function getUsageWorkerHealth() {
	return usageWorkerController.getHealth();
}

// ===== MAIN HANDLER =====

/**
 * Main proxy handler - orchestrates the entire proxy flow
 *
 * This function coordinates the proxy process by:
 * 1. Creating request metadata for tracking
 * 2. Validating the provider can handle the path
 * 3. Preparing the request body for reuse
 * 4. Selecting accounts based on load balancing strategy
 * 5. Attempting to proxy with each account in order
 * 6. Falling back to unauthenticated proxy if no accounts available
 *
 * @param req - The incoming request
 * @param url - The parsed URL
 * @param ctx - The proxy context containing strategy, database, and provider
 * @param apiKeyId - Optional API key ID for tracking
 * @param apiKeyName - Optional API key name for tracking
 * @returns Promise resolving to the proxied response
 * @throws {ValidationError} If the provider cannot handle the path
 * @throws {ServiceUnavailableError} If all accounts fail to proxy the request
 * @throws {ProviderError} If unauthenticated proxy fails
 */
export async function handleProxy(
	req: Request,
	url: URL,
	ctx: ProxyContext,
	apiKeyId?: string | null,
	apiKeyName?: string | null,
	isInternal = false,
): Promise<Response> {
	// 0. Silently ignore Claude Code internal endpoints (non-critical, not supported by all providers)
	if (
		url.pathname === "/api/event_logging/batch" ||
		url.pathname === "/api/system/package-manager"
	) {
		return new Response(JSON.stringify({ success: true }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}

	// 1. Track client version from user-agent for use in auto-refresh
	trackClientVersion(req.headers.get("user-agent"));

	// 2. Validate provider can handle path
	validateProviderPath(ctx.provider, url.pathname);

	// 3. Prepare request body
	const { buffer: requestBodyBuffer } = await prepareRequestBody(req);
	const requestBodyContext = new RequestBodyContext(requestBodyBuffer);

	// 3b. Optionally inject 1h TTL into system prompt cache_control blocks
	if (ctx.config.getSystemPromptCacheTtl1h() && requestBodyBuffer) {
		injectSystemCacheTtl(requestBodyContext);
	}

	// Extract model from request body for family detection (used by combo routing)
	// and reuse parsed body for /v1/messages validation (consolidate parses)
	const parsedBody = requestBodyContext.getParsedJson();
	const requestModel = requestBodyContext.getModel();
	const project = extractProjectFromRequest(
		req.method,
		url.pathname,
		req.headers,
		parsedBody,
	);
	const affinity = extractRequestAffinity(req.headers);

	// Conservative token estimate for context-window-aware routing (B1).
	// Computed once; used to gate Codex accounts whose mapped model can't fit
	// the request (B3) and to build the context_window_exceeded error (B4).
	const requestTokenEstimate = estimateRequestTokens(parsedBody);

	// 3a. Validate request body for /v1/messages endpoint
	if (url.pathname === "/v1/messages" && requestBodyBuffer) {
		if (parsedBody) {
			// Reject requests without messages field (e.g., Claude Code internal events)
			if (!parsedBody.messages || !Array.isArray(parsedBody.messages)) {
				log.warn(
					`Rejected invalid request to /v1/messages without messages field`,
					{
						event_type: parsedBody.event_type,
						event_name: (
							parsedBody.event_data as Record<string, unknown> | undefined
						)?.event_name,
					},
				);
				return new Response(
					JSON.stringify({
						type: "error",
						error: {
							type: "invalid_request_error",
							message:
								"messages: Field required for /v1/messages endpoint. Internal events should not be proxied.",
						},
					}),
					{
						status: 400,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
		} else {
			// If we can't parse the body, let it through and let the provider handle it
			log.debug("Could not parse request body for validation");
		}
	}

	const finalBodyBuffer = requestBodyContext.getBuffer();
	const finalCreateBodyStream = () => {
		if (!finalBodyBuffer) return undefined;
		return new Response(finalBodyBuffer).body ?? undefined;
	};

	const effectiveRequestModel = requestBodyContext.getModel() ?? requestModel;

	// 4. Create request metadata
	const requestMeta = createRequestMetadata(req, url);
	requestMeta.internal = isInternal;
	requestMeta.affinityKey = affinity.key;
	requestMeta.affinityScope = affinity.scope;
	requestMeta.affinityPartition = apiKeyId ? `api_key:${apiKeyId}` : null;
	requestMeta.project = project;

	// 5. Select accounts
	const selectedAccounts = await selectAccountsForRequest(
		requestMeta,
		ctx,
		effectiveRequestModel ?? undefined,
	);

	type ProviderOverloadedAccount = { account: Account; until: number };

	const providerOverloadResponseLabel = (overloadKey: string): string =>
		overloadKey === ANTHROPIC_UPSTREAM_OVERLOAD_KEY ? "anthropic" : overloadKey;

	const recordSyntheticErrorResponse = (
		response: Response,
		error: string,
	): void => {
		// Same recordable-request predicate as forwardToClient (S1) — keeps
		// synthetic pool/provider-exhaustion rows out of history for the same
		// filtered set (auto-refresh probes, etc.).
		if (
			!shouldRecordRequest({
				method: req.method,
				path: url.pathname,
				providerName: ctx.provider.name,
				responseStatus: response.status,
				getHeader: (name) => req.headers.get(name),
			})
		) {
			return;
		}

		// Synthetic terminal responses (pool/provider-exhaustion) write a request
		// row directly via the recorder — the slim worker no longer persists, so
		// posting start/end to it would vanish (amendment B1). No body, no usage.
		const meta: RecordMeta = {
			requestId: requestMeta.id,
			method: req.method,
			path: url.pathname,
			accountId: null,
			accountName: null,
			responseStatus: response.status,
			responseHeaders: Object.fromEntries(response.headers.entries()),
			requestHeaders: Object.fromEntries(
				sanitizeRequestHeaders(req.headers).entries(),
			),
			isStream: false,
			providerName: ctx.provider.name,
			accountBillingType: null,
			accountAutoPauseOnOverageEnabled: 0,
			authed: false,
			apiKeyId: apiKeyId || null,
			apiKeyName: apiKeyName || null,
			comboName: null,
			project: project ?? null,
			routing: requestMeta.routing
				? {
						strategy: requestMeta.routing.strategy,
						decision: requestMeta.routing.decision,
						affinityScope: requestMeta.routing.affinityScope ?? null,
						affinityKeyHash: hashRoutingAffinityKey(
							requestMeta.routing.affinityKey,
						),
						selectedAccountId: requestMeta.routing.selectedAccountId ?? null,
						previousAccountId: requestMeta.routing.previousAccountId ?? null,
						candidatesCount: requestMeta.routing.candidatesCount ?? null,
						failoverReason: requestMeta.routing.failoverReason ?? null,
					}
				: null,
			timestamp: requestMeta.timestamp,
			requestBody: null,
			retryAttempt: 0,
			failoverAttempts: 0,
		};
		ctx.requestRecorder.recordSynthetic(meta, "error", error);
	};

	const createProviderOverloadedResponse = (
		overloaded: ProviderOverloadedAccount[],
	): Response => {
		const now = Date.now();
		const nextAvailableAt = Math.min(...overloaded.map(({ until }) => until));
		const retryAfterSeconds = Math.max(
			1,
			Math.ceil((nextAvailableAt - now) / 1000),
		);
		const providers = Array.from(
			new Set(
				overloaded.map(({ account }) =>
					providerOverloadResponseLabel(
						getProviderOverloadKey(account.provider),
					),
				),
			),
		);
		const response = new Response(
			JSON.stringify({
				type: "error",
				error: {
					type: "overloaded_error",
					message: `Provider temporarily overloaded: ${providers.join(", ")}`,
					providers,
					next_available_at: new Date(nextAvailableAt).toISOString(),
				},
			}),
			{
				status: 529,
				headers: {
					"Content-Type": "application/json",
					"Retry-After": String(retryAfterSeconds),
				},
			},
		);
		recordSyntheticErrorResponse(response, "provider_overloaded");
		return response;
	};

	const applyProviderOverloadGate = (accounts: Account[]) => {
		const now = Date.now();
		const available: Account[] = [];
		const overloaded: ProviderOverloadedAccount[] = [];

		for (const account of accounts) {
			const overloadedUntil = getProviderOverloadUntil(account.provider, now);
			if (overloadedUntil) {
				overloaded.push({ account, until: overloadedUntil });
				continue;
			}
			available.push(account);
		}

		if (overloaded.length > 0) {
			const providers = Array.from(
				new Set(
					overloaded.map(
						({ account, until }) =>
							`${getProviderOverloadKey(account.provider)} until ${new Date(until).toISOString()}`,
					),
				),
			);
			log.debug(
				`Provider-overload gate excluded ${overloaded.length} account(s): ${providers.join(", ")}`,
			);
		}

		return { available, overloaded };
	};

	const shouldForwardProviderOverloadIfNoCrossProviderFallback = (
		candidates: Account[],
		index: number,
	): boolean => {
		const current = candidates[index];
		if (
			!current ||
			getProviderOverloadKey(current.provider) !==
				ANTHROPIC_UPSTREAM_OVERLOAD_KEY
		) {
			return false;
		}
		const currentOverloadKey = getProviderOverloadKey(current.provider);
		return !candidates
			.slice(index + 1)
			.some(
				(account) =>
					getProviderOverloadKey(account.provider) !== currentOverloadKey &&
					!isProviderOverloaded(account.provider),
			);
	};

	const {
		available: providerAvailableAccounts,
		overloaded: providerOverloadedAccounts,
	} = applyProviderOverloadGate(selectedAccounts);

	const applyUsageThrottling = (accounts: Account[]) => {
		const settings = {
			fiveHourEnabled: ctx.config.getUsageThrottlingFiveHourEnabled(),
			weeklyEnabled: ctx.config.getUsageThrottlingWeeklyEnabled(),
		};
		if (!settings.fiveHourEnabled && !settings.weeklyEnabled) {
			return { available: accounts, throttled: [] as Account[] };
		}

		const now = Date.now();
		const available: Account[] = [];
		const throttled: Account[] = [];

		for (const account of accounts) {
			const throttleUntil = getUsageThrottleUntil(
				usageCache.get(account.id),
				settings,
				now,
			);
			if (throttleUntil && throttleUntil > now) {
				throttled.push(account);
				continue;
			}
			available.push(account);
		}

		if (throttled.length > 0) {
			log.info(
				`Usage-throttled ${throttled.length} account(s): ${throttled.map((account) => account.name).join(", ")}`,
			);
		}

		return { available, throttled };
	};

	const { available: postThrottleAccounts, throttled: throttledAccounts } =
		applyUsageThrottling(providerAvailableAccounts);

	// 6b. Context-window gate — exclude Codex accounts whose mapped model
	// can't fit the request (B3). Non-codex accounts always pass. When a combo
	// slot is active for the account, the gate evaluates against the slot's
	// model override instead of the request's family model (review C3). Force-
	// routed requests are gated too — force-route bypasses account *selection*,
	// not the size safety check.
	const contextExcludedAccounts: ContextWindowExcludedBackend[] = [];

	/**
	 * Apply context-window gate to a list of accounts.
	 * @param candidates Candidate accounts to filter
	 * @param comboInfo  Optional combo slot info for model override lookup
	 * @returns Accounts that pass the gate
	 */
	const applyContextWindowGate = (
		candidates: Account[],
		comboInfo?: {
			slots: Array<{ accountId: string; modelOverride: string }>;
		} | null,
	): Account[] => {
		const passed: Account[] = [];
		for (const account of candidates) {
			if (account.provider !== "codex") {
				passed.push(account);
				continue;
			}

			// Determine the effective model for this account: combo slot
			// override if available, otherwise the request model.
			let modelForGate =
				effectiveRequestModel ??
				"claude-sonnet-4-5"; /* safe fallback — family match */
			if (comboInfo) {
				const slot = comboInfo.slots.find((s) => s.accountId === account.id);
				if (slot?.modelOverride) {
					modelForGate = slot.modelOverride;
				}
			}

			if (
				!codexAccountFitsRequest(account, modelForGate, requestTokenEstimate)
			) {
				const target = mapModelName(modelForGate, account);
				const window = resolveModelContextWindow(target);
				log.info(
					`Context-window gate: excluding Codex account "${account.name}" ` +
						`(model=${modelForGate}, target=${target}, window=${window ?? "unknown"}, ` +
						`estimate=${requestTokenEstimate})`,
				);
				// Track for error-response purposes (deduplicate by id)
				if (
					!contextExcludedAccounts.some(
						(excluded) => excluded.account.id === account.id,
					)
				) {
					contextExcludedAccounts.push({ account, model: modelForGate });
				}
				continue;
			}
			passed.push(account);
		}
		return passed;
	};

	// Combo slot info (if any) is populated by selectAccountsForRequest above,
	// so it's available to the gate for combo-aware model override evaluation.
	const initialComboInfo = getComboSlotInfo(requestMeta);
	const accounts = applyContextWindowGate(
		postThrottleAccounts,
		initialComboInfo,
	);
	if (requestMeta.routing) {
		requestMeta.routing.selectedAccountId =
			accounts[0]?.id ?? requestMeta.routing.selectedAccountId ?? null;
		requestMeta.routing.candidatesCount = accounts.length;
	}

	// 7. Handle no accounts case
	if (accounts.length === 0) {
		// If the pool was emptied specifically by the context-window gate
		// (and there were Codex accounts that would have been available
		// otherwise), return a 400 context_window_exceeded instead of 503.
		if (contextExcludedAccounts.length > 0 && throttledAccounts.length === 0) {
			return createContextWindowExceededResponse(
				requestTokenEstimate,
				contextExcludedAccounts,
				effectiveRequestModel ?? "unknown",
			);
		}

		if (throttledAccounts.length > 0) {
			return createUsageThrottledResponse(throttledAccounts);
		}

		if (
			selectedAccounts.length > 0 &&
			providerAvailableAccounts.length === 0 &&
			providerOverloadedAccounts.length > 0
		) {
			return createProviderOverloadedResponse(providerOverloadedAccounts);
		}

		log.error(ERROR_MESSAGES.POOL_EXHAUSTED);

		// Log to request history via worker
		// Re-fetch from DB — selectedAccounts is empty here (strategy already
		// filtered out unavailable accounts), so we need fresh data to populate
		// per-account cooldown info in the 503 body.
		const allAccounts = (await ctx.dbOps.getAllAccounts()).filter(
			(a) => a.provider === ctx.provider.name,
		);

		const poolExhaustedResponse = createPoolExhaustedResponse(allAccounts);

		// Skip request-history logging for synthetic auto-refresh probes that
		// 503 because their target account is on a known cooldown. Logging
		// these as user-facing 503s inflates the dashboard fail-rate without
		// reflecting any real client impact (issue #199, bug 2). The keepalive
		// scheduler already gets the equivalent treatment via its loop-prevention
		// header path; this brings auto-refresh in line.
		recordSyntheticErrorResponse(poolExhaustedResponse, "pool_exhausted");

		return poolExhaustedResponse;
	}

	// 8. Log selected accounts
	log.info(
		`Selected ${accounts.length} accounts: ${accounts.map((a) => a.name).join(", ")}`,
	);
	if (
		process.env.DEBUG?.includes("proxy") ||
		process.env.DEBUG === "true" ||
		process.env.NODE_ENV === "development"
	) {
		log.info(`Request: ${req.method} ${url.pathname}`);
	}

	// 9. Try each account
	const comboInfo = getComboSlotInfo(requestMeta);
	const allowedAccountIds = new Set(accounts.map((account) => account.id));
	const filteredComboInfo = comboInfo
		? {
				...comboInfo,
				slots: comboInfo.slots.filter((slot) =>
					allowedAccountIds.has(slot.accountId),
				),
			}
		: null;
	let response: Response | null = null;

	for (let i = 0; i < accounts.length; i++) {
		const overloadedUntil = getProviderOverloadUntil(accounts[i].provider);
		if (overloadedUntil) {
			log.debug(
				`Skipping account ${accounts[i].name}; provider ${accounts[i].provider} is overloaded until ${new Date(overloadedUntil).toISOString()}`,
			);
			continue;
		}

		// For combo routing: enrich metadata with slot index and look up model override
		let modelOverride: string | null = null;
		if (filteredComboInfo?.slots[i]) {
			const slot = filteredComboInfo.slots[i];
			if (slot.accountId !== accounts[i].id) {
				log.error(
					`Combo slot/account desync: slot ${i} expects account ${slot.accountId} but got ${accounts[i].id}`,
				);
			} else {
				modelOverride = slot.modelOverride;
			}
			requestMeta.comboSlotIndex = i;
			log.info(
				`Attempting combo slot ${i}/${accounts.length - 1} on account ${accounts[i].name} with model "${modelOverride}"`,
			);
		}

		response = await proxyWithAccount(
			req,
			url,
			accounts[i],
			requestMeta,
			finalBodyBuffer,
			finalCreateBodyStream,
			i,
			ctx,
			modelOverride,
			apiKeyId,
			apiKeyName,
			requestBodyContext,
			!filteredComboInfo?.comboName &&
				(i === accounts.length - 1 ||
					shouldForwardProviderOverloadIfNoCrossProviderFallback(accounts, i)),
		);

		if (response) {
			return response;
		}

		// Log combo slot failure
		if (filteredComboInfo) {
			log.info(
				`Combo slot ${i} failed on account ${accounts[i].name}${i < accounts.length - 1 ? ", trying next slot" : ", all combo slots exhausted"}`,
			);
		}
	}

	// 10. Combo fallback: if combo routing was active and all slots failed,
	//     fall back to normal SessionStrategy routing (REQ-14)
	let fallbackAccounts: Account[] | null = null;
	if (filteredComboInfo?.comboName) {
		log.warn(
			`All combo slots failed for combo "${filteredComboInfo.comboName}", falling back to SessionStrategy routing`,
		);
		// Clear combo info and retry with normal routing
		requestMeta.comboName = null;
		requestMeta.comboSlotIndex = null;
		const selectedFallbackAccounts = await selectAccountsForRequest(
			requestMeta,
			ctx,
		);
		const {
			available: providerFallbackAccounts,
			overloaded: providerFallbackOverloadedAccounts,
		} = applyProviderOverloadGate(selectedFallbackAccounts);
		const {
			available: filteredFallbackAccounts,
			throttled: throttledFallbackAccounts,
		} = applyUsageThrottling(providerFallbackAccounts);
		fallbackAccounts = applyContextWindowGate(filteredFallbackAccounts);
		if (requestMeta.routing) {
			requestMeta.routing.selectedAccountId =
				fallbackAccounts[0]?.id ??
				requestMeta.routing.selectedAccountId ??
				null;
			requestMeta.routing.candidatesCount = fallbackAccounts.length;
			requestMeta.routing.failoverReason = "combo_fallback";
		}

		if (fallbackAccounts.length > 0) {
			log.info(
				`Fallback: trying ${fallbackAccounts.length} SessionStrategy accounts`,
			);
			for (let i = 0; i < fallbackAccounts.length; i++) {
				const overloadedUntil = getProviderOverloadUntil(
					fallbackAccounts[i].provider,
				);
				if (overloadedUntil) {
					log.debug(
						`Skipping fallback account ${fallbackAccounts[i].name}; provider ${fallbackAccounts[i].provider} is overloaded until ${new Date(overloadedUntil).toISOString()}`,
					);
					continue;
				}

				response = await proxyWithAccount(
					req,
					url,
					fallbackAccounts[i],
					requestMeta,
					finalBodyBuffer,
					finalCreateBodyStream,
					i,
					ctx,
					undefined, // No model override for fallback path
					apiKeyId,
					apiKeyName,
					requestBodyContext,
					i === fallbackAccounts.length - 1 ||
						shouldForwardProviderOverloadIfNoCrossProviderFallback(
							fallbackAccounts,
							i,
						),
				);

				if (response) {
					return response;
				}
			}
		} else if (throttledFallbackAccounts.length > 0) {
			// Combo slots staged a body but all failed, and the fallback found only
			// throttled accounts — this terminal return emits no worker summary, so
			// drop the staged body now (mirrors the all-accounts-failed cleanup).
			cacheBodyStore.discardStaged(requestMeta.id);
			return createUsageThrottledResponse(throttledFallbackAccounts);
		} else if (
			selectedFallbackAccounts.length > 0 &&
			providerFallbackAccounts.length === 0 &&
			providerFallbackOverloadedAccounts.length > 0
		) {
			cacheBodyStore.discardStaged(requestMeta.id);
			return createProviderOverloadedResponse(
				providerFallbackOverloadedAccounts,
			);
		}
	}

	// 11. All accounts failed. This request was staged for cache-keepalive in
	// proxyWithAccount, but no worker "end"/summary is emitted on this throw
	// path — drop its staged body now instead of waiting for the age sweep.
	cacheBodyStore.discardStaged(requestMeta.id);

	// Check if OAuth token issues are the cause
	const allAttemptedAccounts = filteredComboInfo
		? [...accounts, ...(fallbackAccounts ?? [])]
		: accounts;
	const oauthAccounts = allAttemptedAccounts.filter((acc) => acc.refresh_token);
	const needsReauth = oauthAccounts.filter((acc) =>
		isRefreshTokenLikelyExpired(acc),
	);

	if (needsReauth.length > 0) {
		// Quote account names to prevent command injection (defense-in-depth)
		const reauthCommands = needsReauth
			.map(
				(acc) =>
					`bun run cli --reauthenticate "${acc.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
			)
			.join("\n  ");
		throw new ServiceUnavailableError(
			`All accounts failed to proxy the request. OAuth tokens have expired for accounts: ${needsReauth.map((acc) => acc.name).join(", ")}.\n\nPlease re-authenticate:\n  ${reauthCommands}`,
			ctx.provider.name,
		);
	}

	throw new ServiceUnavailableError(
		`${ERROR_MESSAGES.ALL_ACCOUNTS_FAILED} (${allAttemptedAccounts.length} attempted)`,
		ctx.provider.name,
	);
}

/**
 * Injects `ttl: "1h"` into system-level cache_control blocks that are missing a TTL.
 * ArrayBuffer overload: returns modified buffer or null (no changes).
 * RequestBodyContext overload: mutates in-place via markDirty(); return value unused.
 */
export function injectSystemCacheTtl(buf: ArrayBuffer): ArrayBuffer | null;
export function injectSystemCacheTtl(context: RequestBodyContext): void;
export function injectSystemCacheTtl(
	input: ArrayBuffer | RequestBodyContext,
): ArrayBuffer | null {
	const bodyContext =
		input instanceof RequestBodyContext ? input : new RequestBodyContext(input);
	try {
		const body = bodyContext.getParsedJson() as
			| (RequestJsonBody & {
					system?: Array<{ cache_control?: { type?: string; ttl?: string } }>;
			  })
			| null;
		if (!body) return null;
		if (!Array.isArray(body.system)) return null;
		const blocksToUpdate = body.system.filter(
			(block) =>
				block.cache_control?.type === "ephemeral" && !block.cache_control.ttl,
		);
		if (blocksToUpdate.length === 0) return null;
		bodyContext.mutateParsedJson((b) => {
			const typedBody = b as RequestJsonBody & {
				system: Array<{ cache_control?: { type?: string; ttl?: string } }>;
			};
			for (const block of typedBody.system) {
				if (
					block.cache_control?.type === "ephemeral" &&
					!block.cache_control.ttl
				) {
					block.cache_control.ttl = "1h";
				}
			}
		});
		return bodyContext.getBuffer();
	} catch {
		return null;
	}
}
