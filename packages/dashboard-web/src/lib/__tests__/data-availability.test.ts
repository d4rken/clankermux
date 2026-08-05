import { describe, expect, it } from "bun:test";
import { dataAvailability, staleAgeLabel } from "../data-availability";

describe("dataAvailability", () => {
	it("reports an errored read with nothing cached as unavailable", () => {
		expect(
			dataAvailability(
				{ data: undefined, isError: true, dataUpdatedAt: 0 },
				false,
			),
		).toEqual({ state: "unavailable" });
	});

	it("reports an errored read WITH cached data as stale, not gone", () => {
		// React Query keeps `data` after a failed refetch. Rendering it as live is
		// how a broken poll looked healthy; rendering nothing would throw away a
		// real (if old) measurement.
		expect(
			dataAvailability(
				{ data: { total: 3 }, isError: true, dataUpdatedAt: 1000 },
				false,
			),
		).toEqual({ state: "stale", lastUpdatedAt: 1000 });
	});

	it("distinguishes the first load from an unavailable read", () => {
		expect(
			dataAvailability(
				{ data: undefined, isError: false, dataUpdatedAt: 0 },
				true,
			),
		).toEqual({ state: "loading" });
		expect(
			dataAvailability(
				{ data: undefined, isError: false, dataUpdatedAt: 0 },
				false,
			),
		).toEqual({ state: "unavailable" });
	});

	it("reports a successful read as ok, including a genuine zero", () => {
		expect(
			dataAvailability(
				{ data: { total: 0 }, isError: false, dataUpdatedAt: 5 },
				false,
			),
		).toEqual({ state: "ok" });
	});
});

describe("staleAgeLabel", () => {
	it("formats the age of the last successful read", () => {
		const now = 10_000_000;
		expect(staleAgeLabel(now - 5_000, now)).toBe("5s ago");
		expect(staleAgeLabel(now - 120_000, now)).toBe("2m ago");
		expect(staleAgeLabel(now - 7_200_000, now)).toBe("2h ago");
	});

	it("says so when there has never been a successful read", () => {
		expect(staleAgeLabel(0, 10_000)).toBe("unknown age");
	});
});
