import { gunzipSync } from "node:zlib";

const MAX_FRAME = 16 * 1024 * 1024;

export class DevinRpcError extends Error {
	readonly status: number;
	constructor(
		readonly code: string,
		message: string,
		readonly retryAfterSeconds?: number,
	) {
		super(message);
		this.name = "DevinRpcError";
		this.status =
			(
				{
					resource_exhausted: 429,
					unauthenticated: 401,
					permission_denied: 403,
					invalid_argument: 400,
					not_found: 404,
					unavailable: 503,
					deadline_exceeded: 504,
				} as Record<string, number>
			)[code] ?? 502;
	}
}

export function encodeConnect(bytes: Uint8Array, flags = 0): Uint8Array {
	const result = new Uint8Array(bytes.length + 5);
	result[0] = flags;
	new DataView(result.buffer).setUint32(1, bytes.length);
	result.set(bytes, 5);
	return result;
}

/** Consume bounded Connect envelopes. End-stream JSON is required even after a model stop. */
export async function* decodeConnect(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
	const reader = body.getReader();
	const abort = () => {
		void reader.cancel(signal?.reason).catch(() => {});
	};
	if (signal?.aborted) abort();
	signal?.addEventListener("abort", abort, { once: true });
	let pending: Uint8Array = new Uint8Array();
	let ended = false;
	try {
		while (!ended) {
			const { value, done } = await reader.read();
			signal?.throwIfAborted();
			if (done) {
				if (pending.length)
					throw new DevinRpcError("data_loss", "Devin Connect frame truncated");
				throw new DevinRpcError(
					"data_loss",
					"Devin stream missing end-stream envelope",
				);
			}
			pending = pending.length ? Buffer.concat([pending, value]) : value;
			while (pending.length >= 5) {
				const flags = pending[0] ?? 0;
				const length = new DataView(
					pending.buffer,
					pending.byteOffset,
					pending.byteLength,
				).getUint32(1);
				if (length > MAX_FRAME)
					throw new DevinRpcError(
						"data_loss",
						"Devin Connect frame exceeds size limit",
					);
				if (flags & ~3)
					throw new DevinRpcError(
						"data_loss",
						"Unsupported Devin Connect frame flags",
					);
				if (pending.length < length + 5) break;
				let payload = pending.subarray(5, length + 5);
				pending = pending.subarray(length + 5);
				if (flags & 1)
					payload = gunzipSync(payload, { maxOutputLength: MAX_FRAME });
				if (flags & 2) {
					let trailer: unknown;
					try {
						trailer = JSON.parse(
							new TextDecoder("utf-8", { fatal: true }).decode(payload),
						);
					} catch {
						throw new DevinRpcError(
							"data_loss",
							"Invalid Devin Connect trailer",
						);
					}
					if (!trailer || typeof trailer !== "object" || Array.isArray(trailer))
						throw new DevinRpcError(
							"data_loss",
							"Invalid Devin Connect trailer",
						);
					if ("error" in trailer && trailer.error != null) {
						const error = trailer.error;
						if (!error || typeof error !== "object")
							throw new DevinRpcError(
								"data_loss",
								"Invalid Devin Connect error trailer",
							);
						const code =
							"code" in error && typeof error.code === "string"
								? error.code
								: "unknown";
						const message =
							"message" in error && typeof error.message === "string"
								? error.message.slice(0, 1000)
								: "Devin request failed";
						throw new DevinRpcError(code, message);
					}
					if (pending.length)
						throw new DevinRpcError(
							"data_loss",
							"Data after Devin Connect trailer",
						);
					ended = true;
					break;
				}
				yield payload;
			}
		}
	} finally {
		signal?.removeEventListener("abort", abort);
		try {
			void reader.cancel().catch(() => {});
		} catch {
			/* stream may already have failed */
		}
		reader.releaseLock();
	}
}
