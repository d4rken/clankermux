import { describe, expect, it } from "bun:test";
import type { RunwayAccountSource } from "../api-key-runway";
import { computeWorkloadHeadroom } from "../workload-headroom";

const NOW = Date.UTC(2026, 8, 5, 16, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function reporter(id: string): RunwayAccountSource {
	return {
		id,
		name: id,
		provider: "anthropic",
		usageObservedAtMs: NOW,
		usageData: {
			five_hour: { utilization: 10, resets_at: iso(NOW + HOUR) },
			seven_day: { utilization: 40, resets_at: iso(NOW + 2 * DAY) },
			limits: [
				{
					kind: "weekly_scoped",
					group: "weekly",
					percent: 69,
					severity: "normal",
					resets_at: iso(NOW + 2 * DAY),
					scope: { model: { id: null, display_name: "Fable" }, surface: null },
					is_active: false,
				},
			],
		} as never,
	};
}

// The live shape observed on Claude-4 at 2026-09-05 15:58Z: nothing used this
// week, and the Fable entry PRESENT at 0% with no reset instead of absent.
function idle(id: string): RunwayAccountSource {
	return {
		id,
		name: id,
		provider: "anthropic",
		usageObservedAtMs: NOW,
		usageData: {
			five_hour: { utilization: 0, resets_at: iso(NOW + HOUR) },
			seven_day: { utilization: 0, resets_at: iso(NOW + 3 * DAY) },
			limits: [
				{
					kind: "session",
					group: "session",
					percent: 0,
					severity: "normal",
					resets_at: iso(NOW + HOUR),
					scope: null,
					is_active: true,
				},
				{
					kind: "weekly_all",
					group: "weekly",
					percent: 0,
					severity: "normal",
					resets_at: iso(NOW + 3 * DAY),
					scope: null,
					is_active: false,
				},
				{
					kind: "weekly_scoped",
					group: "weekly",
					percent: 0,
					severity: "normal",
					resets_at: null,
					scope: { model: { id: null, display_name: "Fable" }, surface: null },
					is_active: false,
				},
			],
		} as never,
	};
}

describe("computeWorkloadHeadroom — idle scoped entry (0%, no reset)", () => {
	it("classifies a 0%-no-reset Fable entry as unopened, not unreadable", () => {
		const row = computeWorkloadHeadroom([reporter("c1"), idle("c4")], NOW).find(
			(candidate) => candidate.dimensionKind === "family",
		);
		expect(row?.eligibleAccountIds).toEqual(["c1", "c4"]);
		expect(row?.unopenedAccountIds).toEqual(["c4"]);
		expect(row?.unreadableAccountIds).toEqual([]);
	});
});
