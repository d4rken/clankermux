import {
	type ChatIngressContext,
	parseUpstreamError,
	setChatContext,
} from "@clankermux/types";
import {
	ChatError,
	chatErrorResponse,
	errorEnvelope,
	upstreamFailure,
} from "./errors";
import { translateChatRequest } from "./request";
import {
	type ChatChunk,
	type ChatToolDelta,
	type ChatUsage,
	chatChunks,
} from "./stream";

type HandleProxy = (
	req: Request,
	url: URL,
	ctx: unknown,
	keyId?: string | null,
	keyName?: string | null,
) => Promise<Response>;
const BODY_LIMIT = 16 * 1024 * 1024;
async function bounded(
	body: ReadableStream<Uint8Array> | null,
	limit: number,
	truncate = false,
): Promise<Uint8Array> {
	if (!body) return new Uint8Array();
	const reader = body.getReader(),
		chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const n = await reader.read();
			if (n.done) break;
			const take = Math.min(n.value.byteLength, limit - size);
			chunks.push(n.value.slice(0, take));
			size += take;
			if (take < n.value.byteLength || (truncate && size === limit)) {
				if (!truncate)
					throw new ChatError(
						"Request or response body exceeds the size limit",
						null,
						413,
						"body_too_large",
					);
				break;
			}
		}
	} finally {
		void reader.cancel().catch(() => {});
	}
	const result = new Uint8Array(size);
	let offset = 0;
	for (const c of chunks) {
		result.set(c, offset);
		offset += c.byteLength;
	}
	return result;
}
async function readRequest(req: Request): Promise<unknown> {
	let body = req.body;
	const encoding = req.headers.get("content-encoding")?.toLowerCase();
	if (encoding && encoding !== "identity") {
		if (encoding !== "gzip" && encoding !== "deflate")
			throw new ChatError(
				"Unsupported request content encoding",
				null,
				415,
				"unsupported_encoding",
			);
		body = body?.pipeThrough(new DecompressionStream(encoding)) ?? null;
	}
	try {
		return JSON.parse(
			new TextDecoder().decode(await bounded(body, BODY_LIMIT)),
		);
	} catch (e) {
		if (e instanceof ChatError) throw e;
		if (req.signal.aborted) throw e;
		throw new ChatError("Invalid JSON or compressed request body");
	}
}
async function proxyError(resp: Response): Promise<Response> {
	const raw = new TextDecoder().decode(
		await bounded(resp.body, 64 * 1024, true).catch(() => new Uint8Array()),
	);
	let type = "api_error",
		param: string | null = null,
		code: string | undefined,
		message: string | undefined;
	try {
		const e = JSON.parse(raw)?.error;
		if (typeof e?.message === "string" && e.message.trim())
			message = e.message.slice(0, 512);
		if (typeof e?.type === "string") type = e.type;
		if (typeof e?.param === "string") param = e.param;
		if (typeof e?.code === "string") code = e.code;
	} catch {}
	const headers = new Headers({ "content-type": "application/json" });
	const retry = resp.headers.get("retry-after");
	if (retry) headers.set("retry-after", retry);
	return new Response(
		JSON.stringify(
			errorEnvelope(
				message ?? parseUpstreamError(raw) ?? "Proxy request failed",
				type,
				code ?? type,
				param,
			),
		),
		{ status: resp.status, headers },
	);
}
function streamResponse(
	upstream: Response,
	ctx: ChatIngressContext,
	names: Map<string, string>,
	includeUsage: boolean,
	signal: AbortSignal,
): Response {
	const reader = upstream.body?.getReader();
	if (!reader) throw upstreamFailure("Missing upstream body");
	const iterator = chatChunks(reader, ctx, names),
		encoder = new TextEncoder();
	let closed = false;
	const cancel = () => {
		closed = true;
		void reader.cancel().catch(() => {});
	};
	const abort = () => cancel();
	signal.addEventListener("abort", abort, { once: true });
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (closed) {
				controller.close();
				signal.removeEventListener("abort", abort);
				return;
			}
			try {
				const next = await iterator.next();
				if (closed) {
					signal.removeEventListener("abort", abort);
					controller.close();
					return;
				}
				if (next.done) {
					closed = true;
					controller.close();
					signal.removeEventListener("abort", abort);
					return;
				}
				if (next.value === null) {
					controller.enqueue(encoder.encode(": keepalive\n\n"));
					return;
				}
				const c = next.value,
					{ usage, ...withoutUsage } = c;
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({ ...withoutUsage, ...(includeUsage ? { usage: null } : {}) })}\n\n`,
					),
				);
				if (c.choices[0]?.finish_reason) {
					if (includeUsage)
						controller.enqueue(
							encoder.encode(
								`data: ${JSON.stringify({ ...withoutUsage, choices: [], usage: usage ?? null })}\n\n`,
							),
						);
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					closed = true;
					controller.close();
					signal.removeEventListener("abort", abort);
					void reader.cancel().catch(() => {});
				}
			} catch (e) {
				if (!closed) {
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify(errorEnvelope(e instanceof ChatError ? e.message : "Upstream stream failed", "api_error", "invalid_upstream_response"))}\n\n`,
						),
					);
					closed = true;
					controller.close();
				}
				signal.removeEventListener("abort", abort);
				void reader.cancel().catch(() => {});
			}
		},
		async cancel() {
			cancel();
			signal.removeEventListener("abort", abort);
			await iterator.return(undefined);
		},
	});
	return new Response(body, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			"x-accel-buffering": "no",
		},
	});
}
async function jsonResponse(
	upstream: Response,
	ctx: ChatIngressContext,
	names: Map<string, string>,
	signal: AbortSignal,
): Promise<Response> {
	const reader = upstream.body?.getReader();
	if (!reader) throw upstreamFailure("Missing upstream body");
	const abort = () => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", abort, { once: true });
	let final: ChatChunk | undefined,
		content = "",
		reasoning = "",
		usage: ChatUsage | undefined,
		size = 0;
	const calls: ChatToolDelta[] = [];
	try {
		for await (const c of chatChunks(reader, ctx, names)) {
			if (signal.aborted) throw new Error("Client aborted");
			if (!c) continue;
			final = c;
			const d = c.choices[0]?.delta;
			content += d?.content ?? "";
			reasoning += d?.reasoning_content ?? "";
			for (const call of d?.tool_calls ?? []) {
				let target = calls[call.index];
				if (!target) {
					target = { index: call.index, function: {} };
					calls[call.index] = target;
				}
				if (call.id) target.id = call.id;
				if (call.type) target.type = call.type;
				if (call.function.name) target.function.name = call.function.name;
				if (call.function.arguments !== undefined)
					target.function.arguments =
						(target.function.arguments ?? "") + call.function.arguments;
			}
			size += JSON.stringify(c).length;
			if (size > BODY_LIMIT)
				throw upstreamFailure("Non-stream completion exceeds the size limit");
			if (c.usage) usage = c.usage;
		}
	} finally {
		signal.removeEventListener("abort", abort);
		void reader.cancel().catch(() => {});
	}
	if (!final?.choices[0]?.finish_reason)
		throw upstreamFailure("Missing terminal completion");
	return Response.json({
		id: final.id,
		object: "chat.completion",
		created: final.created,
		model: ctx.reportedModel ?? final.model,
		choices: [
			{
				index: 0,
				message: {
					role: "assistant",
					content: content || (calls.length ? null : ""),
					...(reasoning ? { reasoning_content: reasoning } : {}),
					...(calls.length
						? { tool_calls: calls.map(({ index: _index, ...call }) => call) }
						: {}),
				},
				finish_reason: final.choices[0].finish_reason,
			},
		],
		...(usage ? { usage } : {}),
	});
}
export async function handleChatCompletionsRequest(
	req: Request,
	url: URL,
	handleProxy: HandleProxy,
	proxyContext: unknown,
	apiKeyId?: string | null,
	apiKeyName?: string | null,
	defaultMaxTokens = 8192,
): Promise<Response> {
	try {
		const translated = translateChatRequest(await readRequest(req));
		if (!Number.isSafeInteger(defaultMaxTokens) || defaultMaxTokens < 1)
			throw new ChatError(
				"Invalid configured Chat output limit",
				null,
				500,
				"configuration_error",
			);
		const ctx: ChatIngressContext = {
			requirements: translated.requirements,
			defaultMaxTokens,
		};
		const messagesUrl = new URL(url);
		messagesUrl.pathname = "/v1/messages";
		const headers = new Headers(req.headers);
		headers.set("content-type", "application/json");
		headers.delete("content-length");
		headers.delete("content-encoding");
		if (!headers.has("anthropic-version"))
			headers.set("anthropic-version", "2023-06-01");
		headers.set("x-clankermux-deny-official-anthropic", "1");
		const synthetic = new Request(messagesUrl, {
			method: "POST",
			headers,
			body: JSON.stringify(translated.body),
			signal: req.signal,
		});
		setChatContext(synthetic, ctx);
		const upstream = await handleProxy(
			synthetic,
			messagesUrl,
			proxyContext,
			apiKeyId,
			apiKeyName,
		);
		if (req.signal.aborted) {
			void upstream.body?.cancel().catch(() => {});
			return new Response(null, { status: 499 });
		}
		if (upstream.status !== 200) return await proxyError(upstream);
		if (
			!upstream.body ||
			!upstream.headers.get("content-type")?.includes("text/event-stream")
		) {
			void upstream.body?.cancel().catch(() => {});
			throw upstreamFailure("Expected an upstream Messages event stream");
		}
		return translated.stream
			? streamResponse(
					upstream,
					ctx,
					translated.names,
					translated.includeUsage,
					req.signal,
				)
			: await jsonResponse(upstream, ctx, translated.names, req.signal);
	} catch (e) {
		if (req.signal.aborted) return new Response(null, { status: 499 });
		if (e instanceof ChatError) return chatErrorResponse(e);
		return chatErrorResponse(
			new ChatError("Chat proxy request failed", null, 502, "api_error"),
		);
	}
}
