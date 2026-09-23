import { Logger } from "@clankermux/logger";
import {
	getSdkBridgeInnerMetaContext,
	type RequestMeta,
	type SdkBridgeInnerOutcome,
} from "@clankermux/types";
import { sseFrameData } from "./routing-response-audit";

const log = new Logger("SdkBridgeInner");

const lastSentAccount = new WeakMap<RequestMeta, string>();
const rowStarted = new WeakSet<RequestMeta>();

/** Called for every authorized send, so the report names the account last tried. */
export function noteSdkBridgeInnerSend(
	meta: RequestMeta,
	accountId: string,
): void {
	if (getSdkBridgeInnerMetaContext(meta)) lastSentAccount.set(meta, accountId);
}

/**
 * The inner call's `requests` row has begun: what the turn's inner call count
 * counts. Once per request, whichever recorder path writes the row.
 */
export function noteSdkBridgeInnerRequestStarted(meta: RequestMeta): void {
	const report = getSdkBridgeInnerMetaContext(meta)?.onInnerRequestStarted;
	if (!report || rowStarted.has(meta)) return;
	rowStarted.add(meta);
	try {
		report(meta.id);
	} catch (error) {
		log.warn("SDK bridge inner request callback failed", error);
	}
}

function deliver(meta: RequestMeta, outcome: SdkBridgeInnerOutcome): void {
	const report = getSdkBridgeInnerMetaContext(meta)?.onInnerOutcome;
	if (!report) return;
	try {
		report(outcome);
	} catch (error) {
		log.warn("SDK bridge inner outcome callback failed", error);
	}
}

/** The status an Anthropic stream `error` event stands for. */
function streamErrorStatus(type: string | null): number {
	if (type === "rate_limit_error") return 429;
	if (type === "overloaded_error") return 529;
	if (type === "api_error") return 500;
	return 502;
}

/** Frames larger than this are skipped, never buffered whole. */
const MAX_FRAME_CHARS = 1024 * 1024;

/**
 * Watch an Anthropic SSE body on its way to Claude Code and report how it
 * really ended, exactly once: an `error` event with the status its type
 * stands for, a stream that ends (or fails, or is cancelled) before
 * `message_stop` as a 502, and a complete one as the response's own status.
 */
function reportWhenStreamEnds(
	response: Response,
	base: Omit<SdkBridgeInnerOutcome, "status" | "errorType" | "message">,
	meta: RequestMeta,
): Response {
	const body = response.body;
	if (!body) {
		deliver(meta, {
			...base,
			status: 502,
			errorType: "api_error",
			message: "The stream had no body",
		});
		return response;
	}
	const decoder = new TextDecoder();
	let buffer = "";
	let skipping = false;
	let sawStop = false;
	let streamError: { status: number; type: string; message: string } | null =
		null;
	let reported = false;
	const inspect = (frame: string) => {
		const data = sseFrameData(frame);
		if (!data) return;
		let event: {
			type?: unknown;
			error?: { type?: unknown; message?: unknown };
		};
		try {
			event = JSON.parse(data);
		} catch {
			return;
		}
		if (event?.type === "message_stop") sawStop = true;
		else if (event?.type === "error" && !streamError) {
			const type =
				typeof event.error?.type === "string" ? event.error.type : null;
			streamError = {
				status: streamErrorStatus(type),
				type: type ?? "api_error",
				message:
					typeof event.error?.message === "string"
						? event.error.message
						: "The upstream stream failed",
			};
		}
	};
	const consume = (text: string) => {
		buffer += text;
		let boundary = /\r?\n\r?\n/.exec(buffer);
		while (boundary) {
			if (!skipping) inspect(buffer.slice(0, boundary.index));
			skipping = false;
			buffer = buffer.slice(boundary.index + boundary[0].length);
			boundary = /\r?\n\r?\n/.exec(buffer);
		}
		if (buffer.length > MAX_FRAME_CHARS) {
			skipping = true;
			// Keep enough to recognise a boundary split across chunks.
			buffer = buffer.slice(-3);
		}
	};
	const report = (ended: "eof" | "failed" | "cancelled") => {
		if (reported) return;
		reported = true;
		if (ended === "eof") {
			consume(decoder.decode());
			if (!skipping && buffer.trim()) inspect(buffer);
		}
		const error = streamError as {
			status: number;
			type: string;
			message: string;
		} | null;
		if (error) {
			deliver(meta, {
				...base,
				status: error.status,
				errorType: error.type,
				message: error.message,
			});
			return;
		}
		if (!sawStop) {
			deliver(meta, {
				...base,
				status: 502,
				errorType: "api_error",
				message:
					ended === "cancelled"
						? "The stream was cancelled before message_stop"
						: "The upstream stream ended before message_stop",
			});
			return;
		}
		deliver(meta, {
			...base,
			status: response.status,
			errorType: null,
			message: null,
		});
	};
	const reader = body.getReader();
	return new Response(
		new ReadableStream<Uint8Array>({
			async pull(controller) {
				let next: Awaited<ReturnType<typeof reader.read>>;
				try {
					next = await reader.read();
				} catch (error) {
					report("failed");
					controller.error(error);
					return;
				}
				if (next.done) {
					report("eof");
					controller.close();
					return;
				}
				consume(decoder.decode(next.value, { stream: true }));
				controller.enqueue(next.value);
			},
			async cancel(reason) {
				report("cancelled");
				await reader.cancel(reason).catch(() => {});
			},
		}),
		{
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		},
	);
}

/**
 * Tell the bridge how one of its inner calls ended, and return the response
 * to hand Claude Code in place of `response`. A 2xx SSE reply is reported
 * when its stream ends, from what it carried (see reportWhenStreamEnds); any
 * other reply at once, an error body read from a clone.
 */
export function reportSdkBridgeInnerResponse(
	meta: RequestMeta,
	response: Response,
): Response {
	if (!getSdkBridgeInnerMetaContext(meta)?.onInnerOutcome) return response;
	const base = {
		requestId: meta.id,
		retryAfter: response.headers.get("retry-after"),
		accountId: lastSentAccount.get(meta) ?? null,
	};
	const contentType = response.headers.get("content-type") ?? "";
	if (response.ok && contentType.includes("text/event-stream"))
		return reportWhenStreamEnds(response, base, meta);
	if (response.ok || !contentType.includes("application/json")) {
		deliver(meta, {
			...base,
			status: response.status,
			errorType: null,
			message: null,
		});
		return response;
	}
	void response
		.clone()
		.json()
		.then(
			(body: { error?: { type?: unknown; message?: unknown } }) => ({
				errorType:
					typeof body?.error?.type === "string" ? body.error.type : null,
				message:
					typeof body?.error?.message === "string" ? body.error.message : null,
			}),
			() => ({ errorType: null, message: null }),
		)
		.then((detail) =>
			deliver(meta, { ...base, status: response.status, ...detail }),
		);
	return response;
}

/** The same report for a request that ended in a thrown give-up terminal. */
export function reportSdkBridgeInnerFailure(
	meta: RequestMeta,
	error: unknown,
): void {
	const failure = error as {
		statusCode?: unknown;
		retryAfterSeconds?: unknown;
		name?: unknown;
		message?: unknown;
	} | null;
	deliver(meta, {
		requestId: meta.id,
		status: typeof failure?.statusCode === "number" ? failure.statusCode : 500,
		errorType: typeof failure?.name === "string" ? failure.name : null,
		message: typeof failure?.message === "string" ? failure.message : null,
		retryAfter:
			typeof failure?.retryAfterSeconds === "number"
				? String(failure.retryAfterSeconds)
				: null,
		accountId: lastSentAccount.get(meta) ?? null,
	});
}
