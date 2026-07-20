import { describe, expect, it } from "bun:test";
import { closeAllSseStreams, registerSseCloser } from "../sse-registry";

describe("sse-registry", () => {
	it("invokes a registered closer and reports the count", () => {
		closeAllSseStreams(); // flush anything left over from other suites
		let calls = 0;
		registerSseCloser(() => {
			calls++;
		});
		expect(closeAllSseStreams()).toBe(1);
		expect(calls).toBe(1);
	});

	it("does not invoke a closer after unregister", () => {
		closeAllSseStreams();
		let calls = 0;
		const unregister = registerSseCloser(() => {
			calls++;
		});
		unregister();
		expect(closeAllSseStreams()).toBe(0);
		expect(calls).toBe(0);
	});

	it("returns 0 on a second closeAllSseStreams call", () => {
		closeAllSseStreams();
		registerSseCloser(() => {});
		expect(closeAllSseStreams()).toBe(1);
		expect(closeAllSseStreams()).toBe(0);
	});

	it("a throwing closer does not prevent the others from running", () => {
		closeAllSseStreams();
		let survivorCalls = 0;
		registerSseCloser(() => {
			throw new Error("boom");
		});
		registerSseCloser(() => {
			survivorCalls++;
		});
		expect(closeAllSseStreams()).toBe(2);
		expect(survivorCalls).toBe(1);
	});

	it("unregister after closeAllSseStreams does not throw", () => {
		closeAllSseStreams();
		const unregister = registerSseCloser(() => {});
		expect(closeAllSseStreams()).toBe(1);
		expect(() => unregister()).not.toThrow();
		// And it must not have resurrected anything.
		expect(closeAllSseStreams()).toBe(0);
	});
});
