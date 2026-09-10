/**
 * The client-facing usage meter used to belong to whichever pooled account
 * served the request. Two production `/v1/messages` captures minutes apart in
 * one session read `5h 0.05 / 7d 0.64` and `5h 0.20 / 7d 0.51` — different
 * accounts, so the meter flickered between them. codex's own logs show the same
 * thing on its side: 76/78/81/83 within a few minutes.
 *
 * These writers restate the headroom figures as the POOL's best headroom so one
 * number is shown. Everything here pins the boundary of that restatement: the
 * exact headers touched, their units, and — more importantly — the far longer
 * list of headers that must survive byte-identical, because a rewritten
 * headroom paired with a stale verdict, threshold or reset is worse than the
 * flicker it replaces.
 */
import { describe, expect, it } from "bun:test";
import {
	applyHeaderRewrite,
	buildAnthropicUnifiedRewrite,
	buildCodexWeeklyRewrite,
	type PoolHeadroomFigures,
} from "../pool-headroom-headers";

const NOW = 1_789_000_000_000;
/** Comfortably in the future relative to NOW. */
const RESET_MS = 1_789_329_600_000;
const RESET_SEC = "1789329600";

const h = (headers: Record<string, string>): Headers => new Headers(headers);

/**
 * The complete unified block as Anthropic actually sends it, captured from this
 * pool's own `request_payloads` store. Deliberately the full set and not a
 * trimmed fixture: most of the assertions below are about what we DON'T touch,
 * and a trimmed fixture cannot fail those.
 */
function productionUnifiedHeaders(): Record<string, string> {
	return {
		"anthropic-ratelimit-unified-status": "allowed",
		"anthropic-ratelimit-unified-reset": "1789056000",
		"anthropic-ratelimit-unified-representative-claim": "five_hour",
		"anthropic-ratelimit-unified-5h-status": "allowed",
		"anthropic-ratelimit-unified-5h-utilization": "0.05",
		"anthropic-ratelimit-unified-5h-reset": "1789056000",
		"anthropic-ratelimit-unified-7d-status": "allowed",
		"anthropic-ratelimit-unified-7d-utilization": "0.64",
		"anthropic-ratelimit-unified-7d-reset": "1789329600",
		"anthropic-ratelimit-unified-fallback-percentage": "0.5",
		"anthropic-ratelimit-unified-overage-status": "rejected",
		"anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled",
	};
}

/** Root weekly arrives as `primary` on this pool; `secondary` is empty. */
function productionCodexHeaders(): Record<string, string> {
	return {
		"x-codex-primary-used-percent": "97",
		"x-codex-primary-window-minutes": "10080",
		"x-codex-primary-reset-at": "1789451336",
		"x-codex-primary-reset-after-seconds": "410602",
		"x-codex-primary-over-secondary-limit-percent": "0",
		"x-codex-secondary-used-percent": "0",
		"x-codex-secondary-window-minutes": "0",
		"x-codex-secondary-reset-at": "",
		"x-codex-secondary-reset-after-seconds": "0",
		"x-codex-bengalfox-limit-name": "GPT-5.3-Codex-Spark",
		"x-codex-bengalfox-primary-used-percent": "0",
		"x-codex-bengalfox-primary-window-minutes": "300",
		"x-codex-bengalfox-primary-reset-at": "1789058734",
		"x-codex-bengalfox-secondary-used-percent": "0",
		"x-codex-bengalfox-secondary-window-minutes": "10080",
		"x-codex-bengalfox-secondary-reset-at": "1789645534",
		"x-codex-credits-balance": "0",
		"x-codex-credits-has-credits": "False",
		"x-codex-plan-type": "pro",
		"x-codex-active-limit": "codex",
	};
}

const figures = (
	over: Partial<PoolHeadroomFigures> = {},
): PoolHeadroomFigures => ({
	session: { headroomPct: 80, resetMs: RESET_MS, complete: true },
	weekly: { headroomPct: 36, resetMs: RESET_MS, complete: true },
	...over,
});

describe("buildAnthropicUnifiedRewrite", () => {
	it("restates exactly the four headroom headers and nothing else", () => {
		const rewrite = buildAnthropicUnifiedRewrite(
			h(productionUnifiedHeaders()),
			figures(),
			NOW,
		);

		expect([...rewrite.set.keys()].sort()).toEqual([
			"anthropic-ratelimit-unified-5h-reset",
			"anthropic-ratelimit-unified-5h-utilization",
			"anthropic-ratelimit-unified-7d-reset",
			"anthropic-ratelimit-unified-7d-utilization",
		]);
		expect(rewrite.skipped).toBeNull();
	});

	it("writes utilization as a 0..1 fraction, not a percent", () => {
		// 36% headroom => 64% used => 0.64 on the wire.
		const rewrite = buildAnthropicUnifiedRewrite(
			h(productionUnifiedHeaders()),
			figures(),
			NOW,
		);
		expect(rewrite.set.get("anthropic-ratelimit-unified-7d-utilization")).toBe(
			"0.64",
		);
		expect(rewrite.set.get("anthropic-ratelimit-unified-5h-utilization")).toBe(
			"0.2",
		);
	});

	it("writes reset as epoch seconds", () => {
		const rewrite = buildAnthropicUnifiedRewrite(
			h(productionUnifiedHeaders()),
			figures(),
			NOW,
		);
		expect(rewrite.set.get("anthropic-ratelimit-unified-7d-reset")).toBe(
			RESET_SEC,
		);
	});

	it("leaves every verdict, summary and scoped header untouched", () => {
		// The verdict on THIS request is the serving account's and was true; we
		// restate headroom only. A scoped claim describes one model family's
		// bucket, which no pooled account-wide figure can speak for.
		const upstream = h({
			...productionUnifiedHeaders(),
			"anthropic-ratelimit-unified-7d_oi-status": "allowed",
			"anthropic-ratelimit-unified-7d_oi-utilization": "0.31",
			"anthropic-ratelimit-unified-7d_oi-reset": "1789400000",
		});
		const rewrite = buildAnthropicUnifiedRewrite(upstream, figures(), NOW);

		const touched = new Set([...rewrite.set.keys(), ...rewrite.remove]);
		for (const name of [
			"anthropic-ratelimit-unified-status",
			"anthropic-ratelimit-unified-reset",
			"anthropic-ratelimit-unified-representative-claim",
			"anthropic-ratelimit-unified-5h-status",
			"anthropic-ratelimit-unified-7d-status",
			"anthropic-ratelimit-unified-fallback-percentage",
			"anthropic-ratelimit-unified-overage-status",
			"anthropic-ratelimit-unified-overage-disabled-reason",
			"anthropic-ratelimit-unified-7d_oi-status",
			"anthropic-ratelimit-unified-7d_oi-utilization",
			"anthropic-ratelimit-unified-7d_oi-reset",
		]) {
			expect(touched.has(name)).toBe(false);
		}
	});

	it("deletes surpassed-threshold for any window it rewrites", () => {
		// The client short-circuits its whole pacing evaluation on this header and
		// republishes THAT claim's own utilization — which would re-expose the
		// per-account number the rewrite just removed.
		const upstream = h({
			...productionUnifiedHeaders(),
			"anthropic-ratelimit-unified-5h-surpassed-threshold": "0.05",
			"anthropic-ratelimit-unified-7d-surpassed-threshold": "0.64",
		});
		const rewrite = buildAnthropicUnifiedRewrite(upstream, figures(), NOW);

		expect([...rewrite.remove].sort()).toEqual([
			"anthropic-ratelimit-unified-5h-surpassed-threshold",
			"anthropic-ratelimit-unified-7d-surpassed-threshold",
		]);
	});

	it("does not delete surpassed-threshold for a window it did not rewrite", () => {
		const upstream = h({
			...productionUnifiedHeaders(),
			"anthropic-ratelimit-unified-5h-surpassed-threshold": "0.05",
			"anthropic-ratelimit-unified-7d-surpassed-threshold": "0.64",
		});
		const rewrite = buildAnthropicUnifiedRewrite(
			upstream,
			figures({ session: null }),
			NOW,
		);

		expect([...rewrite.remove]).toEqual([
			"anthropic-ratelimit-unified-7d-surpassed-threshold",
		]);
	});

	it("clamps to 0.99 when a class member had no usable reading", () => {
		// An unknown account might still serve, so a hard 1.0 — which is the only
		// value that renders as 100% — must not be claimed on its behalf.
		const rewrite = buildAnthropicUnifiedRewrite(
			h(productionUnifiedHeaders()),
			figures({
				weekly: { headroomPct: 0, resetMs: RESET_MS, complete: false },
			}),
			NOW,
		);
		expect(rewrite.set.get("anthropic-ratelimit-unified-7d-utilization")).toBe(
			"0.99",
		);
	});

	it("writes a full 1 when the class is provably exhausted", () => {
		const rewrite = buildAnthropicUnifiedRewrite(
			h(productionUnifiedHeaders()),
			figures({
				weekly: { headroomPct: 0, resetMs: RESET_MS, complete: true },
			}),
			NOW,
		);
		expect(rewrite.set.get("anthropic-ratelimit-unified-7d-utilization")).toBe(
			"1",
		);
	});

	it("writes neither header of a window whose reset is unknown", () => {
		// The pair is consumed together to derive pacing, so a pooled utilization
		// against an unrelated reset yields an incoherent verdict in both
		// directions. Rewrite both or neither.
		const rewrite = buildAnthropicUnifiedRewrite(
			h(productionUnifiedHeaders()),
			figures({ weekly: { headroomPct: 36, resetMs: null, complete: true } }),
			NOW,
		);
		expect(rewrite.set.has("anthropic-ratelimit-unified-7d-utilization")).toBe(
			false,
		);
		expect(rewrite.set.has("anthropic-ratelimit-unified-7d-reset")).toBe(false);
		// The other window is unaffected.
		expect(rewrite.set.has("anthropic-ratelimit-unified-5h-utilization")).toBe(
			true,
		);
	});

	it("writes neither header of a window whose reset is already past", () => {
		const rewrite = buildAnthropicUnifiedRewrite(
			h(productionUnifiedHeaders()),
			figures({
				weekly: { headroomPct: 36, resetMs: NOW - 1_000, complete: true },
			}),
			NOW,
		);
		expect(rewrite.set.has("anthropic-ratelimit-unified-7d-utilization")).toBe(
			false,
		);
	});

	it("never adds a utilization header that upstream did not send", () => {
		// Absence is itself a signal: with both account-wide readings missing the
		// client falls back to its own persisted figure. Manufacturing one here
		// would silently override that.
		const upstream = h({
			"anthropic-ratelimit-unified-status": "allowed",
			"anthropic-ratelimit-unified-7d-status": "allowed",
			"anthropic-ratelimit-unified-7d-utilization": "0.64",
			"anthropic-ratelimit-unified-7d-reset": "1789329600",
		});
		const rewrite = buildAnthropicUnifiedRewrite(upstream, figures(), NOW);

		expect(rewrite.set.has("anthropic-ratelimit-unified-5h-utilization")).toBe(
			false,
		);
		expect(rewrite.set.has("anthropic-ratelimit-unified-5h-reset")).toBe(false);
		expect(rewrite.set.has("anthropic-ratelimit-unified-7d-utilization")).toBe(
			true,
		);
	});

	it("produces an empty diff when the response carries no unified claims", () => {
		const rewrite = buildAnthropicUnifiedRewrite(
			h({ "content-type": "application/json" }),
			figures(),
			NOW,
		);
		expect(rewrite.set.size).toBe(0);
		expect(rewrite.remove).toEqual([]);
		expect(rewrite.skipped).toBe("no-upstream-claims");
	});

	it("produces an empty diff when there are no pooled figures", () => {
		const rewrite = buildAnthropicUnifiedRewrite(
			h(productionUnifiedHeaders()),
			{ session: null, weekly: null },
			NOW,
		);
		expect(rewrite.set.size).toBe(0);
		expect(rewrite.skipped).toBe("no-pooled-figures");
	});

	it("is a no-op when the pool is just the serving account", () => {
		// The degenerate case has to be provably inert: a one-account pool must
		// emit exactly the numbers upstream sent, or the rewrite is not a
		// restatement but a distortion.
		const upstream = h(productionUnifiedHeaders());
		const rewrite = buildAnthropicUnifiedRewrite(
			upstream,
			{
				session: {
					headroomPct: 95,
					resetMs: 1_789_056_000_000,
					complete: true,
				},
				weekly: { headroomPct: 36, resetMs: RESET_MS, complete: true },
			},
			NOW,
		);
		applyHeaderRewrite(upstream, rewrite);

		expect(upstream.get("anthropic-ratelimit-unified-5h-utilization")).toBe(
			"0.05",
		);
		expect(upstream.get("anthropic-ratelimit-unified-5h-reset")).toBe(
			"1789056000",
		);
		expect(upstream.get("anthropic-ratelimit-unified-7d-utilization")).toBe(
			"0.64",
		);
		expect(upstream.get("anthropic-ratelimit-unified-7d-reset")).toBe(
			RESET_SEC,
		);
	});
});

describe("buildCodexWeeklyRewrite", () => {
	it("rewrites the root slot identified by its window length, not its name", () => {
		const rewrite = buildCodexWeeklyRewrite(
			h(productionCodexHeaders()),
			figures(),
			NOW,
		);

		expect([...rewrite.set.keys()].sort()).toEqual([
			"x-codex-primary-reset-after-seconds",
			"x-codex-primary-reset-at",
			"x-codex-primary-used-percent",
		]);
		expect(rewrite.set.get("x-codex-primary-used-percent")).toBe("64");
		expect(rewrite.set.get("x-codex-primary-reset-at")).toBe(RESET_SEC);
	});

	it("finds the weekly window in the secondary slot when that is where it sits", () => {
		// Slot assignment is per-account, so keying on the name rather than the
		// 10080-minute length would rewrite a 5-hour window on some accounts.
		const upstream = h({
			"x-codex-primary-used-percent": "12",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-at": "1789058734",
			"x-codex-secondary-used-percent": "97",
			"x-codex-secondary-window-minutes": "10080",
			"x-codex-secondary-reset-at": "1789451336",
		});
		const rewrite = buildCodexWeeklyRewrite(upstream, figures(), NOW);

		expect([...rewrite.set.keys()].sort()).toEqual([
			"x-codex-secondary-reset-at",
			"x-codex-secondary-used-percent",
		]);
		// The 5-hour slot is left exactly as it arrived.
		expect(rewrite.set.has("x-codex-primary-used-percent")).toBe(false);
	});

	it("writes used-percent on a 0..100 scale", () => {
		const rewrite = buildCodexWeeklyRewrite(
			h(productionCodexHeaders()),
			figures({
				weekly: { headroomPct: 3, resetMs: RESET_MS, complete: true },
			}),
			NOW,
		);
		expect(rewrite.set.get("x-codex-primary-used-percent")).toBe("97");
	});

	it("clamps to 99 when a class member had no usable reading", () => {
		const rewrite = buildCodexWeeklyRewrite(
			h(productionCodexHeaders()),
			figures({
				weekly: { headroomPct: 0, resetMs: RESET_MS, complete: false },
			}),
			NOW,
		);
		expect(rewrite.set.get("x-codex-primary-used-percent")).toBe("99");
	});

	it("writes reset-after-seconds only when upstream sent it", () => {
		const upstream = h({
			"x-codex-primary-used-percent": "97",
			"x-codex-primary-window-minutes": "10080",
			"x-codex-primary-reset-at": "1789451336",
		});
		const rewrite = buildCodexWeeklyRewrite(upstream, figures(), NOW);

		expect(rewrite.set.has("x-codex-primary-reset-after-seconds")).toBe(false);
		expect(rewrite.set.has("x-codex-primary-used-percent")).toBe(true);
	});

	it("derives reset-after-seconds from the pooled reset", () => {
		const rewrite = buildCodexWeeklyRewrite(
			h(productionCodexHeaders()),
			figures(),
			NOW,
		);
		expect(rewrite.set.get("x-codex-primary-reset-after-seconds")).toBe(
			String(Math.ceil((RESET_MS - NOW) / 1000)),
		);
	});

	it("leaves the family-scoped block and credit headers untouched", () => {
		// A family limit is a different quota with a different name; the
		// account-wide pooled figure cannot speak for it.
		const rewrite = buildCodexWeeklyRewrite(
			h(productionCodexHeaders()),
			figures(),
			NOW,
		);
		const touched = new Set([...rewrite.set.keys(), ...rewrite.remove]);

		for (const name of [
			"x-codex-bengalfox-limit-name",
			"x-codex-bengalfox-primary-used-percent",
			"x-codex-bengalfox-primary-window-minutes",
			"x-codex-bengalfox-secondary-used-percent",
			"x-codex-bengalfox-secondary-window-minutes",
			"x-codex-credits-balance",
			"x-codex-credits-has-credits",
			"x-codex-plan-type",
			"x-codex-active-limit",
			"x-codex-primary-window-minutes",
			"x-codex-primary-over-secondary-limit-percent",
		]) {
			expect(touched.has(name)).toBe(false);
		}
	});

	it("produces an empty diff when no root slot reports a weekly window", () => {
		const upstream = h({
			"x-codex-primary-used-percent": "12",
			"x-codex-primary-window-minutes": "300",
			"x-codex-bengalfox-secondary-window-minutes": "10080",
			"x-codex-bengalfox-secondary-used-percent": "0",
		});
		const rewrite = buildCodexWeeklyRewrite(upstream, figures(), NOW);

		expect(rewrite.set.size).toBe(0);
		expect(rewrite.skipped).toBe("no-root-weekly-window");
	});

	it("produces an empty diff when there is no pooled weekly figure", () => {
		const rewrite = buildCodexWeeklyRewrite(
			h(productionCodexHeaders()),
			figures({ weekly: null }),
			NOW,
		);
		expect(rewrite.set.size).toBe(0);
		expect(rewrite.skipped).toBe("no-pooled-figures");
	});
});

describe("applyHeaderRewrite", () => {
	it("sets and removes in place", () => {
		const target = h({
			"anthropic-ratelimit-unified-7d-utilization": "0.64",
			"anthropic-ratelimit-unified-7d-surpassed-threshold": "0.64",
		});
		applyHeaderRewrite(target, {
			set: new Map([["anthropic-ratelimit-unified-7d-utilization", "0.2"]]),
			remove: ["anthropic-ratelimit-unified-7d-surpassed-threshold"],
			skipped: null,
		});

		expect(target.get("anthropic-ratelimit-unified-7d-utilization")).toBe(
			"0.2",
		);
		expect(
			target.has("anthropic-ratelimit-unified-7d-surpassed-threshold"),
		).toBe(false);
	});
});
