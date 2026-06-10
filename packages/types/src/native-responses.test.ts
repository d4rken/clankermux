import { describe, expect, it } from "bun:test";
import type { RequestMeta } from "./api";
import {
	getNativeResponsesMetaContext,
	getNativeResponsesRequestContext,
	type NativeResponsesContext,
	setNativeResponsesMetaContext,
	setNativeResponsesRequestContext,
} from "./native-responses";

function makeMeta(): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
	};
}

function makeContext(): NativeResponsesContext {
	return {
		nativeBody: JSON.stringify({ model: "gpt-5.5-codex", input: "hi" }),
		clientStream: true,
	};
}

describe("native Responses request side-channel (Request-keyed)", () => {
	it("round-trips a context set on a Request", () => {
		const req = new Request("https://proxy.local/v1/messages", {
			method: "POST",
		});
		const ctx = makeContext();
		setNativeResponsesRequestContext(req, ctx);
		expect(getNativeResponsesRequestContext(req)).toBe(ctx);
	});

	it("returns undefined for a Request without a context", () => {
		const req = new Request("https://proxy.local/v1/messages", {
			method: "POST",
		});
		expect(getNativeResponsesRequestContext(req)).toBeUndefined();
	});

	it("does not leak a context onto a different Request", () => {
		const reqA = new Request("https://proxy.local/v1/messages", {
			method: "POST",
		});
		const reqB = new Request("https://proxy.local/v1/messages", {
			method: "POST",
		});
		setNativeResponsesRequestContext(reqA, makeContext());
		expect(getNativeResponsesRequestContext(reqB)).toBeUndefined();
	});
});

describe("native Responses meta side-channel (RequestMeta-keyed)", () => {
	it("round-trips a context set on a RequestMeta", () => {
		const meta = makeMeta();
		const ctx = makeContext();
		setNativeResponsesMetaContext(meta, ctx);
		expect(getNativeResponsesMetaContext(meta)).toBe(ctx);
	});

	it("returns undefined for a RequestMeta without a context", () => {
		expect(getNativeResponsesMetaContext(makeMeta())).toBeUndefined();
	});

	it("does not leak a context onto a different RequestMeta", () => {
		const metaA = makeMeta();
		const metaB = makeMeta();
		setNativeResponsesMetaContext(metaA, makeContext());
		expect(getNativeResponsesMetaContext(metaB)).toBeUndefined();
	});
});
