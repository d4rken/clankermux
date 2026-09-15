import { describe, expect, it } from "bun:test";
import { makeAccount } from "@clankermux/test-support";
import {
	PROVIDER_NAMES,
	type ProviderName,
	supportsCustomEndpoint,
} from "@clankermux/types";
import { getProvider, listProviders } from "../index";

/**
 * `PROVIDER_CONFIG.honoursCustomEndpoint` is a hand-written claim about code
 * that lives somewhere else: each provider's `buildUrl`. Three providers pin
 * their endpoint and discard the account (zai, minimax, ollama-cloud), and the
 * surfaces that let an operator SET a custom endpoint gate on that flag, so a
 * flag that drifts from the provider it describes silently either hides a
 * working setting or re-opens the "stored, badged, and ignored" hole.
 *
 * This probes the real registry rather than restating the list: it asks every
 * registered provider to build a URL for an account carrying a sentinel
 * endpoint and compares what came back with what the flag promises.
 */

const SENTINEL_HOST = "sentinel.invalid";
const SENTINEL = `https://${SENTINEL_HOST}/base`;

/**
 * Provider names with no entry in the registry. `claude-console-api` is a
 * BILLING distinction on an Anthropic account, not a provider implementation:
 * `proxyWithAccount` does call `getProvider(account.provider)` for it, misses,
 * and falls back to the context provider. Its flag therefore describes that
 * fallback rather than an implementation this probe can reach. Listed
 * explicitly so that adding a provider name without registering it fails here
 * rather than silently escaping the probe below.
 */
const UNREGISTERED: ReadonlySet<string> = new Set([
	PROVIDER_NAMES.CLAUDE_CONSOLE_API,
]);

function honoursSentinel(name: ProviderName): boolean {
	const provider = getProvider(name);
	if (!provider) throw new Error(`no registered provider for ${name}`);
	const url = provider.buildUrl(
		"/v1/messages",
		"",
		makeAccount({ provider: name, custom_endpoint: SENTINEL }),
	);
	// Hostname equality, not substring: a provider that embedded the sentinel in
	// a path or query while still dialling its own host would otherwise read as
	// honouring it.
	try {
		return new URL(url).hostname === SENTINEL_HOST;
	} catch {
		return false;
	}
}

describe("PROVIDER_CONFIG.honoursCustomEndpoint matches each provider's buildUrl", () => {
	const names = Object.values(PROVIDER_NAMES);

	it("covers every provider name, registered or explicitly not", () => {
		const missing = names.filter(
			(name) => !UNREGISTERED.has(name) && !getProvider(name),
		);
		expect(missing).toEqual([]);
		// The other direction: a name listed as unregistered that HAS gained a
		// provider must be probed, not exempted.
		const wronglyExempt = [...UNREGISTERED].filter((name) => getProvider(name));
		expect(wronglyExempt).toEqual([]);
	});

	it("covers every REGISTERED provider, not just the named ones", () => {
		// Registering a provider under a name absent from PROVIDER_NAMES would
		// give it no capability row at all, so `supportsCustomEndpoint` would deny
		// it by default and no assertion below would ever run against it.
		const unnamed = listProviders().filter(
			(name) => !(names as string[]).includes(name),
		);
		expect(unnamed).toEqual([]);
	});

	for (const name of names) {
		if (UNREGISTERED.has(name)) continue;
		it(`${name}`, () => {
			expect(honoursSentinel(name)).toBe(supportsCustomEndpoint(name));
		});
	}

	it("denies an unknown provider rather than defaulting it open", () => {
		expect(supportsCustomEndpoint("not-a-provider")).toBe(false);
	});
});
