import type { Config } from "@clankermux/config";
import {
	evaluateBunRuntime,
	getEventLoopStats,
	getPricingGaps,
	MIN_BUN_VERSION,
} from "@clankermux/core";
import type { DatabaseOperations } from "@clankermux/database";
import type {
	EventLoopLagStats,
	IntegrityStatus,
	PricingGap,
	ProviderOverloadStatus,
	SystemStatusResponse,
} from "@clankermux/types";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "../utils/http-error";
import {
	computeHealthStatus,
	computePoolStatus,
	usageCacheResolver,
} from "./health";

type AsyncWriterHealthFn = () => { healthy: boolean };
type IntegrityStatusFn = () => IntegrityStatus;
type EventLoopLagFn = () => EventLoopLagStats;
type PricingGapsFn = () => PricingGap[];
type ProviderOverloadFn = () => ProviderOverloadStatus[];

/**
 * `GET /api/system/status` — live operational snapshot for the dashboard's
 * System Status tile: the same health rollup as `/health`, plus process
 * uptime and current RSS. The rollup is derived from the identical
 * `computePoolStatus`/`computeHealthStatus` helpers so the tile never
 * disagrees with `/health`.
 *
 * Always responds 200 (it's a dashboard info endpoint, not a liveness probe);
 * the `status` field carries ok/degraded/unhealthy.
 *
 * `runtime.pricingGaps` rides along here rather than on `/health` on purpose:
 * `/health` answers 503 for a non-ok status and is consumed by container health
 * checks, and a model missing from the pricing catalogue must never take the
 * proxy out of rotation. It is reported alongside the rollup without feeding it.
 */
/**
 * The optional runtime probes this handler reads. An options object rather
 * than a positional tail: they are all optional and all the same shape, so
 * positionally every new one forces callers to pass `undefined` placeholders
 * past the ones they don't care about, and a mis-ordered argument would type-
 * check silently.
 */
export interface SystemStatusHandlerOptions {
	getAsyncWriterHealth?: AsyncWriterHealthFn;
	getIntegrityStatus?: IntegrityStatusFn;
	getEventLoopLag?: EventLoopLagFn;
	getPricingGaps?: PricingGapsFn;
	getProviderOverload?: ProviderOverloadFn;
}

export function createSystemStatusHandler(
	dbOps: DatabaseOperations,
	config: Config,
	options: SystemStatusHandlerOptions = {},
) {
	const {
		getAsyncWriterHealth,
		getIntegrityStatus,
		getEventLoopLag,
		getPricingGaps: getPricingGapsFn,
		getProviderOverload,
	} = options;
	return async (): Promise<Response> => {
		try {
			const accounts = await dbOps.getAllAccounts();
			const now = Date.now();
			// Use the same usage resolver as `/health` so the System Status tile never
			// disagrees about which accounts are usage-exhausted (an account-wide
			// window spent — a weekly one or the rolling 5-hour session).
			const pool = computePoolStatus(accounts, now, usageCacheResolver);

			const asyncWriterHealthy = getAsyncWriterHealth
				? getAsyncWriterHealth().healthy
				: true;
			const integrityStatus = getIntegrityStatus
				? getIntegrityStatus().status
				: "unchecked";

			const runtimeHealthy = asyncWriterHealthy;
			// Deliberately NOT part of `runtimeHealthy`: a pricing gap degrades
			// costing, not serving, and this rollup is shared with `/health`.
			const pricingGaps = (getPricingGapsFn ?? getPricingGaps)();
			const status = computeHealthStatus(runtimeHealthy, pool);

			const rss = process.memoryUsage.rss();
			const response: SystemStatusResponse = {
				status,
				uptime_s: Math.round(process.uptime()),
				memory: {
					rss_bytes: rss,
					rss_mb: Math.round(rss / 1024 / 1024),
				},
				pool,
				runtime: {
					asyncWriterHealthy,
					integrityStatus,
					pricingGaps,
				},
				// Falls back to the process-wide monitor accessor, which reports
				// zeros when the monitor was never started (e.g. bare handler in
				// tests).
				eventLoop: (getEventLoopLag ?? getEventLoopStats)(),
				// Injected rather than imported. Not a dependency constraint (this
				// package already depends on @clankermux/proxy): the join of breaker
				// buckets with hold-slot occupancy belongs at the server layer, which
				// is the only place that sees both module-level maps, and keeping it
				// out of here leaves the handler testable without a proxy runtime.
				// Absent injection — bare handler in tests — reports no live buckets,
				// which is also the honest steady state.
				providerOverload: getProviderOverload ? getProviderOverload() : [],
				strategy: config.getStrategy(),
				timestamp: new Date().toISOString(),
			};

			return jsonResponse(response);
		} catch (_error) {
			return errorResponse(InternalServerError("Failed to get system status"));
		}
	};
}

export function createSystemInfoHandler() {
	return async (): Promise<Response> => {
		try {
			// Try to detect package manager by checking environment
			let packageManager = "npm"; // default fallback

			// Check if running under bun
			if (process.versions.bun) {
				packageManager = "bun";
			} else if (process.env.npm_config_user_agent?.includes("bun")) {
				packageManager = "bun";
			}

			// Detect if running from binary
			const isBinary = detectRunningFromBinary();

			// Detect if running in Docker
			const isDocker = detectRunningInDocker();

			// `process.versions.bun` alone is misleading: a canary build of X.Y.Z
			// reports the bare "X.Y.Z" (verified 2026-08-23 on the 1.4.0-canary.1
			// binary this proxy is deployed on, whose `bun --revision` prints
			// 1.4.0-canary.1+8326d1bd3). The revision is the only field that
			// separates two builds claiming the same version, and the floor
			// verdict is what the boot guard concluded about this runtime.
			const runtimeCheck = evaluateBunRuntime(process.versions.bun ?? null);

			const systemInfo = {
				packageManager,
				nodeVersion: process.version,
				bunVersion: process.versions.bun || null,
				bunRevision: typeof Bun === "undefined" ? null : Bun.revision || null,
				bunRuntimeFloor: {
					required: MIN_BUN_VERSION,
					verdict: runtimeCheck.verdict,
					detail: runtimeCheck.message,
				},
				platform: process.platform,
				arch: process.arch,
				isBinary,
				isDocker,
				execPath: process.execPath,
				timestamp: new Date().toISOString(),
			};

			return jsonResponse(systemInfo);
		} catch (_error) {
			return errorResponse(
				InternalServerError("Failed to get system information"),
			);
		}
	};
}

/**
 * Detect if the application is running in a Docker container
 */
function detectRunningInDocker(): boolean {
	// Check for Docker-specific indicators
	const dockerIndicators = [
		// Check for .dockerenv file
		() => {
			try {
				const fs = require("node:fs");
				return fs.existsSync("/.dockerenv");
			} catch {
				return false;
			}
		},
		// Check for Docker in cgroup
		() => {
			try {
				const fs = require("node:fs");
				const cgroupContent = fs.readFileSync("/proc/1/cgroup", "utf8");
				return (
					cgroupContent.includes("docker") ||
					cgroupContent.includes("containerd")
				);
			} catch {
				return false;
			}
		},
		// Check for Docker environment variables
		() => {
			return !!(
				process.env.DOCKER_CONTAINER || process.env.KUBERNETES_SERVICE_HOST
			);
		},
		// Check if running in container by checking hostname patterns
		() => {
			const hostname = require("node:os").hostname();
			return /^[a-f0-9]{12}$/.test(hostname) || hostname.includes("docker");
		},
	];

	// Return true if any Docker indicator is detected
	return dockerIndicators.some((check) => {
		try {
			return check();
		} catch {
			return false;
		}
	});
}

/**
 * Detect if the application is running from a pre-compiled binary
 */
function detectRunningFromBinary(): boolean {
	const execPath = process.execPath;

	// Check if execPath looks like a binary installation
	// Binary installations typically have specific patterns:
	// 1. Not in node_modules/.bin
	// 2. Not the node/bun executable itself
	// 3. Has a name that matches our binary pattern

	// If execPath contains 'clankermux' and is not in node_modules, it's likely a binary
	if (execPath.includes("clankermux")) {
		// Check if it's not in node_modules (which would indicate npm/bun installation)
		if (!execPath.includes("node_modules")) {
			return true;
		}
	}

	// Additional check: if execPath is in common binary installation directories
	const commonBinaryPaths = [
		"/usr/local/bin",
		"/usr/bin",
		"/opt/homebrew/bin",
		"\\Program Files\\",
		"\\Program Files (x86)\\",
	];

	for (const binaryPath of commonBinaryPaths) {
		if (execPath.includes(binaryPath)) {
			return true;
		}
	}

	// Check if the execPath is not the node/bun executable itself
	// and doesn't point to a package manager script
	const nodeExecutables = ["node", "bun", "npm", "yarn", "pnpm"];
	const execName = execPath.split(/[\\/]/).pop()?.toLowerCase();

	if (execName && !nodeExecutables.includes(execName)) {
		// If the executable name contains our app name and it's not a package manager
		// it's likely a binary
		if (execName.includes("clankermux")) {
			return true;
		}
	}

	return false;
}
