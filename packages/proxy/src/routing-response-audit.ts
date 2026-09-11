import { Logger } from "@clankermux/logger";

const log = new Logger("routing-audit");
export interface RoutingResponseResult {
	reportedModel: string | null;
	error: string | null;
	modelRejected?: boolean;
}
/** Observe raw bytes on the consumer's stream, before any adapter can synthesize a model. */
export function observeRoutingResponse(
	response: Response,
	finish: (result: RoutingResponseResult) => Promise<void>,
): Response {
	const decoder = new TextDecoder();
	let sse = response.headers.get("content-type")?.includes("text/event-stream");
	let buffer = "";
	let reportedModel: string | null = null;
	let completed = false;
	let oversized = false;
	let droppingEvent = false;
	let modelRejected = false;
	let protocolSucceeded = false;
	let protocolError: string | null = null;
	const inspect = (text: string, framedEvent = false) => {
		try {
			const value = JSON.parse(text);
			if (isDefinitiveModelError(value, response.status)) modelRejected = true;
			if (framedEvent) {
				if (value?.type === "response.failed")
					protocolError = "Upstream response failed";
				else if (value?.type === "response.incomplete")
					protocolError = "Upstream response incomplete";
				else if (value?.type === "error")
					protocolError = "Upstream protocol error";
				else if (
					value?.type === "message_stop" ||
					(value?.type === "response.completed" &&
						value?.response?.status === "completed" &&
						!value.response.error)
				)
					protocolSucceeded = true;
			}
			const model =
				value?.model ?? value?.response?.model ?? value?.message?.model;
			if (typeof model === "string" && model.length > 0 && model.length <= 512)
				reportedModel = model;
		} catch {
			/* An event need not be JSON. */
		}
	};
	const inspectEvent = (event: string, framed = true) => {
		const data = event
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).replace(/^ /, ""))
			.join("\n");
		if (data) inspect(data, framed);
	};
	const consume = (text: string) => {
		if (oversized) return;
		buffer += text;
		if (!sse && /^(event:|data:)/.test(buffer)) sse = true;
		if (sse) {
			let boundary = /\r?\n\r?\n/.exec(buffer);
			while (boundary) {
				if (!droppingEvent && boundary.index <= 1024 * 1024)
					inspectEvent(buffer.slice(0, boundary.index));
				droppingEvent = false;
				buffer = buffer.slice(boundary.index + boundary[0].length);
				boundary = /\r?\n\r?\n/.exec(buffer);
			}
		}
		if (buffer.length > 1024 * 1024) {
			if (sse) droppingEvent = true;
			else oversized = true;
		}
		// Keep only enough bytes to recognize a split SSE frame boundary.
		if (droppingEvent) buffer = buffer.slice(-3);
		else if (oversized) buffer = "";
	};
	const done = async (error: string | null) => {
		if (completed) return;
		completed = true;
		consume(decoder.decode());
		if (!oversized && !droppingEvent) {
			if (sse) inspectEvent(buffer, false);
			else if (!sse) inspect(buffer);
		}
		try {
			await finish({
				reportedModel,
				// Clients may close immediately after the terminal SSE event,
				// aborting the upstream fetch before HTTP EOF. Keep real protocol
				// failures and pre-terminal transport failures visible.
				error: protocolError ?? (protocolSucceeded ? null : error),
				...(modelRejected ? { modelRejected: true } : {}),
			});
		} catch (failure) {
			log.warn("Could not persist routing response completion", failure);
		}
	};
	if (!response.body) {
		void done(null);
		return response;
	}
	const reader = response.body.getReader();
	return new Response(
		new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const next = await reader.read();
					if (next.done) {
						controller.close();
						void done(null);
					} else {
						if (!oversized)
							consume(decoder.decode(next.value, { stream: true }));
						controller.enqueue(next.value);
					}
				} catch (error) {
					controller.error(error);
					void done("Upstream response stream failed");
				}
			},
			async cancel(reason) {
				try {
					await reader.cancel(reason);
				} finally {
					await done("Response consumption canceled");
				}
			},
		}),
		{
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		},
	);
}

/** OpenRouter routing filters describe account/provider policy, not model membership. */
export function isModelRouteRestriction(
	value: unknown,
	status: number,
): boolean {
	if (![400, 403, 404].includes(status) || !value || typeof value !== "object")
		return false;
	const body = value as {
		metadata?: { failed_routing_step?: unknown; available_providers?: unknown };
		error?: {
			error_type?: string;
			metadata?: {
				failed_routing_step?: unknown;
				available_providers?: unknown;
			};
		};
	};
	const metadata = body.metadata ?? body.error?.metadata;
	return (
		!!metadata &&
		((typeof metadata.failed_routing_step === "string" &&
			metadata.failed_routing_step.length > 0) ||
			(body.error?.error_type === "not_found" &&
				Array.isArray(metadata.available_providers)))
	);
}

/** Only protocol error envelopes count; tool results and message content are data. */
export function isDefinitiveModelError(
	value: unknown,
	status: number,
): boolean {
	if (
		isModelRouteRestriction(value, status) ||
		![200, 400, 403, 404].includes(status) ||
		!value ||
		typeof value !== "object"
	)
		return false;
	const body = value as {
		error?: { code?: string; type?: string; message?: string };
		detail?: string;
		response?: { error?: { code?: string; type?: string; message?: string } };
	};
	const error = body.error ?? body.response?.error;
	const code =
		error && typeof error === "object" ? (error.code ?? error.type) : undefined;
	if (
		[
			"model_not_found",
			"model_not_supported",
			"model_not_entitled",
			"model_access_denied",
		].includes(code ?? "")
	)
		return true;
	// Codex/ChatGPT entitlement refusals use a top-level detail string.
	const message = String(error?.message ?? body.detail ?? "").toLowerCase();
	return (
		/\bmodel\b/.test(message) &&
		/not supported|not found|does not exist|not entitled|do not have access|not available for/.test(
			message,
		)
	);
}
