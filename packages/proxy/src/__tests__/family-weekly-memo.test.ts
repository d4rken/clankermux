/**
 * Unit tests for the family-weekly exhaustion memo — the map that stops the
 * proxy re-asking an account for a model family whose weekly window a 429 just
 * told us is spent.
 *
 * Pure-function style with a fixed `NOW`, matching family-weekly-gate.test.ts:
 * every entry point takes `now` explicitly, so nothing here depends on the
 * clock.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	clearFamilyWeeklyExhausted,
	clearFamilyWeeklyExhaustedForAccount,
	getFamilyWeeklyExhaustedUntil,
	isFamilyWeeklyMemoExhausted,
	recordFamilyWeeklyExhausted,
	resetFamilyWeeklyMemoForTests,
} from "../family-weekly-memo";

const NOW = 1_000_000_000_000;
const HOUR = 3_600_000;
const ACCOUNT = "acc-1";
const OTHER_ACCOUNT = "acc-2";

describe("family-weekly memo", () => {
	beforeEach(resetFamilyWeeklyMemoForTests);
	afterEach(resetFamilyWeeklyMemoForTests);

	it("returns null for a pair it has never seen", () => {
		expect(getFamilyWeeklyExhaustedUntil(ACCOUNT, "fable", NOW)).toBeNull();
	});

	it("remembers a recorded exhaustion until its reset time", () => {
		recordFamilyWeeklyExhausted(ACCOUNT, "fable", NOW + 4 * HOUR, NOW);

		expect(getFamilyWeeklyExhaustedUntil(ACCOUNT, "fable", NOW)).toBe(
			NOW + 4 * HOUR,
		);
		expect(
			getFamilyWeeklyExhaustedUntil(ACCOUNT, "fable", NOW + 3 * HOUR),
		).toBe(NOW + 4 * HOUR);
	});

	// The whole point of the memo is to be family-scoped: the reactive rung
	// deliberately declines an account-wide cooldown so the account keeps serving
	// its other families, and the memo must not undo that.
	it("does not leak across families on the same account", () => {
		recordFamilyWeeklyExhausted(ACCOUNT, "fable", NOW + HOUR, NOW);

		expect(getFamilyWeeklyExhaustedUntil(ACCOUNT, "fable", NOW)).not.toBeNull();
		expect(getFamilyWeeklyExhaustedUntil(ACCOUNT, "opus", NOW)).toBeNull();
		expect(getFamilyWeeklyExhaustedUntil(ACCOUNT, "sonnet", NOW)).toBeNull();
	});

	it("does not leak across accounts for the same family", () => {
		recordFamilyWeeklyExhausted(ACCOUNT, "fable", NOW + HOUR, NOW);

		expect(
			getFamilyWeeklyExhaustedUntil(OTHER_ACCOUNT, "fable", NOW),
		).toBeNull();
	});

	it("expires exactly at the reset time", () => {
		const resetAt = NOW + HOUR;
		recordFamilyWeeklyExhausted(ACCOUNT, "fable", resetAt, NOW);

		expect(getFamilyWeeklyExhaustedUntil(ACCOUNT, "fable", resetAt - 1)).toBe(
			resetAt,
		);
		expect(getFamilyWeeklyExhaustedUntil(ACCOUNT, "fable", resetAt)).toBeNull();
		expect(
			getFamilyWeeklyExhaustedUntil(ACCOUNT, "fable", resetAt + 1),
		).toBeNull();
	});

	it("lets a later observation move the reset time outward", () => {
		recordFamilyWeeklyExhausted(ACCOUNT, "fable", NOW + HOUR, NOW);
		recordFamilyWeeklyExhausted(ACCOUNT, "fable", NOW + 5 * HOUR, NOW + 60_000);

		expect(
			getFamilyWeeklyExhaustedUntil(ACCOUNT, "fable", NOW + 2 * HOUR),
		).toBe(NOW + 5 * HOUR);
	});

	// A reset in the past describes a window that has already turned over, so it
	// must not be stored — otherwise the map fills with entries that are dead on
	// their first read.
	it("ignores a reset time at or before now", () => {
		recordFamilyWeeklyExhausted(ACCOUNT, "fable", NOW, NOW);
		expect(getFamilyWeeklyExhaustedUntil(ACCOUNT, "fable", NOW)).toBeNull();

		recordFamilyWeeklyExhausted(ACCOUNT, "fable", NOW - HOUR, NOW);
		expect(getFamilyWeeklyExhaustedUntil(ACCOUNT, "fable", NOW)).toBeNull();
	});

	it("ignores a non-finite reset time", () => {
		recordFamilyWeeklyExhausted(ACCOUNT, "fable", Number.NaN, NOW);
		recordFamilyWeeklyExhausted(
			OTHER_ACCOUNT,
			"fable",
			Number.POSITIVE_INFINITY,
			NOW,
		);

		expect(getFamilyWeeklyExhaustedUntil(ACCOUNT, "fable", NOW)).toBeNull();
		expect(
			getFamilyWeeklyExhaustedUntil(OTHER_ACCOUNT, "fable", NOW),
		).toBeNull();
	});

	it("forgets a pair when a later request proves the window open", () => {
		recordFamilyWeeklyExhausted(ACCOUNT, "fable", NOW + HOUR, NOW);
		clearFamilyWeeklyExhausted(ACCOUNT, "fable", NOW + 1);

		expect(getFamilyWeeklyExhaustedUntil(ACCOUNT, "fable", NOW)).toBeNull();
	});

	// A long request admitted while the window was still open can return its 2xx
	// after a shorter, concurrent one has already been refused and recorded the
	// exhaustion. The older success must not erase the newer finding.
	it("ignores a success that STARTED before the recorded 429", () => {
		const slowRequestStartedAt = NOW - 30_000;
		recordFamilyWeeklyExhausted(ACCOUNT, "fable", NOW + HOUR, NOW);

		clearFamilyWeeklyExhausted(ACCOUNT, "fable", slowRequestStartedAt);

		expect(getFamilyWeeklyExhaustedUntil(ACCOUNT, "fable", NOW)).toBe(
			NOW + HOUR,
		);
	});

	it("ignores a success that started at the same instant as the 429", () => {
		recordFamilyWeeklyExhausted(ACCOUNT, "fable", NOW + HOUR, NOW);
		clearFamilyWeeklyExhausted(ACCOUNT, "fable", NOW);

		expect(getFamilyWeeklyExhaustedUntil(ACCOUNT, "fable", NOW)).toBe(
			NOW + HOUR,
		);
	});

	// A reset further out than any real weekly window can only be a misread
	// header; storing it would outlast every window it might have meant, and a
	// value outside Date's range would throw when a log line formats it.
	it("ignores a reset beyond any plausible weekly horizon", () => {
		recordFamilyWeeklyExhausted(ACCOUNT, "fable", NOW + 60 * 24 * HOUR, NOW);
		expect(getFamilyWeeklyExhaustedUntil(ACCOUNT, "fable", NOW)).toBeNull();

		recordFamilyWeeklyExhausted(ACCOUNT, "fable", 8.7e15, NOW);
		expect(getFamilyWeeklyExhaustedUntil(ACCOUNT, "fable", NOW)).toBeNull();
	});

	it("keeps distinct pairs independent when many are recorded", () => {
		for (let i = 0; i < 50; i++) {
			recordFamilyWeeklyExhausted(
				`acc-${i}`,
				"fable",
				NOW + (i + 1) * 1000,
				NOW,
			);
		}

		expect(getFamilyWeeklyExhaustedUntil("acc-0", "fable", NOW)).toBe(
			NOW + 1000,
		);
		expect(getFamilyWeeklyExhaustedUntil("acc-49", "fable", NOW)).toBe(
			NOW + 50_000,
		);
	});
});

describe("clearFamilyWeeklyExhaustedForAccount", () => {
	beforeEach(resetFamilyWeeklyMemoForTests);
	afterEach(resetFamilyWeeklyMemoForTests);

	// Account removal is the only caller: a deleted id is never read again, so
	// without this its entries would sit in the map (and against the entry cap,
	// which DROPS new records when full) until an unrelated record after their
	// reset time sweeps them.
	it("clears every family for the account and nothing for other accounts", () => {
		recordFamilyWeeklyExhausted(ACCOUNT, "fable", NOW + HOUR, NOW);
		recordFamilyWeeklyExhausted(ACCOUNT, "opus", NOW + 2 * HOUR, NOW);
		recordFamilyWeeklyExhausted(OTHER_ACCOUNT, "fable", NOW + HOUR, NOW);

		clearFamilyWeeklyExhaustedForAccount(ACCOUNT);

		expect(getFamilyWeeklyExhaustedUntil(ACCOUNT, "fable", NOW)).toBeNull();
		expect(getFamilyWeeklyExhaustedUntil(ACCOUNT, "opus", NOW)).toBeNull();
		expect(getFamilyWeeklyExhaustedUntil(OTHER_ACCOUNT, "fable", NOW)).toBe(
			NOW + HOUR,
		);
	});

	it("is a no-op for an account with nothing recorded", () => {
		recordFamilyWeeklyExhausted(OTHER_ACCOUNT, "fable", NOW + HOUR, NOW);

		clearFamilyWeeklyExhaustedForAccount(ACCOUNT);

		expect(getFamilyWeeklyExhaustedUntil(OTHER_ACCOUNT, "fable", NOW)).toBe(
			NOW + HOUR,
		);
	});
});

describe("isFamilyWeeklyMemoExhausted", () => {
	beforeEach(resetFamilyWeeklyMemoForTests);
	afterEach(resetFamilyWeeklyMemoForTests);

	const anthropic = { id: ACCOUNT, provider: "anthropic" };

	it("resolves the family from the model string", () => {
		recordFamilyWeeklyExhausted(ACCOUNT, "fable", NOW + HOUR, NOW);

		expect(isFamilyWeeklyMemoExhausted(anthropic, "claude-fable-5", NOW)).toBe(
			true,
		);
		expect(
			isFamilyWeeklyMemoExhausted(anthropic, "claude-sonnet-4-5", NOW),
		).toBe(false);
	});

	it("is false for an account with nothing recorded", () => {
		expect(isFamilyWeeklyMemoExhausted(anthropic, "claude-fable-5", NOW)).toBe(
			false,
		);
	});

	it("is false for a non-Anthropic account and for an unresolvable model", () => {
		recordFamilyWeeklyExhausted(ACCOUNT, "fable", NOW + HOUR, NOW);

		expect(
			isFamilyWeeklyMemoExhausted(
				{ id: ACCOUNT, provider: "codex" },
				"claude-fable-5",
				NOW,
			),
		).toBe(false);
		expect(isFamilyWeeklyMemoExhausted(anthropic, null, NOW)).toBe(false);
		expect(isFamilyWeeklyMemoExhausted(anthropic, "not-a-model", NOW)).toBe(
			false,
		);
	});

	it("is false once the remembered window has reset", () => {
		recordFamilyWeeklyExhausted(ACCOUNT, "fable", NOW + HOUR, NOW);

		expect(
			isFamilyWeeklyMemoExhausted(anthropic, "claude-fable-5", NOW + 2 * HOUR),
		).toBe(false);
	});
});
