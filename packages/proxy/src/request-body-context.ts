export type RequestJsonBody = Record<string, unknown>;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function encodeJson(body: RequestJsonBody): ArrayBuffer {
	const encoded = encoder.encode(JSON.stringify(body));
	// TextEncoder.encode() is specified to return a fresh, exactly-sized
	// Uint8Array, and does on Bun — so the slice below is a full duplicate of the
	// whole request body for nothing. Bodies here run to megabytes (p90 ~2.3 MB,
	// capped at 4 MiB), and this runs on every request whose body is patched, so
	// the copy is a meaningful share of per-request garbage.
	//
	// The guard is O(1) and the slice is kept rather than deleted, for a runtime
	// that hands back a shared or oversized buffer — unreachable on native Bun,
	// where encode() always returns a fresh exactly-sized ArrayBuffer, so treat
	// it as belt-and-braces rather than a live path.
	//
	// The `instanceof` is load-bearing and not redundant with the size checks:
	// an exactly-sized SharedArrayBuffer would satisfy both offset and length
	// conditions while still being unsafe to hand out as solely-owned memory.
	if (
		encoded.buffer instanceof ArrayBuffer &&
		encoded.byteOffset === 0 &&
		encoded.byteLength === encoded.buffer.byteLength
	) {
		return encoded.buffer;
	}
	return encoded.buffer.slice(
		encoded.byteOffset,
		encoded.byteOffset + encoded.byteLength,
	);
}

export class RequestBodyContext {
	readonly originalBuffer: ArrayBuffer | null;

	private currentBuffer: ArrayBuffer | null;
	private parsedBody: RequestJsonBody | null = null;
	private parseAttempted = false;
	private parseFailed = false;
	private dirty = false;

	constructor(buffer: ArrayBuffer | null) {
		this.originalBuffer = buffer;
		this.currentBuffer = buffer;
	}

	static fromParsed(
		originalBuffer: ArrayBuffer | null,
		body: RequestJsonBody,
	): RequestBodyContext {
		const context = new RequestBodyContext(originalBuffer);
		context.parsedBody = body;
		context.parseAttempted = true;
		context.parseFailed = false;
		context.markDirty();
		return context;
	}

	get isDirty(): boolean {
		return this.dirty;
	}

	get hasParseFailed(): boolean {
		this.getParsedJson();
		return this.parseFailed;
	}

	getParsedJson(): Readonly<RequestJsonBody> | null {
		if (this.parseAttempted) {
			return this.parsedBody;
		}

		this.parseAttempted = true;
		if (!this.currentBuffer) {
			return null;
		}

		try {
			const parsed = JSON.parse(decoder.decode(this.currentBuffer));
			if (typeof parsed !== "object" || parsed === null) {
				this.parseFailed = true;
				return null;
			}
			this.parsedBody = parsed as RequestJsonBody;
			return this.parsedBody;
		} catch {
			this.parseFailed = true;
			return null;
		}
	}

	getModel(): string | null {
		const body = this.getParsedJson();
		const model = body?.model;
		return typeof model === "string" ? model : null;
	}

	setModel(model: string): boolean {
		if (!this.parsedBody) {
			this.getParsedJson();
		}
		if (!this.parsedBody) return false;

		this.parsedBody.model = model;
		this.markDirty();
		return true;
	}

	/** Mutate the parsed body in-place via callback and mark dirty. */
	mutateParsedJson(fn: (body: RequestJsonBody) => void): boolean {
		const body =
			this.parsedBody ?? (this.getParsedJson() as RequestJsonBody | null);
		if (!body) return false;
		fn(body);
		this.markDirty();
		return true;
	}

	markDirty(): void {
		this.dirty = true;
	}

	getBuffer(): ArrayBuffer | null {
		if (!this.dirty) {
			return this.currentBuffer;
		}

		if (!this.parsedBody) {
			return this.currentBuffer;
		}

		this.currentBuffer = encodeJson(this.parsedBody);
		this.dirty = false;
		return this.currentBuffer;
	}

	// NOTE: shallow spread — nested objects (e.g. messages, system) are shared
	// references between parent and child contexts. Mutations to nested content
	// on the returned context will alias back into this context's parsedBody.
	// Safe as long as callers treat the child as write-once and discard the parent.
	withPatchedModel(model: string): RequestBodyContext | null {
		const body = this.getParsedJson();
		if (!body) return null;

		return RequestBodyContext.fromParsed(this.getBuffer(), {
			...body,
			model,
		});
	}
}
