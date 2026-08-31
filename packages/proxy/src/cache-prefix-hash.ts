import { createHash, type Hash } from "node:crypto";

/**
 * Per-breakpoint prompt-cache prefix digests for an Anthropic-style
 * `/v1/messages` body — pure MEASUREMENT, consumed by nothing at runtime.
 *
 * Persisted as `requests.cache_prefix_hashes` so an offline analysis can tell
 * whether a later request in the same session would have HIT the prompt cache
 * an earlier request wrote (intact prefix — a keepalive could have bridged the
 * idle gap) or not (diverged prefix — compaction/edits, which no keepalive can
 * rescue). That distinction is the one the June 2026 keepalive shutdown could
 * not measure.
 *
 * ## Chained digests
 *
 * The body is walked in prompt order (model, tools, system, then each
 * message's role + content), and every unit is streamed into a running sha256.
 * At each ephemeral `cache_control` breakpoint the current digest is emitted
 * and SEEDS the next segment's hasher, so hash k commits to every byte from
 * the start of the body through breakpoint k without ever re-hashing the
 * prefix (and without `hash.copy()`). Equality of hash k between two bodies
 * therefore means byte-equality of everything up to breakpoint k — exactly the
 * condition for the later body to read the earlier body's cache entry.
 *
 * Each unit is length-prefixed (kind tag, byte count, bytes — the
 * `digestKey` precedent in packages/core/src/pricing.ts) so no concatenation
 * of differently-split blocks can collide. UTF-8 is safe here, unlike
 * pricing's utf16le: every unit string is `JSON.stringify` output, which
 * escapes lone surrogates (ES2019), so encoding is lossless.
 *
 * ## Invariances
 *
 * `cache_control` itself is stripped (shallow clone — the parsed body is
 * shared with RequestBodyContext and must never be mutated) before a
 * breakpoint block is hashed. The digest is therefore invariant to
 * `injectCacheTtl1h` and to ttl differences generally: a breakpoint's POSITION
 * matters, the marker's contents don't, and computation order relative to the
 * ttl injection is irrelevant.
 *
 * Returns null for bodies with no ephemeral breakpoint (nothing was cached —
 * there is no prefix identity to record) and for any malformed shape; like
 * cache-ttl-injector, this never throws.
 */
export function computeCachePrefixHashes(body: unknown): string[] | null {
	try {
		if (!body || typeof body !== "object" || Array.isArray(body)) return null;
		const record = body as Record<string, unknown>;

		const walk = new PrefixHashWalk();

		walk.unit("m", JSON.stringify(record.model ?? ""));

		const tools = record.tools;
		if (Array.isArray(tools)) {
			for (const tool of tools) {
				walk.block("t", tool);
			}
		}

		const system = record.system;
		if (typeof system === "string") {
			walk.unit("y", JSON.stringify(system));
		} else if (Array.isArray(system)) {
			for (const block of system) {
				walk.block("y", block);
			}
		}

		// tool_choice and thinking changes invalidate MESSAGE-level cache
		// breakpoints but leave tools/system breakpoints valid (Anthropic's
		// documented invalidation scope; the keepalive scheduler leans on the
		// same fact when it refuses to touch tool_choice on replays). Hash them
		// here — after the tools/system sections, before any message unit — so
		// they perturb exactly the message-breakpoint hashes. `?? null` folds
		// "absent" and "explicit null" together, which is semantically identical
		// upstream.
		walk.unit("o", JSON.stringify(record.tool_choice ?? null));
		walk.unit("k", JSON.stringify(record.thinking ?? null));

		const messages = record.messages;
		if (Array.isArray(messages)) {
			for (const message of messages) {
				if (!message || typeof message !== "object") continue;
				const m = message as Record<string, unknown>;
				walk.unit("r", JSON.stringify(m.role ?? ""));
				const content = m.content;
				if (typeof content === "string") {
					walk.unit("s", JSON.stringify(content));
				} else if (Array.isArray(content)) {
					for (const block of content) {
						walk.block("c", block);
					}
				}
			}
		}

		return walk.finish();
	} catch {
		return null;
	}
}

/** Hard cap on emitted hashes — Anthropic's API allows 4 breakpoints, 8 is headroom. */
const MAX_PREFIX_HASHES = 8;

/** Stored width: 16 hex chars (64 bits) per breakpoint; the CHAIN always feeds
 * the full 32-byte digest forward, only storage is truncated. */
const STORED_HEX_CHARS = 16;

/** Domain-separation seed for the first segment of every chain. */
const CHAIN_SEED = "clankermux-cpfx-v1";

/** Streaming walk state: one segment hasher at a time, digests chained. */
class PrefixHashWalk {
	private hasher: Hash = seedHasher(null);
	private readonly hashes: string[] = [];

	/** Feed one length-prefixed unit into the current segment. */
	unit(kind: string, unitJson: string): void {
		if (this.hashes.length >= MAX_PREFIX_HASHES) return;
		const bytes = Buffer.from(unitJson, "utf8");
		this.hasher.update(kind);
		this.hasher.update(`${bytes.length}:`);
		this.hasher.update(bytes);
	}

	/**
	 * Feed one tool/system/content block. A block carrying an ephemeral
	 * `cache_control` is a breakpoint: it is hashed with the marker stripped,
	 * then the segment digest is emitted and chained.
	 */
	block(kind: string, blockValue: unknown): void {
		if (this.hashes.length >= MAX_PREFIX_HASHES) return;
		if (isEphemeralBreakpoint(blockValue)) {
			const { cache_control: _stripped, ...rest } = blockValue;
			this.unit(kind, JSON.stringify(rest));
			const digest = this.hasher.digest();
			this.hashes.push(digest.toString("hex").slice(0, STORED_HEX_CHARS));
			this.hasher = seedHasher(digest);
		} else {
			this.unit(kind, JSON.stringify(blockValue));
		}
	}

	finish(): string[] | null {
		return this.hashes.length > 0 ? this.hashes : null;
	}
}

function seedHasher(previousDigest: Buffer | null): Hash {
	const hasher = createHash("sha256");
	hasher.update(CHAIN_SEED);
	if (previousDigest) {
		hasher.update("h32:");
		hasher.update(previousDigest);
	}
	return hasher;
}

/** Same shape test as cache-ttl-injector's isEphemeral. */
function isEphemeralBreakpoint(
	block: unknown,
): block is Record<string, unknown> & { cache_control: unknown } {
	if (!block || typeof block !== "object") return false;
	const cc = (block as { cache_control?: unknown }).cache_control;
	return (
		!!cc &&
		typeof cc === "object" &&
		(cc as { type?: unknown }).type === "ephemeral"
	);
}
