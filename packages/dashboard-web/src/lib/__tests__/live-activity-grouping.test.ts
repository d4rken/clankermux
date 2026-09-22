import { describe, expect, it } from "bun:test";
import {
	DEFAULT_LANE_DIMENSION,
	LANE_DIMENSION_OPTIONS,
	loadLaneDimension,
	saveLaneDimension,
} from "../live-activity-grouping";

function fakeStorage(initial: Record<string, string> = {}) {
	const data = new Map(Object.entries(initial));
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => {
			data.set(key, value);
		},
	};
}

describe("loadLaneDimension", () => {
	it("groups by project with nothing stored", () => {
		expect(loadLaneDimension(fakeStorage())).toBe(DEFAULT_LANE_DIMENSION);
	});

	it("round-trips a chosen dimension", () => {
		const storage = fakeStorage();
		saveLaneDimension("client", storage);
		expect(loadLaneDimension(storage)).toBe("client");
	});

	it("ignores a stored value that is not a dimension", () => {
		// `buildLanes` looks the dimension up in a per-dimension spec table, so a
		// value from another build would leave the card with nothing to draw.
		expect(
			loadLaneDimension(
				fakeStorage({ "clankermux.liveActivityGroupBy": "pool" }),
			),
		).toBe(DEFAULT_LANE_DIMENSION);
	});

	it("survives storage that throws", () => {
		// Private browsing and blocked-storage modes throw on access rather than
		// returning null.
		const hostile = {
			getItem: () => {
				throw new Error("denied");
			},
		};
		expect(loadLaneDimension(hostile)).toBe(DEFAULT_LANE_DIMENSION);
	});

	it("does not throw when saving into hostile storage", () => {
		const hostile = {
			setItem: () => {
				throw new Error("quota");
			},
		};
		expect(() => saveLaneDimension("client", hostile)).not.toThrow();
	});
});

describe("dimension option set", () => {
	it("offers the default as a selectable option", () => {
		expect(
			LANE_DIMENSION_OPTIONS.some((o) => o.value === DEFAULT_LANE_DIMENSION),
		).toBe(true);
	});
});
