import { describe, expect, it } from "bun:test";
import {
	backfillLimitFor,
	DEFAULT_LIVE_WINDOW_MS,
	eventCapFor,
	LIVE_WINDOW_OPTIONS,
	loadLiveWindow,
	MAX_BACKFILL_ROWS,
	MAX_EVENT_CAP,
	saveLiveWindow,
} from "../live-activity-window";

function fakeStorage(initial: Record<string, string> = {}) {
	const data = new Map(Object.entries(initial));
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => {
			data.set(key, value);
		},
		read: (key: string) => data.get(key) ?? null,
	};
}

describe("loadLiveWindow", () => {
	it("returns the default with nothing stored", () => {
		expect(loadLiveWindow(fakeStorage())).toBe(DEFAULT_LIVE_WINDOW_MS);
	});

	it("round-trips a chosen window", () => {
		const storage = fakeStorage();
		saveLiveWindow(10 * 60_000, storage);
		expect(loadLiveWindow(storage)).toBe(10 * 60_000);
	});

	it("ignores a stored value that is no longer an offered option", () => {
		// A window removed in a later build must not resurrect itself from a
		// stale localStorage entry and render an axis nothing else expects.
		expect(
			loadLiveWindow(
				fakeStorage({ "clankermux.liveActivityWindowMs": "7777" }),
			),
		).toBe(DEFAULT_LIVE_WINDOW_MS);
	});

	it("survives unparseable storage contents", () => {
		expect(
			loadLiveWindow(
				fakeStorage({ "clankermux.liveActivityWindowMs": "banana" }),
			),
		).toBe(DEFAULT_LIVE_WINDOW_MS);
	});

	it("survives storage that throws", () => {
		// Private browsing and blocked-storage modes throw on access rather than
		// returning null.
		const hostile = {
			getItem: () => {
				throw new Error("denied");
			},
		};
		expect(loadLiveWindow(hostile)).toBe(DEFAULT_LIVE_WINDOW_MS);
	});

	it("does not throw when saving into hostile storage", () => {
		const hostile = {
			setItem: () => {
				throw new Error("quota");
			},
		};
		expect(() => saveLiveWindow(180_000, hostile)).not.toThrow();
	});
});

describe("window option set", () => {
	it("offers the default as a selectable option", () => {
		expect(
			LIVE_WINDOW_OPTIONS.some((o) => o.ms === DEFAULT_LIVE_WINDOW_MS),
		).toBe(true);
	});

	it("is ordered shortest first", () => {
		const values = LIVE_WINDOW_OPTIONS.map((o) => o.ms);
		expect([...values].sort((a, b) => a - b)).toEqual(values);
	});
});

describe("backfillLimitFor", () => {
	it("grows with the window", () => {
		expect(backfillLimitFor(10 * 60_000)).toBeGreaterThan(
			backfillLimitFor(3 * 60_000),
		);
	});

	it("never exceeds what the API accepts", () => {
		// /api/requests rejects limit > 1000 outright, so an over-large ask is a
		// failed backfill, not a big one.
		for (const option of LIVE_WINDOW_OPTIONS) {
			expect(backfillLimitFor(option.ms)).toBeLessThanOrEqual(
				MAX_BACKFILL_ROWS,
			);
		}
	});

	it("covers a realistic request rate for every offered window", () => {
		// ~40 req/min is this deployment's sustained rate; the backfill should
		// not be the thing that truncates at the short windows.
		for (const option of LIVE_WINDOW_OPTIONS.slice(0, 3)) {
			const expected = (option.ms / 60_000) * 40;
			expect(backfillLimitFor(option.ms)).toBeGreaterThan(expected);
		}
	});
});

describe("eventCapFor", () => {
	it("never retains less than the backfill can deliver", () => {
		// Otherwise the fetched history would be pruned the instant it landed,
		// and the card would silently lose the left half of its own window.
		for (const option of LIVE_WINDOW_OPTIONS) {
			expect(eventCapFor(option.ms)).toBeGreaterThanOrEqual(
				backfillLimitFor(option.ms),
			);
		}
	});

	it("stays under the render ceiling", () => {
		for (const option of LIVE_WINDOW_OPTIONS) {
			expect(eventCapFor(option.ms)).toBeLessThanOrEqual(MAX_EVENT_CAP);
		}
	});
});
