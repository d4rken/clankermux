/**
 * The pooled figure must be the class's BEST headroom, must never evict a cache
 * entry account selection depends on, and must never manufacture a zero.
 *
 * Each of those has a specific failure it pins. Reporting the worst member (or a
 * mean) would raise an alarm for a spent account the router is already routing
 * around. Reading through `getFreshCapacity` would evict entries out from under
 * selection, because that helper uses the evicting accessors. And folding an
 * unreadable account in as if it were exhausted would put a 100% meter on screen
 * while the pool was still serving.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { usageCache } from "@clankermux/providers";
import type { Account } from "@clankermux/types";
import { computePoolHeadroom } from "../pool-headroom";

const NOW = Date.now();
const HOUR_MS = 3_600_000;

const seeded: string[] = [];

afterEach(() => {
	// The cache is a process-wide singleton; leaking entries would silently
	// change what a later test in the same process observes.
	for (const id of seeded.splice(0)) usageCache.delete(id);
});

/**
 * The usage cache is a process-wide singleton shared with every other suite in
 * this run, so every id here is namespaced. Short bare names like "a" or
 * "claude" would be a live collision hazard against another file's fixtures.
 */
const key = (id: string): string => `phs-${id}`;

function account(id: string, provider = "anthropic"): Account {
	return { id: key(id), name: id, provider } as unknown as Account;
}

/** Seed the shared cache with flat Anthropic-shaped windows. */
function seed(
	id: string,
	windows: {
		fiveHourPct?: number | null;
		fiveHourResetMs?: number | null;
		weeklyPct?: number;
		weeklyResetMs?: number | null;
		codexCredits?: { hasCredits: boolean; unlimited: boolean };
	},
): void {
	seeded.push(key(id));
	usageCache.set(key(id), {
		five_hour:
			windows.fiveHourPct == null
				? null
				: {
						utilization: windows.fiveHourPct,
						resets_at:
							windows.fiveHourResetMs == null
								? null
								: new Date(windows.fiveHourResetMs).toISOString(),
					},
		seven_day: {
			utilization: windows.weeklyPct ?? 0,
			resets_at:
				windows.weeklyResetMs == null
					? null
					: new Date(windows.weeklyResetMs).toISOString(),
		},
		...(windows.codexCredits
			? {
					codexCredits: {
						...windows.codexCredits,
						balance: null,
						planType: "pro",
						weeklyUsedPct: null,
					},
				}
			: {}),
	} as never);
}

const noHeaders = new Headers();

describe("computePoolHeadroom", () => {
	it("reports the BEST headroom in the class, not the worst or the mean", () => {
		seed("a", { weeklyPct: 10, weeklyResetMs: NOW + 48 * HOUR_MS });
		seed("b", { weeklyPct: 60, weeklyResetMs: NOW + 48 * HOUR_MS });
		seed("c", { weeklyPct: 95, weeklyResetMs: NOW + 2 * HOUR_MS });

		const figures = computePoolHeadroom(
			account("a"),
			[account("a"), account("b"), account("c")],
			noHeaders,
			NOW,
		);

		expect(figures.weekly?.headroomPct).toBe(90);
		expect(figures.weekly?.complete).toBe(true);
	});

	it("takes the reset of the member that WON, not the soonest in the class", () => {
		// Pairing the best member's utilization with a spent sibling's imminent
		// reset would tell the client it is nearly through a window it has barely
		// started, and suppress pacing warnings for the rest of the window.
		seed("best", { weeklyPct: 10, weeklyResetMs: NOW + 48 * HOUR_MS });
		seed("spent", { weeklyPct: 99, weeklyResetMs: NOW + HOUR_MS });

		const figures = computePoolHeadroom(
			account("best"),
			[account("best"), account("spent")],
			noHeaders,
			NOW,
		);

		expect(figures.weekly?.resetMs).toBe(NOW + 48 * HOUR_MS);
	});

	it("falls back to the soonest reset once the whole class is tied at spent", () => {
		// All tied at zero headroom, so the tie-break degenerates to exactly the
		// question the user is asking: when does the block lift?
		seed("x", { weeklyPct: 100, weeklyResetMs: NOW + 30 * HOUR_MS });
		seed("y", { weeklyPct: 100, weeklyResetMs: NOW + 3 * HOUR_MS });

		const figures = computePoolHeadroom(
			account("x"),
			[account("x"), account("y")],
			noHeaders,
			NOW,
		);

		expect(figures.weekly?.headroomPct).toBe(0);
		expect(figures.weekly?.resetMs).toBe(NOW + 3 * HOUR_MS);
	});

	it("ignores accounts from a different servable class", () => {
		// A GPT account cannot cover for a Claude request, so folding its headroom
		// in would claim a failover that cannot happen.
		seed("claude", { weeklyPct: 90, weeklyResetMs: NOW + 48 * HOUR_MS });
		seed("gpt", { weeklyPct: 5, weeklyResetMs: NOW + 48 * HOUR_MS });

		const figures = computePoolHeadroom(
			account("claude"),
			[account("claude"), account("gpt", "codex")],
			noHeaders,
			NOW,
		);

		expect(figures.weekly?.headroomPct).toBe(10);
	});

	it("includes the serving account even when it is not among the candidates", () => {
		// The burst hold reprobes an affinity-pinned account regardless of gate
		// position, so a figure that excluded the account which just served would
		// contradict itself.
		seed("serving", { weeklyPct: 20, weeklyResetMs: NOW + 48 * HOUR_MS });
		seed("other", { weeklyPct: 70, weeklyResetMs: NOW + 48 * HOUR_MS });

		const figures = computePoolHeadroom(
			account("serving"),
			[account("other")],
			noHeaders,
			NOW,
		);

		expect(figures.weekly?.headroomPct).toBe(80);
	});

	it("marks the window incomplete when a member has no cache entry", () => {
		seed("known", { weeklyPct: 40, weeklyResetMs: NOW + 48 * HOUR_MS });

		const figures = computePoolHeadroom(
			account("known"),
			[account("known"), account("never-seeded")],
			noHeaders,
			NOW,
		);

		expect(figures.weekly?.headroomPct).toBe(60);
		expect(figures.weekly?.complete).toBe(false);
	});

	it("returns null for a window no member could speak for", () => {
		// Null is what stops the writers emitting anything, so this is the path
		// that guarantees an unreadable pool leaves the upstream headers alone
		// rather than reporting a fabricated zero.
		const figures = computePoolHeadroom(
			account("unseeded"),
			[account("unseeded")],
			noHeaders,
			NOW,
		);

		expect(figures.weekly).toBeNull();
		expect(figures.session).toBeNull();
	});

	it("does not evict the entries it reads", () => {
		// The regression that matters most here: selection reads the same cache,
		// and an observer that evicts would degrade routing every time a response
		// was forwarded.
		seed("keep-me", { weeklyPct: 40, weeklyResetMs: NOW + 48 * HOUR_MS });

		computePoolHeadroom(
			account("keep-me"),
			[account("keep-me")],
			noHeaders,
			NOW,
		);

		expect(usageCache.peek(key("keep-me"))).not.toBeNull();
	});

	it("treats a codex account holding credits as unreadable for the weekly window", () => {
		// Credits let an account serve past 100% while still reporting 100%, so
		// its reading cannot bound anything and must not be allowed to assert an
		// exhausted pool.
		seed("codex-credits", {
			weeklyPct: 100,
			weeklyResetMs: NOW + 48 * HOUR_MS,
			codexCredits: { hasCredits: true, unlimited: false },
		});

		const figures = computePoolHeadroom(
			account("codex-credits", "codex"),
			[account("codex-credits", "codex")],
			noHeaders,
			NOW,
		);

		expect(figures.weekly).toBeNull();
	});

	it("prefers the serving account's own wire reading over a stale cached one", () => {
		// The response being forwarded is strictly fresher than anything the cache
		// can hold for that account.
		seed("serving", { weeklyPct: 80, weeklyResetMs: NOW + 48 * HOUR_MS });

		const figures = computePoolHeadroom(
			account("serving"),
			[account("serving")],
			new Headers({
				"anthropic-ratelimit-unified-7d-status": "allowed",
				"anthropic-ratelimit-unified-7d-utilization": "0.30",
				"anthropic-ratelimit-unified-7d-reset": String(
					Math.floor((NOW + 48 * HOUR_MS) / 1000),
				),
			}),
			NOW,
		);

		expect(figures.weekly?.headroomPct).toBe(70);
	});

	it("reports no session window for a codex-only class", () => {
		// codex retired its rolling 5h window, so there is no account-wide session
		// figure to pool. This falls out of the readings rather than being a
		// special case.
		seed("codex", {
			fiveHourPct: null,
			weeklyPct: 50,
			weeklyResetMs: NOW + 48 * HOUR_MS,
		});

		const figures = computePoolHeadroom(
			account("codex", "codex"),
			[account("codex", "codex")],
			noHeaders,
			NOW,
		);

		expect(figures.session).toBeNull();
		expect(figures.weekly?.headroomPct).toBe(50);
	});

	it("pools the session window independently of the weekly one", () => {
		seed("a", {
			fiveHourPct: 70,
			fiveHourResetMs: NOW + HOUR_MS,
			weeklyPct: 90,
			weeklyResetMs: NOW + 48 * HOUR_MS,
		});
		seed("b", {
			fiveHourPct: 15,
			fiveHourResetMs: NOW + 2 * HOUR_MS,
			weeklyPct: 95,
			weeklyResetMs: NOW + 48 * HOUR_MS,
		});

		const figures = computePoolHeadroom(
			account("a"),
			[account("a"), account("b")],
			noHeaders,
			NOW,
		);

		expect(figures.session?.headroomPct).toBe(85);
		expect(figures.session?.resetMs).toBe(NOW + 2 * HOUR_MS);
		expect(figures.weekly?.headroomPct).toBe(10);
	});

	it("drops a reset that is already in the past", () => {
		seed("a", { weeklyPct: 40, weeklyResetMs: NOW - HOUR_MS });

		const figures = computePoolHeadroom(
			account("a"),
			[account("a")],
			noHeaders,
			NOW,
		);

		expect(figures.weekly?.headroomPct).toBe(60);
		expect(figures.weekly?.resetMs).toBeNull();
	});
});
