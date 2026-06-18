import type { RequestBodyContext } from "./request-body-context";

/**
 * Phase 2 predictive promotion: rewrite a request's ephemeral cache breakpoints
 * to a 1-hour TTL so an idle-prone large session can be bridged for HOURS.
 *
 * Anthropic chooses the prompt-cache TTL at WRITE time via
 * `cache_control: { type: "ephemeral", ttl: "1h" }` (default is 5m). This walks
 * BOTH `body.system` (when it's an array) and every
 * `body.messages[i].content[j]` array block, and for each ephemeral breakpoint
 * whose `ttl !== "1h"` sets `ttl = "1h"`. The upgrade is UNIFORM (every ephemeral
 * breakpoint → 1h) so there's never a mixed-TTL ordering problem.
 *
 * Mirrors the old `injectSystemCacheTtl` mutation pattern: it mutates via
 * {@link RequestBodyContext.mutateParsedJson} (so the change is reflected in
 * `getBuffer()`), and if nothing needed changing it does NOT mark dirty /
 * re-serialize. Parse/shape failures are swallowed (no-op).
 */
export function injectCacheTtl1h(context: RequestBodyContext): void {
	try {
		const body = context.getParsedJson();
		if (!body) return;

		// Collect every ephemeral breakpoint that still needs upgrading so we only
		// mutate (and re-serialize) when there's real work.
		if (!needsUpgrade(body)) return;

		context.mutateParsedJson((b) => {
			upgradeBlocks((b as { system?: unknown }).system);
			const messages = (b as { messages?: unknown }).messages;
			if (Array.isArray(messages)) {
				for (const message of messages) {
					if (message && typeof message === "object") {
						upgradeBlocks((message as { content?: unknown }).content);
					}
				}
			}
		});
	} catch {
		// Malformed body — leave it untouched.
	}
}

/**
 * True iff the body's prompt cache is UNIFORMLY 1-hour: it has at least one
 * ephemeral cache breakpoint and EVERY ephemeral breakpoint (system + message
 * content) carries `ttl:"1h"`. This is the reality signal for the cache's TTL —
 * whatever the body sent upstream is what Anthropic actually wrote, regardless of
 * whether WE injected it (the injector upgrades uniformly) or the client set it.
 *
 * The session-cache store uses this — not the promotion tracker — to pick a warm
 * slot's refresh cadence and write rate, so the slot's economics match the cache
 * that actually exists. The "every" rule is deliberately CONSERVATIVE: a mixed
 * body (some breakpoints still default 5m) must be refreshed on the 5-minute
 * cadence to keep the shortest-lived breakpoint warm, so it is treated as 5m.
 * Malformed/parse-failed or breakpoint-less bodies return false (default 5m).
 */
export function bodyCacheTtlIsOneHour(body: unknown): boolean {
	if (!body || typeof body !== "object") return false;
	let sawEphemeral = false;
	const check = (blocks: unknown): boolean => {
		if (!Array.isArray(blocks)) return true; // no breakpoints here → no violation
		for (const block of blocks) {
			if (isEphemeral(block)) {
				sawEphemeral = true;
				if (getTtl(block) !== "1h") return false; // a non-1h breakpoint → not uniform
			}
		}
		return true;
	};
	if (!check((body as { system?: unknown }).system)) return false;
	const messages = (body as { messages?: unknown }).messages;
	if (Array.isArray(messages)) {
		for (const message of messages) {
			if (
				message &&
				typeof message === "object" &&
				!check((message as { content?: unknown }).content)
			) {
				return false;
			}
		}
	}
	return sawEphemeral;
}

/** True if any ephemeral breakpoint (system or message content) lacks ttl:1h. */
function needsUpgrade(body: Readonly<Record<string, unknown>>): boolean {
	if (arrayNeedsUpgrade((body as { system?: unknown }).system)) return true;
	const messages = (body as { messages?: unknown }).messages;
	if (Array.isArray(messages)) {
		for (const message of messages) {
			if (
				message &&
				typeof message === "object" &&
				arrayNeedsUpgrade((message as { content?: unknown }).content)
			) {
				return true;
			}
		}
	}
	return false;
}

function arrayNeedsUpgrade(blocks: unknown): boolean {
	if (!Array.isArray(blocks)) return false;
	return blocks.some((block) => isEphemeral(block) && getTtl(block) !== "1h");
}

/** Set ttl="1h" on every ephemeral breakpoint in an array of content blocks. */
function upgradeBlocks(blocks: unknown): void {
	if (!Array.isArray(blocks)) return;
	for (const block of blocks) {
		if (isEphemeral(block) && getTtl(block) !== "1h") {
			(block as { cache_control: { ttl?: string } }).cache_control.ttl = "1h";
		}
	}
}

function isEphemeral(block: unknown): block is {
	cache_control: { type?: string; ttl?: string };
} {
	if (!block || typeof block !== "object") return false;
	const cc = (block as { cache_control?: unknown }).cache_control;
	return (
		!!cc &&
		typeof cc === "object" &&
		(cc as { type?: string }).type === "ephemeral"
	);
}

function getTtl(block: {
	cache_control: { ttl?: string };
}): string | undefined {
	return block.cache_control.ttl;
}
