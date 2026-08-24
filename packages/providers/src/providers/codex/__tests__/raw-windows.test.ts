/**
 * The RAW Codex window extractor, and the guarantee that it did not disturb the
 * normalized path beside it.
 *
 * The raw extractor exists because normalization is lossy in exactly the
 * dimensions a series needs. Each test below pins one of those losses as a
 * DIFFERENCE between the two functions rather than as a property of the raw one
 * alone — a raw extractor that quietly acquired the normalizer's habits would
 * pass every test written only against itself.
 */
import { describe, expect, it } from "bun:test";
import { extractRawCodexWindows, parseCodexUsageHeaders } from "../usage";

const OBSERVED_AT = 1_760_000_000_000;
const RESET_AT_SECONDS = 1_760_018_000;

const h = (headers: Record<string, string>): Headers => new Headers(headers);

/** A response carrying the account-wide pair plus one per-model family. */
function fullHeaders(): Record<string, string> {
	return {
		"x-codex-primary-used-percent": "43.5",
		"x-codex-primary-window-minutes": "10080",
		"x-codex-primary-reset-at": String(RESET_AT_SECONDS),
		"x-codex-secondary-used-percent": "0",
		"x-codex-secondary-window-minutes": "0",
		"x-codex-spark-limit-name": "GPT-5.3-Codex-Spark",
		"x-codex-spark-primary-used-percent": "12",
		"x-codex-spark-primary-window-minutes": "300",
		"x-codex-spark-primary-reset-at": String(RESET_AT_SECONDS),
		"x-codex-spark-secondary-used-percent": "88",
		"x-codex-spark-secondary-window-minutes": "10080",
		"x-codex-spark-secondary-reset-at": String(RESET_AT_SECONDS),
		"x-codex-active-limit": "secondary",
	};
}

describe("extractRawCodexWindows", () => {
	it("yields nothing for a response with no window lines", () => {
		expect(extractRawCodexWindows(h({}), OBSERVED_AT)).toEqual([]);
		expect(
			extractRawCodexWindows(h({ "content-type": "text/plain" }), OBSERVED_AT),
		).toEqual([]);
	});

	it("emits the root pair and every family slot, in a deterministic order", () => {
		const readings = extractRawCodexWindows(h(fullHeaders()), OBSERVED_AT);

		expect(
			readings.map((r) => `${r.scope}:${r.familyCodename}:${r.slot}`),
		).toEqual([
			"root::primary",
			"root::secondary",
			"family:spark:primary",
			"family:spark:secondary",
		]);
	});

	it("keeps the per-family 5-hour slot the normalized path discards", () => {
		// The family's primary window is 300 minutes — a 5-hour window. The
		// normalized path only ever emits a family's WEEKLY window, so this slot
		// exists nowhere else, and "the 5h window was retired" is a claim the
		// series should be able to check rather than assume.
		const readings = extractRawCodexWindows(h(fullHeaders()), OBSERVED_AT);
		const familyPrimary = readings.find(
			(r) => r.scope === "family" && r.slot === "primary",
		);

		expect(familyPrimary?.windowMinutes).toBe(300);
		expect(familyPrimary?.usedPercent).toBe(12);
		expect(familyPrimary?.limitName).toBe("GPT-5.3-Codex-Spark");

		const normalized = parseCodexUsageHeaders(h(fullHeaders()), {
			baseTimeMs: OBSERVED_AT,
		});
		// Only the family's WEEKLY window survives normalization.
		expect(normalized?.limits).toHaveLength(1);
		expect(normalized?.limits?.[0].percent).toBe(88);
	});

	it("emits a family discovered from its SLOT lines alone, with a null limitName", () => {
		// The partial shape the normalized path deletes: slot lines with no
		// `-limit-name` beside them. Reusing the normalized discovery rule here
		// dropped every spark window on such a response — precisely the evidence
		// the series exists to hold. limitName is null (unnamed), not "".
		const readings = extractRawCodexWindows(
			h({
				"x-codex-primary-used-percent": "43.5",
				"x-codex-spark-primary-used-percent": "12",
				"x-codex-spark-primary-window-minutes": "300",
				"x-codex-spark-secondary-reset-after-seconds": "600",
			}),
			OBSERVED_AT,
		);

		expect(
			readings.map((r) => `${r.scope}:${r.familyCodename}:${r.slot}`),
		).toEqual([
			"root::primary",
			"family:spark:primary",
			"family:spark:secondary",
		]);
		const family = readings.filter((r) => r.scope === "family");
		expect(family.every((r) => r.limitName === null)).toBe(true);
		expect(family[0].usedPercent).toBe(12);
		expect(family[0].windowMinutes).toBe(300);
		expect(family[1].resetAtMs).toBe(OBSERVED_AT + 600_000);

		// The normalized path still sees no family at all — the difference is the
		// point, and this extractor must not have taught it the wider rule.
		const normalized = parseCodexUsageHeaders(
			h({
				"x-codex-primary-used-percent": "43.5",
				"x-codex-spark-primary-used-percent": "12",
				"x-codex-spark-primary-window-minutes": "300",
				"x-codex-spark-secondary-reset-after-seconds": "600",
			}),
			{ baseTimeMs: OBSERVED_AT },
		);
		expect(normalized?.limits).toBeUndefined();
	});

	it("still names a family that DOES carry its limit-name line", () => {
		const readings = extractRawCodexWindows(h(fullHeaders()), OBSERVED_AT);
		const family = readings.filter((r) => r.scope === "family");

		expect(family).toHaveLength(2);
		expect(family.every((r) => r.limitName === "GPT-5.3-Codex-Spark")).toBe(
			true,
		);
	});

	it("records a reported zero as zero and an absent line as null", () => {
		const readings = extractRawCodexWindows(h(fullHeaders()), OBSERVED_AT);
		const rootSecondary = readings.find(
			(r) => r.scope === "root" && r.slot === "secondary",
		);

		// A reported 0% is a reading, and a 0-minute window is a reported
		// placeholder — the raw row says exactly that, where the normalized path
		// collapses the whole window to nothing.
		expect(rootSecondary?.usedPercent).toBe(0);
		expect(rootSecondary?.windowMinutes).toBe(0);
		expect(rootSecondary?.resetAtMs).toBeNull();
	});

	it("records a malformed reading as null but still emits the row", () => {
		// The presence of a malformed header IS the observation; dropping the row
		// would hide precisely the shape worth seeing. Prefix-tolerant parsing
		// would be worse still: "43.5%" must not become 43.5.
		const readings = extractRawCodexWindows(
			h({
				"x-codex-primary-used-percent": "43.5%",
				"x-codex-primary-window-minutes": "many",
				"x-codex-primary-reset-at": "soon",
			}),
			OBSERVED_AT,
		);

		expect(readings).toHaveLength(1);
		expect(readings[0].usedPercent).toBeNull();
		expect(readings[0].windowMinutes).toBeNull();
		expect(readings[0].resetAtMs).toBeNull();
	});

	it("emits a slot from a single present line", () => {
		const readings = extractRawCodexWindows(
			h({ "x-codex-secondary-reset-after-seconds": "600" }),
			OBSERVED_AT,
		);

		expect(readings).toHaveLength(1);
		expect(readings[0].slot).toBe("secondary");
		expect(readings[0].usedPercent).toBeNull();
		// Relative reset resolved against the ONE captured instant, never a fresh
		// clock read: a second Date.now() would date two lines of one response
		// differently.
		expect(readings[0].resetAtMs).toBe(OBSERVED_AT + 600_000);
	});

	it("prefers the absolute reset over the relative one", () => {
		const readings = extractRawCodexWindows(
			h({
				"x-codex-primary-reset-at": String(RESET_AT_SECONDS),
				"x-codex-primary-reset-after-seconds": "600",
			}),
			OBSERVED_AT,
		);

		expect(readings[0].resetAtMs).toBe(RESET_AT_SECONDS * 1000);
	});

	it("reads x-codex-active-limit, which the family regex excludes by design", () => {
		const readings = extractRawCodexWindows(h(fullHeaders()), OBSERVED_AT);

		expect(readings.every((r) => r.activeLimit === "secondary")).toBe(true);
		// And it is NOT mistaken for a family.
		expect(readings.some((r) => r.familyCodename === "active")).toBe(false);
	});

	it("NEVER substitutes the 429 default the routing path uses", () => {
		// A 429 whose window lines carry only a reset. The normalized path fills a
		// default utilization in so routing has a number to act on; recording that
		// number would put a value the provider never sent into the series.
		const headers = h({
			"x-codex-primary-reset-at": String(RESET_AT_SECONDS),
			"x-codex-primary-window-minutes": "10080",
		});

		const raw = extractRawCodexWindows(headers, OBSERVED_AT);
		expect(raw[0].usedPercent).toBeNull();

		const normalized = parseCodexUsageHeaders(headers, {
			baseTimeMs: OBSERVED_AT,
			defaultUtilization: 100,
		});
		expect(normalized?.seven_day?.utilization).toBe(100);
	});
});

describe("parseCodexUsageHeaders — unchanged by the raw extractor", () => {
	it("still produces the documented normalized shape", () => {
		// Regression pin: the raw extractor was ADDED beside this function, and
		// the routing path's behaviour must be byte-identical to what it was.
		const usage = parseCodexUsageHeaders(h(fullHeaders()), {
			baseTimeMs: OBSERVED_AT,
		});

		expect(usage).toEqual({
			// The rolling 5h window is retired: null, never a fabricated {0, null}
			// placeholder, which is indistinguishable from a genuine idle window.
			five_hour: null,
			seven_day: {
				utilization: 43.5,
				resets_at: new Date(RESET_AT_SECONDS * 1000).toISOString(),
			},
			limits: [
				{
					kind: "weekly_scoped",
					group: "codex",
					percent: 88,
					resets_at: new Date(RESET_AT_SECONDS * 1000).toISOString(),
					scope: {
						model: {
							id: "GPT-5.3-Codex-Spark",
							display_name: "GPT-5.3-Codex-Spark",
						},
					},
					is_active: true,
				},
			],
		});
	});

	it("still returns null when no window is reported at all", () => {
		expect(
			parseCodexUsageHeaders(h({}), { baseTimeMs: OBSERVED_AT }),
		).toBeNull();
	});
});
