import { describe, expect, it } from "bun:test";
import { resolveRefreshUsageError } from "../refresh-usage";

describe("resolveRefreshUsageError", () => {
	it("returns the server-supplied message when the refresh failed", () => {
		expect(
			resolveRefreshUsageError({
				success: false,
				message: "Codex usage read failed for 'codex-1' (status 401).",
			}),
		).toBe("Codex usage read failed for 'codex-1' (status 401).");
	});

	it("falls back to a generic message when the failure carries none", () => {
		expect(resolveRefreshUsageError({ success: false })).toBe(
			"Usage refresh failed",
		);
	});

	it("treats an empty message as absent", () => {
		expect(resolveRefreshUsageError({ success: false, message: "" })).toBe(
			"Usage refresh failed",
		);
	});

	it("returns null on success", () => {
		expect(
			resolveRefreshUsageError({ success: true, message: "Usage refreshed." }),
		).toBeNull();
	});

	it("returns null on success even without a message", () => {
		expect(resolveRefreshUsageError({ success: true })).toBeNull();
	});
});
