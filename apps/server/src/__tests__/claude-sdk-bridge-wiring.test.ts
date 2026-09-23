import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ClaudeSdkBridgeDeps,
	DEFAULT_SDK_BRIDGE_LIMITS,
} from "@clankermux/claude-sdk-bridge";
import { Config } from "@clankermux/config";
import type { ProxyContext } from "@clankermux/proxy";
import {
	getSdkBridgeInnerRequestContext,
	type SdkBridgeInnerContext,
	SdkBridgeUnavailableError,
} from "@clankermux/types";
import {
	installSdkBridge,
	sdkBridgeLimitsFromConfig,
	sdkBridgeWorkRoot,
} from "../claude-sdk-bridge-wiring";

function withConfig<T>(
	file: Record<string, unknown> | null,
	run: (config: Config, path: string) => T,
): T {
	const dir = mkdtempSync(join(tmpdir(), "cmx-bridge-wiring-"));
	try {
		const path = join(dir, "config.json");
		if (file) writeFileSync(path, JSON.stringify(file));
		return run(new Config(path), path);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const turnRepo = {
	insertTurn: async () => {},
	finishTurn: async () => {},
	bumpTurnCounters: async () => {},
	insertLeg: async () => {},
	finishLeg: async () => {},
};

/** A bridge module whose factory records the dependencies it was built with. */
function fakeModule() {
	const built: ClaudeSdkBridgeDeps[] = [];
	let disposals = 0;
	let shutdowns = 0;
	const module = {
		createClaudeSdkBridge(deps: ClaudeSdkBridgeDeps) {
			built.push(deps);
			return {
				availability: () => ({ state: "available" as const }),
				startTurn: async () => new Response("turn"),
				continueTurn: async () => new Response("continue"),
				findContinuation: () => null,
				beginShutdown: () => {
					shutdowns++;
				},
				dispose: async () => {
					disposals++;
				},
				status: () => ({
					availability: { state: "available" as const },
					live: 0,
					parked: 0,
					cap: deps.limits?.().maxProcesses ?? 0,
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
			};
		},
	};
	return {
		load: async () =>
			module as unknown as typeof import("@clankermux/claude-sdk-bridge"),
		built,
		disposals: () => disposals,
		shutdowns: () => shutdowns,
	};
}

describe("SDK bridge limits from Config", () => {
	it("defaults to the bridge package's own defaults", () => {
		withConfig(null, (config) => {
			expect(sdkBridgeLimitsFromConfig(config)).toEqual(
				DEFAULT_SDK_BRIDGE_LIMITS,
			);
		});
	});

	it("is read live, so an edited value applies to the next turn", () => {
		withConfig(null, (config) => {
			const fake = fakeModule();
			return installSdkBridge({
				proxyContext: {} as ProxyContext,
				config,
				turnRepo,
				workRoot: "/tmp/unused",
				load: fake.load,
			}).then(() => {
				const limits = fake.built[0]?.limits;
				expect(limits?.().maxProcesses).toBe(8);
				config.set("sdk_bridge_max_processes", 3);
				expect(limits?.().maxProcesses).toBe(3);
			});
		});
	});
});

describe("sdkBridgeWorkRoot", () => {
	it("lives under XDG_CACHE_HOME, or ~/.cache without it", () => {
		expect(sdkBridgeWorkRoot({ XDG_CACHE_HOME: "/var/cache/x" })).toBe(
			"/var/cache/x/clankermux/claude-agent-sdk",
		);
		expect(sdkBridgeWorkRoot({})).toBe(
			join(homedir(), ".cache", "clankermux", "claude-agent-sdk"),
		);
	});
});

describe("installSdkBridge", () => {
	it("installs the bridge on the proxy context", async () => {
		await withConfig(null, async (config) => {
			const fake = fakeModule();
			const proxyContext = {} as ProxyContext;
			const wiring = await installSdkBridge({
				proxyContext,
				config,
				turnRepo,
				workRoot: "/tmp/cmx-work",
				load: fake.load,
			});
			expect(proxyContext.sdkBridge).toBe(wiring.transport);
			expect(fake.built[0]?.workRoot).toBe("/tmp/cmx-work");
			expect(fake.built[0]?.turnRepo).toBe(turnRepo);
			expect(wiring.status().cap).toBe(8);
		});
	});

	it("reports the bridge unavailable, with the reason, when it cannot load", async () => {
		await withConfig(null, async (config) => {
			const proxyContext = {} as ProxyContext;
			const wiring = await installSdkBridge({
				proxyContext,
				config,
				turnRepo,
				load: async () => {
					throw new Error('Cannot find module "@modelcontextprotocol/sdk"');
				},
			});
			const availability = proxyContext.sdkBridge?.availability();
			expect(availability?.state).toBe("unavailable");
			expect(
				availability?.state === "unavailable" ? availability.reason : "",
			).toContain("@modelcontextprotocol/sdk");
			expect(proxyContext.sdkBridge?.findContinuation(["toolu_1"])).toBeNull();
			await expect(
				proxyContext.sdkBridge?.startTurn({
					request: new Request("http://x/v1/messages"),
					plan: {} as never,
					meta: {} as never,
					signal: new AbortController().signal,
				}),
			).rejects.toBeInstanceOf(SdkBridgeUnavailableError);
			expect(wiring.status()).toMatchObject({ live: 0, parked: 0, cap: 8 });
			wiring.beginShutdown();
			expect(proxyContext.sdkBridge?.availability()).toEqual({
				state: "shutting_down",
			});
			await wiring.dispose();
		});
	});

	it("disposes once however often it is asked, and forwards shutdown", async () => {
		await withConfig(null, async (config) => {
			const fake = fakeModule();
			const wiring = await installSdkBridge({
				proxyContext: {} as ProxyContext,
				config,
				turnRepo,
				load: fake.load,
			});
			wiring.beginShutdown();
			await Promise.all([wiring.dispose(), wiring.dispose()]);
			await wiring.dispose();
			expect(fake.shutdowns()).toBe(1);
			expect(fake.disposals()).toBe(1);
		});
	});

	it("serves an inner call through the proxy with its trusted context attached", async () => {
		await withConfig(null, async (config) => {
			const fake = fakeModule();
			await installSdkBridge({
				proxyContext: {} as ProxyContext,
				config,
				turnRepo,
				load: fake.load,
			});
			const req = new Request("http://127.0.0.1:1/v1/messages", {
				method: "POST",
				body: "{}",
			});
			const ctx = { turnId: "turn-1" } as SdkBridgeInnerContext;
			// The stub context cannot serve anything; the proxy's error mapping
			// still answers, and the context is on the Request it was handed.
			const response = await fake.built[0]?.dispatchInner(req, ctx);
			expect(response).toBeInstanceOf(Response);
			expect(getSdkBridgeInnerRequestContext(req)).toBe(ctx);
		});
	});
});
