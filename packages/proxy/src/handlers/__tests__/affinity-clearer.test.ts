import { describe, expect, it } from "bun:test";
import {
	clearAccountAffinity,
	registerAffinityClearer,
} from "../token-manager";

// `registerAffinityClearer` / `clearAccountAffinity` operate on a module-level
// singleton registry shared across every test file in a single `bun test` run.
// To stay independent of clearers registered by other files, each test uses a
// unique account id that only its own clearers respond to, and asserts the
// delta its clearers contribute rather than an absolute total.

describe("affinity clearer registry", () => {
	it("sums cleared pins across all registered servers", () => {
		const ACCT = "affinity-sum-acct";
		registerAffinityClearer("affinity-test-srv-a", (id) =>
			id === ACCT ? 2 : 0,
		);
		registerAffinityClearer("affinity-test-srv-b", (id) =>
			id === ACCT ? 3 : 0,
		);

		// Only our two clearers match ACCT (= 5); foreign clearers return 0 for it.
		expect(clearAccountAffinity(ACCT)).toBe(5);
	});

	it("replacing a server's clearer overwrites the previous one", () => {
		const ACCT = "affinity-replace-acct";
		registerAffinityClearer("affinity-test-srv-replace", (id) =>
			id === ACCT ? 7 : 0,
		);
		const before = clearAccountAffinity(ACCT);
		registerAffinityClearer("affinity-test-srv-replace", (id) =>
			id === ACCT ? 1 : 0,
		);
		const after = clearAccountAffinity(ACCT);

		// The second registration for the same server id replaced the first, so
		// our contribution drops by 6 regardless of any foreign clearers.
		expect(before - after).toBe(6);
	});

	it("isolates a throwing clearer — others still contribute", () => {
		const ACCT = "affinity-isolate-acct";
		registerAffinityClearer("affinity-test-srv-throws", (id) => {
			if (id === ACCT) throw new Error("boom");
			return 0;
		});
		registerAffinityClearer("affinity-test-srv-ok", (id) =>
			id === ACCT ? 4 : 0,
		);

		// The throwing clearer is caught; the healthy one still adds its 4.
		expect(clearAccountAffinity(ACCT)).toBe(4);
	});
});
