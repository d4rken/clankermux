import { describe, expect, it } from "bun:test";
import type { DatabaseRetryConfig } from "../database-operations";
import { withRetryingMethods } from "../retry";

/** Retryable per `RETRYABLE_SQLITE_ERRORS` in retry.ts. */
function busyError(): Error {
	return new Error("database is locked");
}

const FAST: DatabaseRetryConfig = {
	attempts: 3,
	delayMs: 1,
	backoff: 1,
	maxDelayMs: 5,
};

describe("withRetryingMethods", () => {
	it("retries a method that fails with a retryable error, then succeeds", async () => {
		let calls = 0;
		const repo = {
			async find(): Promise<string> {
				calls++;
				if (calls < 3) throw busyError();
				return "ok";
			},
		};

		const wrapped = withRetryingMethods(repo, () => FAST, "repo");

		expect(await wrapped.find()).toBe("ok");
		expect(calls).toBe(3);
	});

	it("does not retry a non-retryable error", async () => {
		let calls = 0;
		const repo = {
			async find(): Promise<string> {
				calls++;
				throw new Error("CHECK constraint failed");
			},
		};

		const wrapped = withRetryingMethods(repo, () => FAST, "repo");

		await expect(wrapped.find()).rejects.toThrow("CHECK constraint failed");
		expect(calls).toBe(1);
	});

	it("gives up after the configured attempt count", async () => {
		let calls = 0;
		const repo = {
			async find(): Promise<string> {
				calls++;
				throw busyError();
			},
		};

		const wrapped = withRetryingMethods(repo, () => FAST, "repo");

		await expect(wrapped.find()).rejects.toThrow("database is locked");
		expect(calls).toBe(3);
	});

	it("reads the retry config lazily, so setRuntimeConfig() takes effect", async () => {
		// DatabaseOperations replaces `retryConfig` after construction. Capturing
		// the object at wrap time would pin repositories to the pre-runtime
		// defaults, so the thunk must be re-read on every call.
		let config: DatabaseRetryConfig = { ...FAST, attempts: 1 };
		let calls = 0;
		const repo = {
			async find(): Promise<string> {
				calls++;
				throw busyError();
			},
		};

		const wrapped = withRetryingMethods(repo, () => config, "repo");

		await expect(wrapped.find()).rejects.toThrow();
		expect(calls).toBe(1);

		config = { ...FAST, attempts: 4 };
		calls = 0;

		await expect(wrapped.find()).rejects.toThrow();
		expect(calls).toBe(4);
	});

	it("binds `this` to the raw target so sibling calls are not re-wrapped", async () => {
		// An internal call must stay inside the single retry envelope opened by
		// the outbound call. If `this` were the proxy, `outer` retrying 3x while
		// `inner` retries 3x per attempt would run the statement 9 times.
		let innerCalls = 0;
		const repo = {
			async inner(): Promise<string> {
				innerCalls++;
				throw busyError();
			},
			async outer(): Promise<string> {
				return this.inner();
			},
		};

		const wrapped = withRetryingMethods(repo, () => FAST, "repo");

		await expect(wrapped.outer()).rejects.toThrow("database is locked");
		expect(innerCalls).toBe(3); // 3 outer attempts x 1 inner call, not 9
	});

	it("returns a stable function identity across property reads", () => {
		const repo = {
			async find(): Promise<string> {
				return "ok";
			},
		};

		const wrapped = withRetryingMethods(repo, () => FAST, "repo");

		expect(wrapped.find).toBe(wrapped.find);
	});

	it("passes arguments through and returns the resolved value", async () => {
		const repo = {
			async add(a: number, b: number): Promise<number> {
				return a + b;
			},
		};

		const wrapped = withRetryingMethods(repo, () => FAST, "repo");

		expect(await wrapped.add(2, 3)).toBe(5);
	});

	it("leaves non-function properties untouched", () => {
		const repo = { label: "accounts", count: 7 };

		const wrapped = withRetryingMethods(repo, () => FAST, "repo");

		expect(wrapped.label).toBe("accounts");
		expect(wrapped.count).toBe(7);
	});

	it("retries a method that throws synchronously before returning a promise", async () => {
		let calls = 0;
		const repo = {
			find(): Promise<string> {
				calls++;
				if (calls < 2) throw busyError();
				return Promise.resolve("ok");
			},
		};

		const wrapped = withRetryingMethods(repo, () => FAST, "repo");

		expect(await wrapped.find()).toBe("ok");
		expect(calls).toBe(2);
	});
});
