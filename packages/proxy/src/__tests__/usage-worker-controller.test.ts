import { describe, expect, it } from "bun:test";
import { resolveUsageWorkerSource } from "../usage-worker-controller";

const workerUrl = new URL("file:///tmp/post-processor.worker.ts");

describe("resolveUsageWorkerSource", () => {
	it("prefers source worker code when the source file exists", () => {
		const source = resolveUsageWorkerSource({
			embeddedCode: "embedded-worker",
			env: {},
			sourceExists: () => true,
			workerUrl,
		});

		expect(source).toEqual({ kind: "source", url: workerUrl.href });
	});

	it("falls back to embedded worker code when source is unavailable", () => {
		const source = resolveUsageWorkerSource({
			embeddedCode: "embedded-worker",
			env: {},
			sourceExists: () => false,
			workerUrl,
		});

		expect(source).toEqual({ kind: "embedded", code: "embedded-worker" });
	});

	it("supports forcing the embedded worker through env", () => {
		const source = resolveUsageWorkerSource({
			embeddedCode: "embedded-worker",
			env: { CLANKERMUX_USE_EMBEDDED_WORKER: "true" },
			sourceExists: () => true,
			workerUrl,
		});

		expect(source).toEqual({ kind: "embedded", code: "embedded-worker" });
	});

	it("supports forcing the source worker through env", () => {
		const source = resolveUsageWorkerSource({
			embeddedCode: "embedded-worker",
			env: { CLANKERMUX_USE_EMBEDDED_WORKER: "false" },
			sourceExists: () => false,
			workerUrl,
		});

		expect(source).toEqual({ kind: "source", url: workerUrl.href });
	});
});
