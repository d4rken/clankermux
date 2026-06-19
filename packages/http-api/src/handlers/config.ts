import type { Config } from "@clankermux/config";
import {
	NETWORK,
	STRATEGIES,
	type StrategyName,
	TIME_CONSTANTS,
	validateNumber,
	validateString,
} from "@clankermux/core";
import {
	BadRequest,
	errorResponse,
	jsonResponse,
} from "@clankermux/http-common";
import {
	BRIDGE_HOURS_PER_RISK_UNIT,
	bridgeHoursToRiskFactor,
	clampBridgeHours,
	clampRiskFactor,
	KEEPALIVE_REFRESH_1H_MS,
	MAX_BRIDGE_HOURS,
	riskFactorToBridgeHours,
} from "@clankermux/proxy";
import type { ConfigResponse, RetentionSetRequest } from "../types";

/** The bridge horizon (hours/risk factor) only describes the promoted 1h-TTL slots.
 * The conversion + clamps live in @clankermux/proxy (bridge-policy) — the single
 * source of truth — and are surfaced to the dashboard so the UI never hardcodes them. */
function cacheWarmingResponse(config: Config): Record<string, unknown> {
	const riskFactor = config.getCacheWarmingRiskFactor();
	return {
		mode: config.getCacheWarmingMode(),
		minTokens: config.getCacheWarmingMinTokens(),
		enabled: config.getCacheWarmingEnabled(),
		riskFactor,
		bridgeHours: riskFactorToBridgeHours(riskFactor),
		maxBridgeHours: MAX_BRIDGE_HOURS,
		hoursPerRiskUnit: BRIDGE_HOURS_PER_RISK_UNIT,
		refreshMinutes: KEEPALIVE_REFRESH_1H_MS / 60_000,
	};
}

/**
 * Create config handlers
 */
export function createConfigHandlers(
	config: Config,
	runtime?: { port: number; tlsEnabled: boolean },
) {
	return {
		/**
		 * Get all configuration settings
		 */
		getConfig: (): Response => {
			const settings = config.getAllSettings();
			const response: ConfigResponse = {
				lb_strategy: (settings.lb_strategy as string) || "round_robin",
				// Use actual running port from runtime, fall back to config
				port:
					runtime?.port || (settings.port as number) || NETWORK.DEFAULT_PORT,
				// Use Anthropic fallback as default since it's the only provider that uses session duration tracking
				// Non-Anthropic providers don't use fixed-duration sessions but still need a default value
				sessionDurationMs:
					(settings.sessionDurationMs as number) ||
					TIME_CONSTANTS.ANTHROPIC_SESSION_DURATION_FALLBACK,
				// Include actual TLS status
				tls_enabled: runtime?.tlsEnabled || false,
				usage_throttling_five_hour_enabled:
					config.getUsageThrottlingFiveHourEnabled(),
				usage_throttling_weekly_enabled:
					config.getUsageThrottlingWeeklyEnabled(),
			};
			return jsonResponse(response);
		},

		/**
		 * Get current strategy
		 */
		getStrategy: (): Response => {
			const strategy = config.getStrategy();
			return jsonResponse({ strategy });
		},

		/**
		 * Update strategy
		 */
		setStrategy: async (req: Request): Promise<Response> => {
			const body = await req.json();

			// Validate strategy input
			const strategyValidation = validateString(body.strategy, "strategy", {
				required: true,
				allowedValues: STRATEGIES,
			});

			if (!strategyValidation) {
				return errorResponse(BadRequest("Strategy is required"));
			}

			const strategy = strategyValidation as StrategyName;
			config.setStrategy(strategy);

			return jsonResponse({ success: true, strategy });
		},

		/**
		 * Get available strategies
		 */
		getStrategies: (): Response => {
			return jsonResponse(STRATEGIES);
		},

		/**
		 * Get current data retention in days
		 */
		getRetention: (): Response => {
			return jsonResponse({
				payloadDays: config.getDataRetentionDays(),
				requestDays: config.getRequestRetentionDays(),
				usageSnapshotDays: config.getUsageSnapshotRetentionDays(),
				memorySnapshotDays: config.getMemorySnapshotRetentionDays(),
				cacheKeepaliveSnapshotDays:
					config.getCacheKeepaliveSnapshotRetentionDays(),
				storePayloads: config.getStorePayloads(),
			});
		},

		/**
		 * Set data retention in days
		 */
		setRetention: async (req: Request): Promise<Response> => {
			const body = (await req.json()) as RetentionSetRequest;
			let updated = false;
			if (body.payloadDays !== undefined) {
				const payloadDays = validateNumber(body.payloadDays, "payloadDays", {
					min: 1,
					max: 365,
					integer: true,
				});
				if (typeof payloadDays !== "number") {
					return errorResponse(BadRequest("Invalid 'payloadDays'"));
				}
				config.setDataRetentionDays(payloadDays);
				updated = true;
			}
			if (body.requestDays !== undefined) {
				const requestDays = validateNumber(body.requestDays, "requestDays", {
					min: 1,
					max: 3650,
					integer: true,
				});
				if (typeof requestDays !== "number") {
					return errorResponse(BadRequest("Invalid 'requestDays'"));
				}
				config.setRequestRetentionDays(requestDays);
				updated = true;
			}
			if (body.usageSnapshotDays !== undefined) {
				const usageSnapshotDays = validateNumber(
					body.usageSnapshotDays,
					"usageSnapshotDays",
					{
						min: 1,
						max: 3650,
						integer: true,
					},
				);
				if (typeof usageSnapshotDays !== "number") {
					return errorResponse(BadRequest("Invalid 'usageSnapshotDays'"));
				}
				config.setUsageSnapshotRetentionDays(usageSnapshotDays);
				updated = true;
			}
			if (body.memorySnapshotDays !== undefined) {
				const memorySnapshotDays = validateNumber(
					body.memorySnapshotDays,
					"memorySnapshotDays",
					{
						min: 1,
						max: 3650,
						integer: true,
					},
				);
				if (typeof memorySnapshotDays !== "number") {
					return errorResponse(BadRequest("Invalid 'memorySnapshotDays'"));
				}
				config.setMemorySnapshotRetentionDays(memorySnapshotDays);
				updated = true;
			}
			if (body.cacheKeepaliveSnapshotDays !== undefined) {
				const cacheKeepaliveSnapshotDays = validateNumber(
					body.cacheKeepaliveSnapshotDays,
					"cacheKeepaliveSnapshotDays",
					{
						min: 1,
						max: 3650,
						integer: true,
					},
				);
				if (typeof cacheKeepaliveSnapshotDays !== "number") {
					return errorResponse(
						BadRequest("Invalid 'cacheKeepaliveSnapshotDays'"),
					);
				}
				config.setCacheKeepaliveSnapshotRetentionDays(
					cacheKeepaliveSnapshotDays,
				);
				updated = true;
			}
			if (body.storePayloads !== undefined) {
				if (typeof body.storePayloads !== "boolean") {
					return errorResponse(
						BadRequest("Invalid 'storePayloads': must be boolean"),
					);
				}
				config.setStorePayloads(body.storePayloads);
				updated = true;
			}
			if (!updated) {
				return errorResponse(BadRequest("No retention fields provided"));
			}
			return new Response(null, { status: 204 });
		},

		getCacheWarming: (): Response => {
			return jsonResponse(cacheWarmingResponse(config));
		},

		setCacheWarming: async (req: Request): Promise<Response> => {
			const body = await req.json();
			if (body.mode !== undefined) {
				if (
					body.mode !== "off" &&
					body.mode !== "static" &&
					body.mode !== "dynamic"
				) {
					return errorResponse(
						BadRequest("Invalid 'mode': must be off|static|dynamic"),
					);
				}
				config.setCacheWarmingMode(body.mode);
			} else if (body.enabled !== undefined) {
				// Legacy boolean toggle (maps to dynamic/off in config).
				if (typeof body.enabled !== "boolean") {
					return errorResponse(
						BadRequest("Invalid 'enabled': must be boolean"),
					);
				}
				config.setCacheWarmingEnabled(body.enabled);
			}
			if (body.minTokens !== undefined) {
				const minTokens = validateNumber(body.minTokens, "minTokens", {
					min: 0,
					integer: true,
				});
				if (typeof minTokens !== "number") {
					return errorResponse(
						BadRequest("Invalid 'minTokens': must be a number >= 0"),
					);
				}
				config.setCacheWarmingMinTokens(minTokens);
			}
			// Bridge horizon: accept `bridgeHours` (user units, preferred) OR the raw
			// `riskFactor`. We type-validate only (a non-numeric value is a 400) and then
			// CLAMP out-of-range numbers via the bridge-policy helpers rather than
			// rejecting them — the conversion + bounds are owned by bridge-policy. Clamp
			// (not reject) also avoids any partial-update hazard from a late throw after
			// mode/minTokens were already applied above.
			if (body.bridgeHours !== undefined) {
				const hours = validateNumber(body.bridgeHours, "bridgeHours");
				if (typeof hours !== "number") {
					return errorResponse(
						BadRequest("Invalid 'bridgeHours': must be a number"),
					);
				}
				config.setCacheWarmingRiskFactor(
					bridgeHoursToRiskFactor(clampBridgeHours(hours)),
				);
			} else if (body.riskFactor !== undefined) {
				const rf = validateNumber(body.riskFactor, "riskFactor");
				if (typeof rf !== "number") {
					return errorResponse(
						BadRequest("Invalid 'riskFactor': must be a number"),
					);
				}
				config.setCacheWarmingRiskFactor(clampRiskFactor(rf));
			}
			return jsonResponse(cacheWarmingResponse(config));
		},

		getUsageThrottling: (): Response => {
			return jsonResponse({
				fiveHourEnabled: config.getUsageThrottlingFiveHourEnabled(),
				weeklyEnabled: config.getUsageThrottlingWeeklyEnabled(),
			});
		},

		setUsageThrottling: async (req: Request): Promise<Response> => {
			const body = await req.json();
			if (
				typeof body.fiveHourEnabled !== "boolean" ||
				typeof body.weeklyEnabled !== "boolean"
			) {
				return errorResponse(
					BadRequest(
						"Invalid usage throttling payload: expected boolean 'fiveHourEnabled' and 'weeklyEnabled'",
					),
				);
			}
			config.setUsageThrottlingFiveHourEnabled(body.fiveHourEnabled);
			config.setUsageThrottlingWeeklyEnabled(body.weeklyEnabled);
			return new Response(null, { status: 204 });
		},
	};
}
