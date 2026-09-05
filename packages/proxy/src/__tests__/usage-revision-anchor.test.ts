import { afterEach, describe, expect, it } from "bun:test";
import {
	clearUsageRevisionAnchors,
	getUsageRevisionAnchor,
	observeUsageReading,
	REVISION_MIN_DROP_PCT,
} from "../usage-revision-anchor";

const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const RESET = NOW + 3 * 24 * HOUR;

function feed(
	readings: Array<{
		pct: number | null;
		resetMs?: number | null;
		observedAtMs: number;
	}>,
	accountId = "acc",
	windowKind: "five_hour" | "seven_day" = "seven_day",
): void {
	for (const r of readings) {
		observeUsageReading(accountId, windowKind, {
			pct: r.pct,
			resetMs: r.resetMs === undefined ? RESET : r.resetMs,
			observedAtMs: r.observedAtMs,
		});
	}
}

afterEach(() => {
	clearUsageRevisionAnchors();
});

describe("usage revision anchors", () => {
	it("anchors at the post-drop reading when the reset stays put", () => {
		feed([
			{ pct: 60, observedAtMs: NOW },
			{ pct: 2, observedAtMs: NOW + 2 * MINUTE },
		]);

		expect(getUsageRevisionAnchor("acc", "seven_day", RESET)).toEqual({
			anchorMs: NOW + 2 * MINUTE,
			anchorPct: 2,
			windowResetMs: RESET,
		});
	});

	it("treats a drop concurrent with a reset move as a rollover, not a gift", () => {
		feed([
			{ pct: 60, observedAtMs: NOW },
			{
				pct: 2,
				resetMs: RESET + 7 * 24 * HOUR,
				observedAtMs: NOW + 2 * MINUTE,
			},
		]);

		expect(getUsageRevisionAnchor("acc", "seven_day", RESET)).toBeNull();
		expect(
			getUsageRevisionAnchor("acc", "seven_day", RESET + 7 * 24 * HOUR),
		).toBeNull();
	});

	it("tolerates sub-minute reset jitter while anchoring", () => {
		feed([
			{ pct: 60, observedAtMs: NOW },
			{ pct: 2, resetMs: RESET + 30_000, observedAtMs: NOW + 2 * MINUTE },
		]);

		const anchor = getUsageRevisionAnchor("acc", "seven_day", RESET);
		expect(anchor?.anchorPct).toBe(2);
	});

	it("anchors on a drop of exactly the revision threshold", () => {
		feed([
			{ pct: 60, observedAtMs: NOW },
			{ pct: 60 - REVISION_MIN_DROP_PCT, observedAtMs: NOW + 2 * MINUTE },
		]);

		expect(getUsageRevisionAnchor("acc", "seven_day", RESET)).toEqual({
			anchorMs: NOW + 2 * MINUTE,
			anchorPct: 55,
			windowResetMs: RESET,
		});
	});

	it("ignores drops below the revision threshold", () => {
		feed([
			{ pct: 60, observedAtMs: NOW },
			{
				pct: 60 - REVISION_MIN_DROP_PCT + 0.5,
				observedAtMs: NOW + 2 * MINUTE,
			},
		]);

		expect(getUsageRevisionAnchor("acc", "seven_day", RESET)).toBeNull();
	});

	it("keeps the LAST revision when several happen in one window", () => {
		feed([
			{ pct: 60, observedAtMs: NOW },
			{ pct: 10, observedAtMs: NOW + 2 * MINUTE },
			{ pct: 40, observedAtMs: NOW + HOUR },
			{ pct: 5, observedAtMs: NOW + HOUR + 2 * MINUTE },
		]);

		expect(getUsageRevisionAnchor("acc", "seven_day", RESET)).toEqual({
			anchorMs: NOW + HOUR + 2 * MINUTE,
			anchorPct: 5,
			windowResetMs: RESET,
		});
	});

	it("returns null for a binding reset that names another window", () => {
		feed([
			{ pct: 60, observedAtMs: NOW },
			{ pct: 2, observedAtMs: NOW + 2 * MINUTE },
		]);

		expect(
			getUsageRevisionAnchor("acc", "seven_day", RESET + 2 * HOUR),
		).toBeNull();
		expect(getUsageRevisionAnchor("acc", "seven_day", null)).toBeNull();
	});

	it("ignores out-of-order and duplicate observations", () => {
		feed([
			{ pct: 60, observedAtMs: NOW },
			{ pct: 2, observedAtMs: NOW + 2 * MINUTE },
			// A replayed older reading must not overwrite or re-trigger.
			{ pct: 60, observedAtMs: NOW },
			{ pct: 2, observedAtMs: NOW + 2 * MINUTE },
		]);

		expect(getUsageRevisionAnchor("acc", "seven_day", RESET)).toEqual({
			anchorMs: NOW + 2 * MINUTE,
			anchorPct: 2,
			windowResetMs: RESET,
		});
	});

	it("anchors across a null-pct gap when the reset stayed put", () => {
		feed([
			{ pct: 60, observedAtMs: NOW },
			{ pct: null, observedAtMs: NOW + 2 * MINUTE },
			{ pct: 2, observedAtMs: NOW + 4 * MINUTE },
		]);

		expect(getUsageRevisionAnchor("acc", "seven_day", RESET)?.anchorPct).toBe(
			2,
		);
	});

	it("keys state independently per account and per window", () => {
		feed(
			[
				{ pct: 60, observedAtMs: NOW },
				{ pct: 2, observedAtMs: NOW + 2 * MINUTE },
			],
			"acc-a",
			"seven_day",
		);
		feed(
			[
				{ pct: 50, observedAtMs: NOW },
				{ pct: 48, observedAtMs: NOW + 2 * MINUTE },
			],
			"acc-a",
			"five_hour",
		);

		expect(getUsageRevisionAnchor("acc-a", "seven_day", RESET)).not.toBeNull();
		expect(getUsageRevisionAnchor("acc-a", "five_hour", RESET)).toBeNull();
		expect(getUsageRevisionAnchor("acc-b", "seven_day", RESET)).toBeNull();
	});

	it("drops the anchor when the window rolls over later", () => {
		feed([
			{ pct: 60, observedAtMs: NOW },
			{ pct: 2, observedAtMs: NOW + 2 * MINUTE },
			// The window resets normally an hour later.
			{
				pct: 1,
				resetMs: RESET + 7 * 24 * HOUR,
				observedAtMs: NOW + HOUR,
			},
		]);

		expect(getUsageRevisionAnchor("acc", "seven_day", RESET)).toBeNull();
		expect(
			getUsageRevisionAnchor("acc", "seven_day", RESET + 7 * 24 * HOUR),
		).toBeNull();
	});

	it("clears one account or everything", () => {
		feed(
			[
				{ pct: 60, observedAtMs: NOW },
				{ pct: 2, observedAtMs: NOW + 2 * MINUTE },
			],
			"acc-a",
		);
		feed(
			[
				{ pct: 60, observedAtMs: NOW },
				{ pct: 2, observedAtMs: NOW + 2 * MINUTE },
			],
			"acc-b",
		);

		clearUsageRevisionAnchors("acc-a");
		expect(getUsageRevisionAnchor("acc-a", "seven_day", RESET)).toBeNull();
		expect(getUsageRevisionAnchor("acc-b", "seven_day", RESET)).not.toBeNull();

		clearUsageRevisionAnchors();
		expect(getUsageRevisionAnchor("acc-b", "seven_day", RESET)).toBeNull();
	});
});
