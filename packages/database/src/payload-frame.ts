/**
 * Plaintext layout of a binary request payload: the envelope JSON with both
 * bodies lifted out as raw bytes, so neither is base64-inflated before zstd.
 *
 *   [u32le skeleton bytes][u32le request bytes][u32le response bytes]
 *   skeleton (UTF-8 envelope JSON, `request.body` and `response.body` null)
 *   request body bytes
 *   response body bytes
 *
 * A body length of NULL_BODY (0xffffffff) means the envelope's body is null;
 * an empty body is stored as null too, matching the text envelope. For example
 * a request body "hi" and no response body:
 *
 *   32000000 02000000 ffffffff
 *   {"request":{"body":null},"response":{"body":null}}
 *   6869
 *
 * {@link envelopeFromPayloadFrame} rebuilds the envelope the text format
 * stored, base64 bodies included, so readers see the same object either way.
 */

const HEADER_BYTES = 12;
const NULL_BODY = 0xffffffff;

export interface PayloadEnvelope {
	request: { body: string | null; [key: string]: unknown };
	response: { body: string | null; [key: string]: unknown };
	[key: string]: unknown;
}

/** The size {@link buildPayloadFrame} allocates for these parts. */
export function payloadFrameBytes(
	skeleton: string,
	requestBody: Uint8Array | null,
	responseChunks: readonly Uint8Array[],
): number {
	return (
		HEADER_BYTES +
		Buffer.byteLength(skeleton, "utf8") +
		(requestBody?.byteLength ?? 0) +
		chunksBytes(responseChunks)
	);
}

/**
 * Build a frame in one exactly-sized allocation the caller owns outright.
 * `skeleton` must already carry `body: null` in both places.
 */
export function buildPayloadFrame(
	skeleton: string,
	requestBody: Uint8Array | null,
	responseChunks: readonly Uint8Array[],
): Uint8Array<ArrayBuffer> {
	const skeletonBytes = Buffer.byteLength(skeleton, "utf8");
	const requestBytes = requestBody?.byteLength ?? 0;
	const responseBytes = chunksBytes(responseChunks);

	const frame = new Uint8Array(
		HEADER_BYTES + skeletonBytes + requestBytes + responseBytes,
	);
	const header = new DataView(frame.buffer);
	header.setUint32(0, skeletonBytes, true);
	header.setUint32(4, requestBytes > 0 ? requestBytes : NULL_BODY, true);
	header.setUint32(8, responseBytes > 0 ? responseBytes : NULL_BODY, true);

	let offset = HEADER_BYTES;
	const written = new TextEncoder().encodeInto(
		skeleton,
		frame.subarray(offset, offset + skeletonBytes),
	).written;
	if (written !== skeletonBytes) {
		throw new Error("Payload skeleton did not encode to its UTF-8 length");
	}
	offset += skeletonBytes;
	if (requestBody && requestBytes > 0) {
		frame.set(requestBody, offset);
		offset += requestBytes;
	}
	for (const chunk of responseChunks) {
		frame.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return frame;
}

/**
 * Parse a frame back into the envelope. Throws when the header lengths do not
 * account for the frame exactly or the skeleton is not an envelope with null
 * body slots: a frame that fails either is corrupt, never a legacy row.
 */
export function envelopeFromPayloadFrame(frame: Uint8Array): PayloadEnvelope {
	if (frame.byteLength < HEADER_BYTES) {
		throw new Error("Payload frame is shorter than its header");
	}
	const header = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
	const skeletonBytes = header.getUint32(0, true);
	const requestBytes = header.getUint32(4, true);
	const responseBytes = header.getUint32(8, true);
	const requestLen = requestBytes === NULL_BODY ? 0 : requestBytes;
	const responseLen = responseBytes === NULL_BODY ? 0 : responseBytes;
	if (
		HEADER_BYTES + skeletonBytes + requestLen + responseLen !==
		frame.byteLength
	) {
		throw new Error("Payload frame lengths do not match its size");
	}
	// Builders write an empty body as NULL_BODY; a zero length is corruption.
	if (requestBytes === 0 || responseBytes === 0) {
		throw new Error("Payload frame has a zero-length body");
	}

	let offset = HEADER_BYTES;
	const skeleton = JSON.parse(
		Buffer.from(
			frame.buffer,
			frame.byteOffset + offset,
			skeletonBytes,
		).toString("utf8"),
	) as unknown;
	offset += skeletonBytes;
	if (!isEnvelopeSkeleton(skeleton)) {
		throw new Error("Payload frame skeleton is not an envelope");
	}

	skeleton.request.body =
		requestBytes === NULL_BODY
			? null
			: Buffer.from(
					frame.buffer,
					frame.byteOffset + offset,
					requestLen,
				).toString("base64");
	offset += requestLen;
	skeleton.response.body =
		responseBytes === NULL_BODY
			? null
			: Buffer.from(
					frame.buffer,
					frame.byteOffset + offset,
					responseLen,
				).toString("base64");
	return skeleton;
}

function chunksBytes(chunks: readonly Uint8Array[]): number {
	let total = 0;
	for (const chunk of chunks) total += chunk.byteLength;
	return total;
}

function isEnvelopeSkeleton(value: unknown): value is PayloadEnvelope {
	if (!isPlainObject(value)) return false;
	const { request, response } = value;
	return (
		isPlainObject(request) &&
		isPlainObject(response) &&
		request.body === null &&
		response.body === null
	);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
