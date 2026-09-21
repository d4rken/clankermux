import { describe, expect, it } from "bun:test";
import { createPinnedTargetUnavailableResponse } from "../proxy-operations";

const FAILURE = {
	code: "pinned_account_unavailable",
	message: "The pinned account is unavailable.",
};

describe("createPinnedTargetUnavailableResponse", () => {
	it("paces its retryable 503 with the caller's advice", async () => {
		const res = createPinnedTargetUnavailableResponse(FAILURE, 23);

		expect(res.status).toBe(503);
		expect(res.headers.get("Retry-After")).toBe("23");
		expect(res.headers.get("x-clankermux-pool-status")).toBe(
			"pinned-target-unavailable",
		);

		const body = (await res.json()) as {
			error: { type: string; availability_guaranteed: boolean };
		};
		expect(body.error.type).toBe("pinned_account_unavailable");
		// A pin can stay unsatisfiable well past the interval.
		expect(body.error.availability_guaranteed).toBe(false);
	});

	it("falls back to the default interval when the caller knows no deadline", () => {
		const res = createPinnedTargetUnavailableResponse(FAILURE);
		expect(res.headers.get("Retry-After")).toBe("60");
	});
});
