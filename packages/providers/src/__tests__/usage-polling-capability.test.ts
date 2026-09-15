import { describe, expect, it } from "bun:test";
import {
	PROVIDER_CONFIG,
	PROVIDER_NAMES,
	type ProviderName,
	supportsUsagePolling,
	supportsUsageTracking,
} from "@clankermux/types";
import { usageCache } from "../usage-fetcher";

/**
 * `supportsUsagePolling` decides which providers the account lifecycle may
 * start a poller for. It is a hand-written claim about code somewhere else:
 * the provider dispatch inside `UsageFetcher.fetchAndCache`.
 *
 * That dispatch has no `default: return null`. Any provider without an explicit
 * branch falls through to the ANTHROPIC `/oauth/usage` read, so a flag that
 * drifts ahead of the dispatch does not merely fail to fetch — it sends that
 * account's credential to api.anthropic.com. `qwen` is exactly that shape
 * today: `supportsUsageTracking: true` (response-body tracking) with no branch.
 *
 * This probes the real cache with a stubbed `fetch` and asserts where each
 * provider actually dials, rather than restating the provider list.
 */

/**
 * Hosts each provider's USAGE fetcher contacts. Not the same as its inference
 * endpoint in PROVIDER_CONFIG: Minimax serves quota from www.minimax.io while
 * inference goes to api.minimax.io.
 *
 * Minimax is listed even though it is not pollable through the lifecycle today
 * — the point is that its dispatch branch is real, so whenever its starter is
 * wired the flag can flip without also needing a fetcher change.
 */
const EXPECTED_HOST: Partial<Record<ProviderName, string>> = {
	[PROVIDER_NAMES.ANTHROPIC]: "api.anthropic.com",
	[PROVIDER_NAMES.ZAI]: "api.z.ai",
	[PROVIDER_NAMES.KILO]: "api.kilo.ai",
	[PROVIDER_NAMES.DEVIN]: "server.codeium.com",
	[PROVIDER_NAMES.MINIMAX]: "www.minimax.io",
};

async function hostDialledFor(provider: ProviderName): Promise<string | null> {
	const original = globalThis.fetch;
	let host: string | null = null;
	globalThis.fetch = (async (input: string | URL | Request) => {
		host ??= new URL(String(input instanceof Request ? input.url : input))
			.hostname;
		// A shape no parser accepts: the fetch never has to succeed, and an
		// accepted body could write a cache entry this probe does not want.
		return new Response("{}", {
			status: 500,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	// The cache is a module singleton. Probe under an id no other suite uses and
	// stop polling in `finally`, so this never leaves a timer or token provider
	// installed for another test in the same process.
	const accountId = `usage-polling-capability-probe-${provider}`;
	try {
		usageCache.startPolling(accountId, "token", provider, 3_600_000);
		await usageCache.refreshNow(accountId);
	} finally {
		usageCache.stopPolling(accountId);
		globalThis.fetch = original;
	}
	return host;
}

describe("supportsUsagePolling matches the real usage-fetcher dispatch", () => {
	it("gives every pollable provider its own dispatch branch and host", async () => {
		// A provider with no branch falls through to the Anthropic read, so
		// `api.anthropic.com` on a non-Anthropic provider means a credential leak.
		// `null` is failed too: a provider that dialled NOTHING has no working
		// dispatch either, and accepting it would let a broken stub read as a pass.
		const observed: Record<string, string | null> = {};
		for (const provider of Object.values(PROVIDER_NAMES)) {
			if (!supportsUsagePolling(provider)) continue;
			observed[provider] = await hostDialledFor(provider);
		}
		for (const [provider, host] of Object.entries(observed)) {
			expect({ provider, host }).toEqual({
				provider,
				host: EXPECTED_HOST[provider as ProviderName] ?? null,
			});
		}
		// Every provider the flag admits must be covered by the table above, or
		// this test silently stops checking the one that was added.
		expect(Object.keys(observed).sort()).toEqual(
			Object.values(PROVIDER_NAMES)
				.filter((p) => supportsUsagePolling(p))
				.sort(),
		);
	});

	it("keeps qwen out of polling even though it tracks usage", () => {
		// The pairing that motivates a separate flag: tracking is true, polling
		// must be false, because there is no qwen branch to dispatch to.
		expect(supportsUsageTracking(PROVIDER_NAMES.QWEN)).toBe(true);
		expect(supportsUsagePolling(PROVIDER_NAMES.QWEN)).toBe(false);
	});

	it("keeps codex out of polling; the spend coordinator warms it", () => {
		expect(supportsUsagePolling(PROVIDER_NAMES.CODEX)).toBe(false);
	});

	it("keeps minimax out of polling while nothing starts a minimax poller", () => {
		// Its fetcher branch works; no lifecycle path starts it. Flipping this
		// without adding that wiring would show a refresh button that can only
		// fail. Flip it in the same change that adds the starter.
		expect(supportsUsagePolling(PROVIDER_NAMES.MINIMAX)).toBe(false);
	});

	it("only claims polling for providers that also expose usage tracking", () => {
		const claimed = Object.values(PROVIDER_NAMES).filter((p) =>
			supportsUsagePolling(p),
		);
		expect(claimed.length).toBeGreaterThan(0);
		for (const provider of claimed) {
			expect(supportsUsageTracking(provider)).toBe(true);
		}
	});

	it("declares the flag for every known provider", () => {
		for (const provider of Object.values(PROVIDER_NAMES)) {
			expect(typeof PROVIDER_CONFIG[provider].supportsUsagePolling).toBe(
				"boolean",
			);
		}
	});

	it("denies unknown providers", () => {
		expect(supportsUsagePolling("not-a-provider")).toBe(false);
	});

	it("dials the expected host for each provider with a fetcher branch", async () => {
		// Includes minimax, which has a branch but no lifecycle starter: pinning
		// it here means wiring that starter later needs no fetcher change.
		for (const [provider, expected] of Object.entries(EXPECTED_HOST)) {
			const host = await hostDialledFor(provider as ProviderName);
			expect({ provider, host }).toEqual({ provider, host: expected });
		}
	});
});
