/**
 * The overload breaker's diagnostic surface.
 *
 * These assert LOG CONTENT, which is unusual, but the content is the product:
 * the 2026-08-24 incident took hours to diagnose because the journal could not
 * say how long the elected probe held its lease, nor whether a cooldown came
 * from an upstream header or our own 60s fallback. Both were derived by hand.
 * A regression here is silent and only discovered during the next incident.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Logger } from "@clankermux/logger";
import {
	applyProviderOverloadCooldown,
	clearProviderOverloadCooldown,
	completeProviderOverloadProbe,
	tryAcquireProviderOverloadProbe,
} from "../provider-overload-cooldown";

function captureLogs(level: "info" | "warn" | "debug") {
	const lines: string[] = [];
	const spy = spyOn(Logger.prototype, level).mockImplementation(((
		msg: unknown,
	) => {
		lines.push(String(msg));
	}) as never);
	return { lines, restore: () => spy.mockRestore() };
}

/** Trip, then wait out the (tiny) cooldown so the bucket is half-open. */
async function tripToHalfOpen(model: string): Promise<void> {
	applyProviderOverloadCooldown("anthropic", Date.now() + 5, model);
	await new Promise((r) => setTimeout(r, 15));
}

describe("overload breaker telemetry", () => {
	afterEach(() => {
		clearProviderOverloadCooldown();
	});

	it("names the reset source when upstream supplied no usable deadline", () => {
		const cap = captureLogs("warn");
		try {
			// No resetTime at all — the 60s default path.
			applyProviderOverloadCooldown("anthropic", undefined, "claude-opus-4-5");
		} finally {
			cap.restore();
		}
		const line = cap.lines.find((l) => l.includes("Overload breaker"));
		expect(line).toBeDefined();
		// The whole question "did these 529s carry a retry-after?" answered inline.
		expect(line).toContain("reset=no_usable_reset_default");
		expect(line).toContain("opened");
		expect(line).toContain("model=claude-opus-4-5");
	});

	it("distinguishes an upstream hint, a capped hint, and a re-trip", () => {
		const cap = captureLogs("warn");
		try {
			applyProviderOverloadCooldown("anthropic", Date.now() + 30_000, "m");
			// Far beyond the 5 minute ceiling → clamped, and flagged as clamped.
			applyProviderOverloadCooldown("anthropic", Date.now() + 60 * 60_000, "m");
			// A shorter deadline than the one already stored: the old one wins.
			applyProviderOverloadCooldown("anthropic", Date.now() + 1_000, "m");
		} finally {
			cap.restore();
		}
		const lines = cap.lines.filter((l) => l.includes("Overload breaker"));
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("reset=hint");
		expect(lines[0]).toContain("opened");
		expect(lines[1]).toContain("reset=hint_capped");
		expect(lines[1]).toContain("re-tripped(extended)");
		expect(lines[2]).toContain("re-tripped(deadline retained)");
	});

	it("flags a mid-stream trip's deadline as our own default, not upstream's", () => {
		const cap = captureLogs("warn");
		try {
			applyProviderOverloadCooldown("anthropic", Date.now() + 60_000, "m", {
				syntheticReset: true,
				accountName: "Claude-1",
			});
		} finally {
			cap.restore();
		}
		const line = cap.lines.find((l) => l.includes("Overload breaker"));
		// Without the flag this would read `reset=hint` and imply upstream sent a
		// number it never sent — an SSE error frame carries no headers.
		expect(line).toContain("reset=midstream_no_headers_default");
		expect(line).toContain("account=Claude-1");
	});

	it("reports how long a probe held its lease, and what settled it", async () => {
		await tripToHalfOpen("claude-opus-4-5");
		const admission = tryAcquireProviderOverloadProbe(
			"anthropic",
			"claude-opus-4-5",
		);
		expect(admission.admitted).toBe(true);
		const token = admission.admitted ? admission.token : null;
		expect(token).not.toBeNull();

		await new Promise((r) => setTimeout(r, 25));
		const cap = captureLogs("info");
		try {
			completeProviderOverloadProbe(token, "recovered", "message_start");
		} finally {
			cap.restore();
		}
		const line = cap.lines.find((l) => l.includes("settled recovered"));
		expect(line).toBeDefined();
		expect(line).toContain("evidence=message_start");
		// The duration is the convoy signature; a probe that held for a whole
		// generation is what starved every other holder.
		const ms = Number(/after (\d+)ms/.exec(line as string)?.[1]);
		expect(ms).toBeGreaterThanOrEqual(20);
	});

	it("still reports the duration when a re-trip superseded the lease", async () => {
		// THE trap. Both re-trip paths call applyProviderOverloadCooldown BEFORE
		// settling, which bumps the generation and clears bucket.probe — so a
		// settle that reads identity from the BUCKET finds nothing and logs
		// nothing, for precisely the outcome an operator most wants to see.
		await tripToHalfOpen("claude-opus-4-5");
		const admission = tryAcquireProviderOverloadProbe(
			"anthropic",
			"claude-opus-4-5",
		);
		const token = admission.admitted ? admission.token : null;
		expect(token).not.toBeNull();

		await new Promise((r) => setTimeout(r, 25));
		// The probe hit an overload: re-trip lands first, exactly as production.
		applyProviderOverloadCooldown(
			"anthropic",
			Date.now() + 60_000,
			"claude-opus-4-5",
		);

		const cap = captureLogs("debug");
		try {
			completeProviderOverloadProbe(token, "reopened", "sse_overloaded_error");
		} finally {
			cap.restore();
		}
		const line = cap.lines.find((l) => l.includes("completion ignored"));
		expect(line).toBeDefined();
		expect(line).toContain("reason=superseded");
		expect(line).toContain("evidence=sse_overloaded_error");
		const ms = Number(/after (\d+)ms/.exec(line as string)?.[1]);
		expect(ms).toBeGreaterThanOrEqual(20);
	});

	it("gives each admitted probe a distinct id", async () => {
		await tripToHalfOpen("claude-opus-4-5");
		const first = tryAcquireProviderOverloadProbe(
			"anthropic",
			"claude-opus-4-5",
		);
		const firstToken = first.admitted ? first.token : null;
		completeProviderOverloadProbe(firstToken, "abandoned");

		await tripToHalfOpen("claude-opus-4-5");
		const second = tryAcquireProviderOverloadProbe(
			"anthropic",
			"claude-opus-4-5",
		);
		const secondToken = second.admitted ? second.token : null;

		expect(firstToken?.probeId).toBeDefined();
		expect(secondToken?.probeId).toBeDefined();
		expect(firstToken?.probeId).not.toBe(secondToken?.probeId);
	});
});
