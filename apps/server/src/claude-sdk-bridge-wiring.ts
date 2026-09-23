import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ClaudeSdkBridge,
	ClaudeSdkBridgeDeps,
	SdkBridgeLimits,
	SdkBridgeTurnRepo,
} from "@clankermux/claude-sdk-bridge";
import type { Config } from "@clankermux/config";
import { Logger } from "@clankermux/logger";
import { dispatchProxyRequest, type ProxyContext } from "@clankermux/proxy";
import {
	type SdkBridgeAvailability,
	type SdkBridgeStatus,
	type SdkBridgeTransport,
	SdkBridgeUnavailableError,
	setSdkBridgeInnerRequestContext,
} from "@clankermux/types";

const log = new Logger("ClaudeSdkBridgeWiring");

type BridgeModule = typeof import("@clankermux/claude-sdk-bridge");

export type SdkBridgeLimitConfig = Pick<
	Config,
	| "getSdkBridgeMaxProcesses"
	| "getSdkBridgeParkedTimeoutMs"
	| "getSdkBridgeTurnDeadlineMs"
	| "getSdkBridgeMaxHistoryBytes"
	| "getSdkBridgeMaxTools"
	| "getSdkBridgeMaxSchemaBytes"
	| "getSdkBridgeMaxParkedCallsPerTurn"
	| "getSdkBridgeMaxConcurrentRebuilds"
>;

/**
 * Where Claude Code's HOME, config dir, TMPDIR, cwd and session files live.
 * Under the cache directory because the systemd unit's ReadWritePaths covers
 * ~/.cache.
 */
export function sdkBridgeWorkRoot(
	env: Record<string, string | undefined> = process.env,
): string {
	const cacheHome = env.XDG_CACHE_HOME || join(homedir(), ".cache");
	return join(cacheHome, "clankermux", "claude-agent-sdk");
}

/** Read live, per turn, so an edited config applies without a restart. */
export function sdkBridgeLimitsFromConfig(
	config: SdkBridgeLimitConfig,
): SdkBridgeLimits {
	return {
		maxProcesses: config.getSdkBridgeMaxProcesses(),
		parkedTimeoutMs: config.getSdkBridgeParkedTimeoutMs(),
		turnDeadlineMs: config.getSdkBridgeTurnDeadlineMs(),
		maxHistoryBytes: config.getSdkBridgeMaxHistoryBytes(),
		maxTools: config.getSdkBridgeMaxTools(),
		maxSchemaBytes: config.getSdkBridgeMaxSchemaBytes(),
		maxParkedCallsPerTurn: config.getSdkBridgeMaxParkedCallsPerTurn(),
		maxConcurrentRebuilds: config.getSdkBridgeMaxConcurrentRebuilds(),
	};
}

export interface SdkBridgeWiring {
	readonly transport: SdkBridgeTransport;
	status(): SdkBridgeStatus;
	/** Refuse new turns and end parked ones. Idempotent. */
	beginShutdown(): void;
	/** End every turn and every Claude Code process. Idempotent. */
	dispose(): Promise<void>;
}

/**
 * The transport that stands in when the bridge package itself cannot load
 * (the compiled binary, where both SDKs are external, or a missing
 * dependency). Route construction reads its reason and keeps official
 * Anthropic accounts out of floored routes, as before the bridge existed.
 */
function unavailableWiring(
	reason: string,
	config: SdkBridgeLimitConfig,
): SdkBridgeWiring {
	let shuttingDown = false;
	const availability = (): SdkBridgeAvailability =>
		shuttingDown
			? { state: "shutting_down" }
			: { state: "unavailable", reason };
	const refuse = async (): Promise<Response> => {
		throw new SdkBridgeUnavailableError(reason);
	};
	return {
		transport: {
			availability,
			startTurn: refuse,
			continueTurn: refuse,
			findContinuation: () => null,
		},
		status: () => ({
			availability: availability(),
			live: 0,
			parked: 0,
			cap: config.getSdkBridgeMaxProcesses(),
			counters: {
				turnsStarted: 0,
				turnsCompleted: 0,
				turnsFailed: 0,
				continuations: 0,
				rejected: {},
				resumes: 0,
				rebuilds: 0,
			},
			peakRssBytes: null,
		}),
		beginShutdown: () => {
			shuttingDown = true;
		},
		dispose: async () => {
			shuttingDown = true;
		},
	};
}

/**
 * Build the Claude Agent SDK bridge and install it as the proxy's transport
 * for floored requests that land on an official Anthropic account. Never
 * throws: a bridge that cannot load reports itself unavailable instead.
 *
 * Claude Code's model calls come back through `dispatchProxyRequest` with the
 * turn's trusted inner context attached to the Request, so they route only to
 * the turn's frozen plan and are recorded as ordinary requests.
 */
export async function installSdkBridge(input: {
	proxyContext: ProxyContext;
	config: SdkBridgeLimitConfig;
	turnRepo: SdkBridgeTurnRepo;
	workRoot?: string;
	/** Test seam: how the bridge package is loaded. */
	load?: () => Promise<BridgeModule>;
	/** Test seam: bridge dependencies (a fake query, timings, executable). */
	overrides?: Partial<ClaudeSdkBridgeDeps>;
}): Promise<SdkBridgeWiring> {
	const { proxyContext, config } = input;
	let wiring: SdkBridgeWiring;
	try {
		const bridgeModule = await (
			input.load ?? (() => import("@clankermux/claude-sdk-bridge"))
		)();
		const bridge: ClaudeSdkBridge = bridgeModule.createClaudeSdkBridge({
			workRoot: input.workRoot ?? sdkBridgeWorkRoot(),
			turnRepo: input.turnRepo,
			limits: () => sdkBridgeLimitsFromConfig(config),
			dispatchInner: (req, ctx) => {
				setSdkBridgeInnerRequestContext(req, ctx);
				return dispatchProxyRequest(
					req,
					new URL(req.url),
					proxyContext,
					ctx.apiKeyId,
					ctx.apiKeyName,
				);
			},
			...input.overrides,
		});
		let disposed: Promise<void> | null = null;
		wiring = {
			transport: bridge,
			status: () => bridge.status(),
			beginShutdown: () => bridge.beginShutdown(),
			dispose: () => {
				disposed ??= bridge.dispose();
				return disposed;
			},
		};
	} catch (error) {
		wiring = unavailableWiring(
			`the SDK bridge failed to load (${(error instanceof Error ? error.message : String(error)).split("\n")[0]})`,
			config,
		);
	}
	const availability = wiring.transport.availability();
	if (availability.state === "available")
		log.info("Claude Agent SDK bridge available");
	else if (availability.state === "unavailable")
		log.warn(
			`Claude Agent SDK bridge unavailable: ${availability.reason}. Official Anthropic accounts will not serve non-Claude-Code clients.`,
		);
	proxyContext.sdkBridge = wiring.transport;
	return wiring;
}
