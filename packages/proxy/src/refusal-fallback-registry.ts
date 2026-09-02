import { createHash } from "node:crypto";

/**
 * How long a fallback credit token stays redeemable.
 *
 * Claude Code re-sends a refused turn to the fallback model within a few
 * seconds, so this is a generous ceiling rather than a tight bound: past it the
 * correlation would be guesswork, and a retry that arrives later simply records
 * no origin model instead of being attributed to whatever refusal happened to
 * share the token's hash prefix.
 */
export const FALLBACK_CREDIT_TTL_MS = 5 * 60_000;

/**
 * Hash a fallback credit token for correlation.
 *
 * The token itself is an opaque provider credential the client redeems — it is
 * never stored, logged, or held in memory past this call. 128 bits of SHA-256
 * is far past collision-relevant for a registry that holds at most a handful of
 * entries at a time.
 */
export function hashCreditToken(token: string): string {
	return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

/** What a refusal recorded about itself, keyed by its credit token's hash. */
export interface RefusalOrigin {
	/** The model that produced the refusal, as the provider reported it. */
	model: string | null;
	/** The refusal's category ('unknown' when the provider named none). */
	category: string | undefined;
	/** Ms epoch at which the refusal was observed. */
	at: number;
}

export interface RefusalFallbackRegistry {
	/** Record that a refusal issued this credit token. */
	noteRefusal(hash: string, origin: RefusalOrigin): void;
	/**
	 * Consume the origin of a credit token. Returns the entry when it is still
	 * within the credit lifetime, else null. Either way the entry is removed: a
	 * credit is redeemed once.
	 */
	takeOrigin(hash: string, now: number): RefusalOrigin | null;
	/** Live entry count (diagnostics and tests). */
	size(): number;
	/** Drop every entry. */
	reset(): void;
}

/**
 * In-memory correlation between a refusal and the retry that redeems its
 * fallback credit.
 *
 * Eviction is traffic-driven rather than timer-driven: every call first sweeps
 * entries past the TTL, so the map stays bounded without holding a timer alive
 * on an otherwise idle process. The population is naturally tiny — one entry
 * per refusal still inside its credit window — so the sweep is cheap.
 */
export function createRefusalFallbackRegistry(
	ttlMs: number = FALLBACK_CREDIT_TTL_MS,
): RefusalFallbackRegistry {
	const entries = new Map<string, RefusalOrigin>();

	const evict = (now: number): void => {
		for (const [hash, origin] of entries) {
			if (now - origin.at > ttlMs) entries.delete(hash);
		}
	};

	return {
		noteRefusal(hash, origin) {
			evict(origin.at);
			entries.set(hash, origin);
		},
		takeOrigin(hash, now) {
			evict(now);
			const origin = entries.get(hash);
			if (!origin) return null;
			entries.delete(hash);
			// The sweep above already removed anything past the TTL, so reaching
			// here means the credit is live. The explicit check stays as the single
			// place the lifetime rule is enforced.
			return now - origin.at <= ttlMs ? origin : null;
		},
		size() {
			return entries.size;
		},
		reset() {
			entries.clear();
		},
	};
}

/**
 * The process-wide registry production code uses.
 *
 * A module singleton rather than an injected dependency because the two sides
 * of the correlation sit in unrelated modules (the usage collector parsing a
 * response, the ingress parsing the NEXT request) with no shared context to
 * thread it through. Tests call `reset()` in `beforeEach` rather than stubbing
 * the module.
 */
export const refusalFallbackRegistry = createRefusalFallbackRegistry();
