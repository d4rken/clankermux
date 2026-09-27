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
			sideRequests: 0,
			released: 0,
			releaseFailures: 0,
			releasesRefused: 0,
			releasedResumes: 0,
			releasedExpired: 0,
		},
		peakRssBytes: 262_144_000,
		releasedParks: 0,
		sessionBytes: null,
		releaseBlocked: null,
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

	it("counts released parks, and says when parked turns are not released", () => {
		const line = text(
			status({
				releasedParks: 3,
				releaseBlocked:
					"session files have reached sdk_bridge_session_bytes_ceiling",
			}),
		);
		expect(line).toContain("2 live · 1 parked · 3 released · cap 8");
		expect(line).toContain(
			"Not releasing parked turns: session files have reached sdk_bridge_session_bytes_ceiling",
		);
		expect(text(status())).not.toContain("released");
	});

	it("counts turns not completed, rejections and rebuilds since restart", () => {
		const base = status();
		const line = text(
			status({
				counters: {
					...base.counters,
					turnsFailed: 3,
					rejected: { prompt_refused: 2, field_refused: 1 },
					rebuilds: 4,
				},
			}),
		);
		expect(line).toContain(
			"Since restart: 3 not completed · 3 rejected · 4 rebuilds",
		);
		expect(text(status())).toContain(
			"Since restart: 0 not completed · 0 rejected · 0 rebuilds",
		);
	});

	it("keeps counts since restart while unavailable, once there are any", () => {
		const base = status();
		const unavailable = { state: "unavailable", reason: "recovering" } as const;
		expect(
			text(
				status({
					availability: unavailable,
					counters: { ...base.counters, turnsFailed: 1 },
				}),
			),
		).toContain("Since restart: 1 not completed · 0 rejected · 0 rebuilds");
		expect(text(status({ availability: unavailable }))).not.toContain(
			"Since restart",
		);
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
