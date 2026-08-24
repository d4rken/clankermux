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
	type ProbeAdmission,
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
		// "Usable upstream hint, or our own fallback?" answered inline, instead of
		// being derived from the spacing of ISO deadlines across dozens of lines.
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
		expect(lines[0]).toMatch(/reset=hint[,)]/);
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

	it("keeps a genuinely no-op completion on DEBUG", async () => {
		// The counterpart to the reopened case below: an abandoned completion
		// whose bucket an operator cleared underneath it reached no verdict
		// anyone is waiting on, so it stays out of the default-level journal.
		// Only the duration is still worth recording.
		await tripToHalfOpen("claude-opus-4-5");
		const admission = tryAcquireProviderOverloadProbe(
			"anthropic",
			"claude-opus-4-5",
		);
		const token = admission.admitted ? admission.token : null;
		expect(token).not.toBeNull();

		await new Promise((r) => setTimeout(r, 25));
		clearProviderOverloadCooldown("anthropic");

		const info = captureLogs("info");
		const debug = captureLogs("debug");
		try {
			completeProviderOverloadProbe(token, "abandoned", "stream_read_error");
		} finally {
			info.restore();
			debug.restore();
		}
		const line = debug.lines.find((l) => l.includes("completion ignored"));
		expect(line).toBeDefined();
		expect(line).toContain("reason=superseded");
		expect(line).toContain("evidence=stream_read_error");
		const ms = Number(/after (\d+)ms/.exec(line as string)?.[1]);
		expect(ms).toBeGreaterThanOrEqual(20);
		// It must NOT be promoted to the default level — that is reserved for
		// verdicts, and a no-op during an incident would just be noise.
		expect(info.lines.some((l) => l.includes("settled"))).toBe(false);
	});

	it("reports a reopened probe on INFO, not DEBUG", async () => {
		// The regression this pins: BOTH production re-trip paths call
		// applyProviderOverloadCooldown before settling, so `applied` is always
		// empty for a single-family reopened verdict. Routing that to DEBUG hides
		// the probe's verdict and duration behind a level that is OFF by default,
		// i.e. hides it during exactly the incident it describes.
		//
		// Spying on Logger.prototype bypasses the level guard, so asserting the
		// message text alone would prove nothing about visibility. The CHANNEL is
		// the invariant: INFO is emitted at the default level, DEBUG is not.
		await tripToHalfOpen("claude-opus-4-5");
		const admission = tryAcquireProviderOverloadProbe(
			"anthropic",
			"claude-opus-4-5",
		);
		const token = admission.admitted ? admission.token : null;
		expect(token).not.toBeNull();

		// Production ordering: the trip lands first and supersedes the lease.
		applyProviderOverloadCooldown(
			"anthropic",
			Date.now() + 60_000,
			"claude-opus-4-5",
		);

		const info = captureLogs("info");
		const debug = captureLogs("debug");
		try {
			completeProviderOverloadProbe(token, "reopened", "sse_overloaded_error");
		} finally {
			info.restore();
			debug.restore();
		}
		const line = info.lines.find((l) => l.includes("settled reopened"));
		expect(line).toBeDefined();
		expect(line).toContain("evidence=sse_overloaded_error");
		expect(line).toMatch(/after \d+ms/);
		// Nothing about this verdict may be DEBUG-only.
		expect(debug.lines.some((l) => l.includes("completion ignored"))).toBe(
			false,
		);
	});

	it("names both the applied and the superseded bucket on a composite probe", async () => {
		// A probe that leased BOTH the family bucket and the provider-wide one is
		// routinely PARTIALLY superseded: a 529 re-trips only the family bucket,
		// so that lease is gone while the provider-wide lease still applies.
		// Reporting only the applied keys would drop the bucket that actually
		// re-tripped, even though admission had named both.
		applyProviderOverloadCooldown(
			"anthropic",
			Date.now() + 5,
			"claude-opus-4-5",
		);
		applyProviderOverloadCooldown("anthropic", Date.now() + 5);
		await new Promise((r) => setTimeout(r, 15));

		const admission = tryAcquireProviderOverloadProbe(
			"anthropic",
			"claude-opus-4-5",
		);
		const token = admission.admitted ? admission.token : null;
		expect(token?.leases.length).toBe(2);

		// Re-trip the FAMILY bucket only — exactly what a family-attributed 529
		// does — leaving the provider-wide lease intact.
		applyProviderOverloadCooldown(
			"anthropic",
			Date.now() + 60_000,
			"claude-opus-4-5",
		);

		const cap = captureLogs("info");
		try {
			completeProviderOverloadProbe(token, "reopened", "http_529");
		} finally {
			cap.restore();
		}
		const line = cap.lines.find((l) => l.includes("settled reopened"));
		expect(line).toBeDefined();
		expect(line).toContain("anthropic-upstream:opus");
		expect(line).toContain("anthropic-upstream");
		expect(line).toContain("superseded:");
	});

	it("distinguishes a re-trip from half-open from an ongoing storm", async () => {
		// Both push the deadline forward, so a naive "did the deadline move?"
		// check calls them both extended. They mean different things: one is a
		// recovery attempt that failed, the other is the storm still running.
		await tripToHalfOpen("claude-opus-4-5");
		const cap = captureLogs("warn");
		try {
			applyProviderOverloadCooldown(
				"anthropic",
				Date.now() + 60_000,
				"claude-opus-4-5",
			);
		} finally {
			cap.restore();
		}
		const line = cap.lines.find((l) => l.includes("Overload breaker"));
		expect(line).toContain("re-tripped(from half-open)");
	});

	it("warns when an expired lease is taken over, naming both probes", async () => {
		await tripToHalfOpen("claude-opus-4-5");
		const first = tryAcquireProviderOverloadProbe(
			"anthropic",
			"claude-opus-4-5",
		);
		const firstToken = first.admitted ? first.token : null;
		expect(firstToken).not.toBeNull();

		// The owner never completes. Past the lease TTL another request may probe;
		// without this WARN that first admission ends with no line at all, which
		// is the only silently-orphaned lifecycle left.
		const wayLater = Date.now() + 2 * 60 * 60_000;
		const cap = captureLogs("warn");
		let replacement: ProbeAdmission | null = null;
		try {
			replacement = tryAcquireProviderOverloadProbe(
				"anthropic",
				"claude-opus-4-5",
				wayLater,
			);
		} finally {
			cap.restore();
		}
		expect(replacement?.admitted).toBe(true);
		const replacementToken = replacement?.admitted ? replacement.token : null;
		expect(replacementToken).not.toBeNull();

		const line = cap.lines.find((l) => l.includes("lease expired"));
		expect(line).toBeDefined();
		// BOTH identities, or the line cannot be used to follow a handover.
		expect(line).toContain(firstToken?.probeId as string);
		expect(line).toContain(replacementToken?.probeId as string);
		expect(line).toContain("admitting replacement");
	});

	it("names the bucket generation on the admission line", async () => {
		await tripToHalfOpen("claude-opus-4-5");
		const cap = captureLogs("info");
		try {
			tryAcquireProviderOverloadProbe("anthropic", "claude-opus-4-5");
		} finally {
			cap.restore();
		}
		const line = cap.lines.find((l) => l.includes("admitted for"));
		expect(line).toBeDefined();
		// Generation ties the probe to the exact trip it is testing, so
		// concurrent family incidents stay distinguishable in one journal.
		expect(line).toMatch(/anthropic-upstream:opus@g\d+/);
		expect(line).toContain("single-flight");
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
