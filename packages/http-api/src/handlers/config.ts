import type { Config } from "@clankermux/config";
import {
	MODEL_SUBSTITUTION_SUPPRESSION_REASON,
	validateNumber,
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
	unmatchedPathTracker,
} from "@clankermux/proxy";
import {
	DEFAULT_PROJECT_ROOTS,
	parseModelSubstitutionException,
} from "@clankermux/types";
import type {
	ProjectRulesGetResponse,
	RetentionGetResponse,
	RetentionSetRequest,
} from "../types";
import { validateProjectRulesPayload } from "./project-rules-validation";

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
	_runtime?: { port: number; tlsEnabled: boolean },
	/**
	 * Only the substitution-mode setter needs it, to release the suppressions
	 * enforcement wrote. Optional so the existing positional callers and every
	 * test that constructs these handlers are unaffected.
	 */
	routing?: {
		clearModelSuppressionsByReason: (reason: string) => Promise<void>;
	},
) {
	return {
		/**
		 * Get current data retention windows (payloads in hours, the rest in days)
		 */
		getRetention: (): Response => {
			return jsonResponse({
				payloadHours: config.getPayloadRetentionHours(),
				payloadMaxMb: config.getPayloadMaxMb(),
				requestDays: config.getRequestRetentionDays(),
				headerDays: config.getHeaderRetentionDays(),
				usageSnapshotDays: config.getUsageSnapshotRetentionDays(),
				memorySnapshotDays: config.getMemorySnapshotRetentionDays(),
				cacheKeepaliveSnapshotDays:
					config.getCacheKeepaliveSnapshotRetentionDays(),
				storePayloads: config.getStorePayloads(),
				storeHeaders: config.getStoreHeaders(),
			} satisfies RetentionGetResponse);
		},

		/**
		 * Set data retention windows (payloads in hours, the rest in days)
		 */
		setRetention: async (req: Request): Promise<Response> => {
			const body = (await req.json()) as RetentionSetRequest;
			let updated = false;
			if (body.payloadHours !== undefined) {
				const payloadHours = validateNumber(body.payloadHours, "payloadHours", {
					min: 1,
					max: 8760,
					integer: true,
				});
				if (typeof payloadHours !== "number") {
					return errorResponse(BadRequest("Invalid 'payloadHours'"));
				}
				config.setPayloadRetentionHours(payloadHours);
				updated = true;
			}
			if (body.payloadMaxMb !== undefined) {
				// 0 is a valid value here (it disables the budget), unlike the
				// retention windows whose minimum is 1.
				const payloadMaxMb = validateNumber(body.payloadMaxMb, "payloadMaxMb", {
					min: 0,
					max: 1_048_576,
					integer: true,
				});
				if (typeof payloadMaxMb !== "number") {
					return errorResponse(BadRequest("Invalid 'payloadMaxMb'"));
				}
				config.setPayloadMaxMb(payloadMaxMb);
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
			if (body.headerDays !== undefined) {
				const headerDays = validateNumber(body.headerDays, "headerDays", {
					min: 1,
					max: 3650,
					integer: true,
				});
				if (typeof headerDays !== "number") {
					return errorResponse(BadRequest("Invalid 'headerDays'"));
				}
				config.setHeaderRetentionDays(headerDays);
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
			if (body.storeHeaders !== undefined) {
				if (typeof body.storeHeaders !== "boolean") {
					return errorResponse(
						BadRequest("Invalid 'storeHeaders': must be boolean"),
					);
				}
				config.setStoreHeaders(body.storeHeaders);
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

		getServedModelSubstitutionMode: (): Response =>
			jsonResponse({
				servedModelSubstitutionMode: config.getServedModelSubstitutionMode(),
				servedModelSubstitutionExceptions:
					config.getServedModelSubstitutionExceptions(),
			}),

		setServedModelSubstitutionMode: async (req: Request): Promise<Response> => {
			const body = await req.json();
			// The exception list travels with the mode because it only means
			// anything relative to it: "accepted" is a statement about what
			// enforcement skips.
			//
			// Both fields are validated before either is written. A body carrying a
			// good list and a bad mode would otherwise persist the list and answer
			// 400, leaving the operator's next read disagreeing with the error they
			// were just shown.
			const wantsExceptions = body.exceptions !== undefined;
			if (wantsExceptions) {
				if (
					!Array.isArray(body.exceptions) ||
					body.exceptions.some((entry: unknown) => typeof entry !== "string")
				) {
					return errorResponse(
						BadRequest("Invalid 'exceptions': must be an array of strings"),
					);
				}
				// Reject rather than silently drop: an operator who typed a rule
				// that does nothing would otherwise see it vanish with no reason
				// given, and conclude the feature is broken.
				const invalid = (body.exceptions as string[]).filter(
					(entry) =>
						entry.trim().length > 0 &&
						parseModelSubstitutionException(entry) === null,
				);
				if (invalid.length > 0) {
					return errorResponse(
						BadRequest(
							`Invalid exception${invalid.length > 1 ? "s" : ""}: ${invalid.join(", ")}. Use "sent>served"; "*" matches any model on one side, not both.`,
						),
					);
				}
			}
			// A list-only edit leaves the mode alone; anything else must name a
			// valid one.
			const wantsMode = body.mode !== undefined || !wantsExceptions;
			if (
				wantsMode &&
				body.mode !== "off" &&
				body.mode !== "observe" &&
				body.mode !== "enforce"
			) {
				return errorResponse(
					BadRequest("Invalid 'mode': must be off|observe|enforce"),
				);
			}

			// Either edit can invalidate a suppression enforcement already wrote:
			// turning the mode down, or accepting the very swap that caused it.
			// The suppression gates are unconditional, so without this the account
			// stays out of rotation for the rest of its five-minute window and the
			// setting reads as having done nothing — or worse, the operator sees
			// the swap marked accepted while requests still fail over around it.
			//
			// Every substitution suppression goes, not only the newly-accepted
			// pair: identifying "the rows this exception covers" would need the
			// proxy's model normalisation down in the repository, and a pair that
			// is still offending re-suppresses on its next request anyway. The
			// cost of over-clearing is one extra upstream attempt.
			let releaseSuppressions = false;
			if (wantsExceptions) {
				// Compared across the write, so both sides are the stored form. The
				// setter trims, lowercases and dedupes, and re-deriving that here
				// would make a cosmetic edit look like a real one.
				const before = config.getServedModelSubstitutionExceptions().join("\n");
				config.setServedModelSubstitutionExceptions(body.exceptions);
				releaseSuppressions =
					config.getServedModelSubstitutionExceptions().join("\n") !== before;
			}
			if (wantsMode) {
				config.setServedModelSubstitutionMode(body.mode);
				if (body.mode !== "enforce") releaseSuppressions = true;
			}
			if (releaseSuppressions)
				await routing?.clearModelSuppressionsByReason(
					MODEL_SUBSTITUTION_SUPPRESSION_REASON,
				);
			return jsonResponse({
				servedModelSubstitutionMode: config.getServedModelSubstitutionMode(),
				servedModelSubstitutionExceptions:
					config.getServedModelSubstitutionExceptions(),
			});
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

		getProjectRules: (): Response => {
			const rules = config.getProjectRules();
			return jsonResponse({
				roots: rules.roots,
				overrides: rules.overrides,
				defaultRoots: [...DEFAULT_PROJECT_ROOTS],
				unmatched: unmatchedPathTracker.list(),
			} satisfies ProjectRulesGetResponse);
		},

		setProjectRules: async (req: Request): Promise<Response> => {
			const body = await req.json();

			// Validate BOTH lists before writing either. The retention handler's
			// per-field chain applies earlier fields before a later one throws,
			// which for a rule set would leave attribution running on half the
			// operator's intent.
			const validated = validateProjectRulesPayload(body);
			if ("error" in validated)
				return errorResponse(BadRequest(validated.error));

			config.setProjectRules(validated.rules);
			// A path that matched nothing under the old rules may match under the
			// new ones, so the complaint list is stale the moment they change.
			unmatchedPathTracker.clear();
			return new Response(null, { status: 204 });
		},
	};
}
