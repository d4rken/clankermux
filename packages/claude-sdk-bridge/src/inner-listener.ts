import { createHash, randomBytes } from "node:crypto";
import {
	type SdkBridgeInnerContext,
	type SdkBridgeInnerOutcome,
	sdkBridgeWireModel,
} from "@clankermux/types";
import type { BridgeLog } from "./types";

interface TokenEntry {
	context: SdkBridgeInnerContext;
	models: ReadonlySet<string>;
	revoked: boolean;
}

export interface InnerRegistration {
	/** The per-turn credential Claude Code sends as its auth token. */
	token: string;
	revoke(): void;
}

const MESSAGES_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);
const STRIPPED_HEADERS = new Set([
	"authorization",
	"x-api-key",
	"proxy-authorization",
	"cookie",
	"host",
	"content-length",
]);

function hash(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function jsonError(status: number, type: string, message: string): Response {
	return Response.json({ type: "error", error: { type, message } }, { status });
}

/**
 * The loopback endpoint Claude Code uses as its Anthropic API. Each turn gets
 * its own random token, stored only as a hash; the token maps to the turn's
 * immutable inner context, which alone decides where the call may go. Nothing
 * in the request can widen it: credentials and `x-clankermux-*` headers are
 * dropped, and the model must be one the turn's plan targets.
 */
export class InnerListener {
	private readonly tokens = new Map<string, TokenEntry>();
	private readonly instanceId = randomBytes(6).toString("hex");
	private server: ReturnType<typeof Bun.serve> | null = null;

	constructor(
		private readonly opts: {
			dispatchInner: (
				req: Request,
				ctx: SdkBridgeInnerContext,
			) => Promise<Response>;
			log: BridgeLog;
			/** Largest body an inner call may send, read per call. */
			maxBodyBytes: () => number;
		},
	) {}

	/**
	 * The request body, or null once it passes `limit`: reading stops there
	 * and the rest of the upload is cancelled, never buffered.
	 */
	private async readBounded(
		req: Request,
		limit: number,
	): Promise<Uint8Array | null> {
		if (!req.body) return new Uint8Array();
		const reader = req.body.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			total += next.value.byteLength;
			if (total > limit) {
				await reader.cancel().catch(() => {});
				return null;
			}
			chunks.push(next.value);
		}
		const body = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			body.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return body;
	}

	private tooLarge(
		entry: TokenEntry,
		limit: number,
		declared: number | null,
	): Response {
		const message = `SDK bridge limit maxHistoryBytes exceeded by a model call: ${declared ?? `more than ${limit}`} > ${limit}`;
		this.report(entry, {
			requestId: "",
			status: 413,
			errorType: "request_too_large",
			message,
			retryAfter: null,
			accountId: null,
		});
		return jsonError(413, "request_too_large", message);
	}

	get liveTokens(): number {
		let n = 0;
		for (const entry of this.tokens.values()) if (!entry.revoked) n++;
		return n;
	}

	/** Start listening (once) and return the base URL for ANTHROPIC_BASE_URL. */
	ensureStarted(): string {
		if (!this.server)
			this.server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				idleTimeout: 0,
				fetch: (req) => this.handle(req),
			});
		return `http://127.0.0.1:${this.server.port}`;
	}

	register(context: SdkBridgeInnerContext): InnerRegistration {
		const token = `cmxsdk_${this.instanceId}_${randomBytes(32).toString("base64url")}`;
		const key = hash(token);
		const entry: TokenEntry = {
			context: Object.freeze({ ...context }),
			// Both forms of each planned model: Claude Code sends a `[1m]` model
			// without its suffix.
			models: new Set(
				context.plan.candidates.flatMap((c) => [
					c.upstreamModel,
					sdkBridgeWireModel(c.upstreamModel),
				]),
			),
			revoked: false,
		};
		this.tokens.set(key, entry);
		return {
			token,
			revoke: () => {
				entry.revoked = true;
				this.tokens.delete(key);
			},
		};
	}

	private report(entry: TokenEntry, outcome: SdkBridgeInnerOutcome): void {
		try {
			entry.context.onInnerOutcome?.(outcome);
		} catch (error) {
			this.opts.log.warn("SDK bridge inner outcome handler failed", error);
		}
	}

	private credential(req: Request): string | null {
		const auth = req.headers.get("authorization");
		if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
		return req.headers.get("x-api-key");
	}

	async handle(req: Request): Promise<Response> {
		const url = new URL(req.url);
		if (req.method === "HEAD" && url.pathname === "/api/hello")
			return new Response(null, { status: 204 });
		if (req.method !== "POST" || !MESSAGES_PATHS.has(url.pathname))
			return jsonError(
				404,
				"not_found_error",
				`${req.method} ${url.pathname} is not served here`,
			);
		const token = this.credential(req);
		const key =
			token?.startsWith(`cmxsdk_${this.instanceId}_`) === true
				? hash(token)
				: null;
		const entry = key ? this.tokens.get(key) : undefined;
		const unauthorized = () =>
			jsonError(
				401,
				"authentication_error",
				"Unknown or revoked SDK bridge token",
			);
		if (!key || !entry || entry.revoked) return unauthorized();
		const limit = this.opts.maxBodyBytes();
		const declared = Number(req.headers.get("content-length"));
		if (Number.isFinite(declared) && declared > limit)
			return this.tooLarge(entry, limit, declared);
		let bytes: Uint8Array | null;
		try {
			bytes = await this.readBounded(req, limit);
		} catch (error) {
			if (req.signal.aborted) return new Response(null, { status: 499 });
			throw error;
		}
		// The turn may have ended while the body arrived. Nothing awaits between
		// here and the dispatch, so a call that passes this check is the turn's.
		if (entry.revoked || this.tokens.get(key) !== entry) return unauthorized();
		if (!bytes) return this.tooLarge(entry, limit, null);
		const body = new TextDecoder().decode(bytes);
		let model: unknown;
		try {
			model = (JSON.parse(body) as { model?: unknown }).model;
		} catch {
			this.report(entry, {
				requestId: "",
				status: 400,
				errorType: "invalid_request_error",
				message: "Body is not JSON",
				retryAfter: null,
				accountId: null,
			});
			return jsonError(400, "invalid_request_error", "Body is not JSON");
		}
		if (typeof model !== "string" || !entry.models.has(model)) {
			const message = `Model ${JSON.stringify(model)} is not a destination of this SDK bridge turn`;
			this.report(entry, {
				requestId: "",
				status: 400,
				errorType: "invalid_request_error",
				message,
				retryAfter: null,
				accountId: null,
			});
			return jsonError(400, "invalid_request_error", message);
		}
		const headers = new Headers();
		for (const [name, value] of req.headers) {
			const lower = name.toLowerCase();
			if (STRIPPED_HEADERS.has(lower) || lower.startsWith("x-clankermux-"))
				continue;
			headers.set(name, value);
		}
		const inner = new Request(url, {
			method: "POST",
			headers,
			body,
			signal: req.signal,
		});
		let response: Response;
		try {
			response = await this.opts.dispatchInner(inner, entry.context);
		} catch (error) {
			if (req.signal.aborted) return new Response(null, { status: 499 });
			this.opts.log.error("SDK bridge inner dispatch failed", error);
			this.report(entry, {
				requestId: "",
				status: 502,
				errorType: "api_error",
				message: "The proxy failed to serve Claude Code's model call",
				retryAfter: null,
				accountId: null,
			});
			return jsonError(
				502,
				"api_error",
				"The proxy failed to serve this model call",
			);
		}
		if (response.status !== 403) return response;
		// Claude Code reads a 403 as a credential problem and reports "Failed to
		// authenticate"; the proxy recorded the real 403, so the child gets a
		// plain refusal that ends the turn with the proxy's own message.
		const text = await response.text();
		let message = "The request was refused";
		try {
			const parsed = JSON.parse(text) as { error?: { message?: unknown } };
			if (typeof parsed.error?.message === "string")
				message = parsed.error.message;
		} catch {}
		return jsonError(400, "invalid_request_error", message);
	}

	stop(): void {
		for (const entry of this.tokens.values()) entry.revoked = true;
		this.tokens.clear();
		this.server?.stop(true);
		this.server = null;
	}
}
