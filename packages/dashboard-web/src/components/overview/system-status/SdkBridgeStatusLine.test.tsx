import { describe, expect, it } from "bun:test";
import type { SdkBridgeStatus } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { SdkBridgeStatusLine } from "./SdkBridgeStatusLine";

function status(over: Partial<SdkBridgeStatus> = {}): SdkBridgeStatus {
	return {
		availability: { state: "available" },
		live: 2,
		parked: 1,
		cap: 8,
		counters: {
			turnsStarted: 0,
			turnsCompleted: 0,
			turnsFailed: 0,
			continuations: 0,
			rejected: {},
			resumes: 0,
			rebuilds: 0,
		},
		peakRssBytes: 262_144_000,
		...over,
	};
}

const text = (s: SdkBridgeStatus) =>
	renderToStaticMarkup(<SdkBridgeStatusLine status={s} />).replace(
		/<[^>]+>/g,
		" ",
	);

describe("SdkBridgeStatusLine", () => {
	it("shows live, parked, cap and peak RSS when available", () => {
		const line = text(status());
		expect(line).toContain("Agent SDK bridge");
		expect(line).toContain("Available");
		expect(line).toContain("2 live · 1 parked · cap 8 · peak 250");
	});

	it("leaves out peak RSS where it cannot be measured", () => {
		expect(text(status({ peakRssBytes: null }))).not.toContain("peak");
	});

	it("names the reason it is unavailable", () => {
		const line = text(
			status({
				availability: { state: "unavailable", reason: "compiled binary" },
			}),
		);
		expect(line).toContain("Unavailable: compiled binary");
		expect(line).not.toContain("live");
	});

	it("says when it is shutting down", () => {
		expect(
			text(status({ availability: { state: "shutting_down" } })),
		).toContain("Shutting down");
	});
});
