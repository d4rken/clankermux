import { decodeConnect } from "./connect";
import { GetChatMessageResponseSchema } from "./vendor/devin-proto";
import { fromBinary } from "./vendor/protobuf";

/**
 * The model Devin says it served, read from the response prefix before the
 * response is committed to the client.
 *
 * Devin speaks Connect protobuf, so it cannot use the SSE/JSON reader the other
 * providers share. It does report the served model — `actualModelUid` on
 * `GetChatMessageResponse` — but the existing channel for it
 * (`onReportedModel`, via `getDevinReportedModel`) only fills in as the client
 * consumes the stream, which is far too late to fail over.
 *
 * Bounded on all three axes and fails open: any decode error, truncation, or
 * bound expiring answers null, and the caller forwards unchanged.
 */

/** Devin puts `actualModelUid` on its first message; the rest absorb a lead-in. */
const MAX_ENVELOPES = 4;
const MAX_BYTES = 256 * 1024;

export async function peekDevinServedModel(
	response: Response,
	opts: { timeoutMs: number; signal?: AbortSignal } = { timeoutMs: 90_000 },
): Promise<string | null> {
	if (opts.timeoutMs <= 0 || response.status !== 200 || !response.body)
		return null;
	opts.signal?.throwIfAborted();
	const branch = response.clone().body;
	if (!branch) return null;
	const controller = new AbortController();
	const onOuterAbort = () => controller.abort(opts.signal?.reason);
	opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
	const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
	let bytes = 0;
	let envelopes = 0;
	try {
		// Breaking out of this loop calls the generator's return path, which
		// cancels its reader — so stopping early never trips the end-stream
		// check decodeConnect enforces for a fully consumed stream.
		for await (const payload of decodeConnect(branch, controller.signal)) {
			bytes += payload.length;
			if (bytes > MAX_BYTES) return null;
			const message = fromBinary(GetChatMessageResponseSchema, payload);
			if (message.actualModelUid) return message.actualModelUid;
			if (++envelopes >= MAX_ENVELOPES) return null;
		}
		return null;
	} catch (_error) {
		opts.signal?.throwIfAborted();
		// The forwarded twin still owns any transport error for normal handling.
		return null;
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onOuterAbort);
		controller.abort();
	}
}
