import { createHash, type Hash } from "node:crypto";
import type { CachePrefixCapture } from "@clankermux/types";

/**
 * Prompt-cache prefix identity for an Anthropic-style `/v1/messages` body —
 * pure MEASUREMENT, consumed by nothing at runtime.
 *
 * Persisted (as JSON) in `requests.cache_prefix_hashes` so an offline analysis
 * can tell whether a later request in the same session would have HIT the
 * prompt cache an earlier request wrote (intact prefix — a keepalive could
 * have bridged the idle gap) or not (diverged prefix — compaction/edits, which
 * no keepalive can rescue). That distinction is the one the June 2026
 * keepalive shutdown could not measure.
 *
 * ## Why two chains (v2)
 *
 * The first version stored only per-breakpoint digests, betting that a later
 * request retains a breakpoint at the earlier request's last breakpoint
 * position. Live data falsified that immediately: Claude Code keeps exactly
 * ONE message breakpoint — on the current last message — and slides it every
 * turn, so consecutive requests shared their tools/system hashes but never
 * the message one (0/31 containment). A cache READ needs no breakpoint at the
 * read position, so the join has to be position-aligned instead, and the
 * position-aligned digests must be BREAKPOINT-BLIND — a digest whose chain
 * restarts at breakpoints would change when the marker slides away even
 * though the content bytes did not. Hence two chains over the same units:
 *
 * - the **breakpoint chain** (`bp`): chain points at ephemeral `cache_control`
 *   blocks — the positions of CC's actual markers, kept for placement
 *   diagnostics and for tools/system-level identity;
 * - the **message chain** (`n` + `tail`): chain points at every message END,
 *   entirely ignoring breakpoints. The tail window (last
 *   {@link MESSAGE_TAIL_LENGTH} digests) is what the analysis joins on:
 *   whenever B appends fewer than {@link MESSAGE_TAIL_LENGTH} messages beyond
 *   A's end, B carries a digest at the index where A ended, and
 *   position-aligned equality means B's content through A's last message is
 *   byte-identical — which covers A's deepest cache write, since CC's message
 *   breakpoint sits on A's last message. Resumes append 1–2 messages, so a
 *   16-deep tail is ample headroom; a pair whose gap exceeds the window is
 *   UNMEASURABLE (the analysis must classify it as such, never as diverged —
 *   guard the SQL offset, a negative `$.tail[i]` index is a JSON1 error).
 *
 * ## Chained digests
 *
 * The body is walked once in prompt order (model, tools, system, tool_choice
 * + thinking, then each message's role + content); every unit is streamed
 * into both running sha256s. At a chain point the current digest is emitted
 * and SEEDS that chain's next segment, so a digest commits to every byte from
 * the start of the body through its position without ever re-hashing the
 * prefix (and without `hash.copy()`). Equality of position-aligned digests
 * between two bodies therefore means byte-equality of everything up to that
 * position.
 *
 * Each unit is length-prefixed (kind tag, byte count, bytes — the `digestKey`
 * precedent in packages/core/src/pricing.ts) so no concatenation of
 * differently-split blocks can collide. UTF-8 is safe here, unlike pricing's
 * utf16le: every unit string is `JSON.stringify` output, which escapes lone
 * surrogates (ES2019), so encoding is lossless.
 *
 * ## Invariances
 *
 * `cache_control` itself is stripped (shallow clone — the parsed body is
 * shared with RequestBodyContext and must never be mutated) before a
 * breakpoint block is hashed, in BOTH chains. The digests are therefore
 * invariant to `injectCacheTtl1h` and to ttl differences generally, and the
 * message chain is additionally invariant to where the markers sit at all.
 * `tool_choice` and `thinking` are hashed between the system and message
 * sections because changing them invalidates MESSAGE-level cache breakpoints
 * only (Anthropic's documented invalidation scope; the keepalive scheduler
 * leans on the same fact when it refuses to touch tool_choice on replays).
 *
 * Returns null for bodies with no ephemeral breakpoint (nothing was cached —
 * there is no prefix identity to record) and for any malformed shape; like
 * cache-ttl-injector, this never throws.
 */
export type { CachePrefixCapture };

export function computeCachePrefixHashes(
	body: unknown,
): CachePrefixCapture | null {
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

		// After the tools/system sections, before any message unit — so these
		// perturb exactly the message-level digests (see Invariances above).
		// `?? null` folds "absent" and "explicit null" together, which is
		// semantically identical upstream.
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
				walk.messageEnd();
			}
		}

		return walk.finish();
	} catch {
		return null;
	}
}

/** Hard cap on stored breakpoint digests — Anthropic's API allows 4, 8 is headroom. */
const MAX_BREAKPOINT_HASHES = 8;

/**
 * Message-end digests kept in the tail window. A resume appends 1–2 messages
 * beyond the previous request's end (assistant reply + new user turn), so the
 * position-aligned join needs only a few; 16 is generous headroom for
 * multi-tool turns that were never persisted in between.
 */
const MESSAGE_TAIL_LENGTH = 16;

/** Stored width: 16 hex chars (64 bits) per digest; the CHAINS always feed
 * the full 32-byte digest forward, only storage is truncated. */
const STORED_HEX_CHARS = 16;

/** Domain-separation seeds — one per chain, so the two can never collide. */
const BREAKPOINT_CHAIN_SEED = "clankermux-cpfx-bp-v2";
const MESSAGE_CHAIN_SEED = "clankermux-cpfx-msg-v2";

/** Streaming walk state: two segment hashers fed identically, chained apart. */
class PrefixHashWalk {
	private bpHasher: Hash = seedHasher(BREAKPOINT_CHAIN_SEED, null);
	private msgHasher: Hash = seedHasher(MESSAGE_CHAIN_SEED, null);
	private readonly breakpoints: string[] = [];
	private readonly tail: string[] = [];
	private messageCount = 0;

	/** Feed one length-prefixed unit into both chains' current segments. */
	unit(kind: string, unitJson: string): void {
		const bytes = Buffer.from(unitJson, "utf8");
		const framing = `${bytes.length}:`;
		this.bpHasher.update(kind);
		this.bpHasher.update(framing);
		this.bpHasher.update(bytes);
		this.msgHasher.update(kind);
		this.msgHasher.update(framing);
		this.msgHasher.update(bytes);
	}

	/**
	 * Feed one tool/system/content block. A block carrying an ephemeral
	 * `cache_control` is hashed with the marker stripped in BOTH chains, and
	 * is a chain point for the breakpoint chain only (up to the cap — later
	 * breakpoints still chain, they are just not stored).
	 */
	block(kind: string, blockValue: unknown): void {
		if (isEphemeralBreakpoint(blockValue)) {
			const { cache_control: _stripped, ...rest } = blockValue;
			this.unit(kind, JSON.stringify(rest));
			const digest = this.bpHasher.digest();
			this.bpHasher = seedHasher(BREAKPOINT_CHAIN_SEED, digest);
			if (this.breakpoints.length < MAX_BREAKPOINT_HASHES) {
				this.breakpoints.push(
					digest.toString("hex").slice(0, STORED_HEX_CHARS),
				);
			}
		} else {
			this.unit(kind, JSON.stringify(blockValue));
		}
	}

	/** Every message end is a chain point for the message chain only. */
	messageEnd(): void {
		this.messageCount += 1;
		const digest = this.msgHasher.digest();
		this.msgHasher = seedHasher(MESSAGE_CHAIN_SEED, digest);
		this.tail.push(digest.toString("hex").slice(0, STORED_HEX_CHARS));
		if (this.tail.length > MESSAGE_TAIL_LENGTH) this.tail.shift();
	}

	finish(): CachePrefixCapture | null {
		if (this.breakpoints.length === 0) return null;
		return {
			v: 2,
			bp: this.breakpoints,
			n: this.messageCount,
			tail: this.tail,
		};
	}
}

function seedHasher(seed: string, previousDigest: Buffer | null): Hash {
	const hasher = createHash("sha256");
	hasher.update(seed);
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
