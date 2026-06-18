import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	setSystemTime,
} from "bun:test";
import {
	cacheBodyStore,
	MAX_STAGING_ENTRIES,
	STAGING_MAX_AGE_MS,
} from "../cache-body-store";
import { sessionCacheStore } from "../session-cache-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHeaders(entries: Record<string, string> = {}): Headers {
	return new Headers(entries);
}

/**
 * A body large enough to clear the 100k cached-token gate when paired with the
 * cached-token counts the routing tests pass. The cache_control hint makes
 * stageRequest accept it; the model id drives the cache-write-premium gate.
 */
function makeBody(
	text = '{"model":"claude-opus-4-8","system":[{"type":"text","text":"cached","cache_control":{"type":"ephemeral"}}]}',
) {
	return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function makeBodyWithoutCacheHint() {
	return makeBody('{"model":"claude-opus-4-8"}');
}

function makeBodyWithModel(model: string) {
	return makeBody(
		`{"model":"${model}","system":[{"type":"text","text":"cached","cache_control":{"type":"ephemeral"}}]}`,
	);
}

function makeEmptyBody(): ArrayBuffer {
	return new ArrayBuffer(0);
}

// A premium Anthropic model with cached-token counts comfortably above 100k.
const PREMIUM_MODEL = "claude-opus-4-8";
const BIG_CREATION = 120_000;
const BIG_READ = 30_000;

// ---------------------------------------------------------------------------
// Reset singleton state between every test
// ---------------------------------------------------------------------------

beforeEach(() => {
	cacheBodyStore.setEnabled(false);
	cacheBodyStore.setEnabled(true);
	// onSummary routes into the per-session store — isolate it too.
	sessionCacheStore.clear();
	sessionCacheStore.setEnabled(true);
	sessionCacheStore.setMinTokens(100_000);
});

afterEach(() => {
	cacheBodyStore.setEnabled(false);
	sessionCacheStore.setEnabled(false);
	sessionCacheStore.clear();
	setSystemTime(); // reset any fake clock set by age-based tests
});

// ---------------------------------------------------------------------------

describe("CacheBodyStore", () => {
	// -----------------------------------------------------------------------
	// setEnabled
	// -----------------------------------------------------------------------

	describe("setEnabled(false)", () => {
		it("clears in-flight staged entries", () => {
			cacheBodyStore.stageRequest(
				"req-2",
				"account-b",
				makeBody(),
				makeHeaders(),
				"/v1/messages",
			);
			expect(cacheBodyStore.getStagingSize()).toBe(1);

			cacheBodyStore.setEnabled(false);
			cacheBodyStore.setEnabled(true);

			expect(cacheBodyStore.getStagingSize()).toBe(0);
			// The cleared staging entry can no longer be routed.
			cacheBodyStore.onSummary("req-2", BIG_CREATION, BIG_READ, PREMIUM_MODEL);
			expect(sessionCacheStore.getSize()).toBe(0);
		});
	});

	// -----------------------------------------------------------------------
	// stageRequest — skip conditions
	// -----------------------------------------------------------------------

	describe("stageRequest skips", () => {
		it("skips when disabled", () => {
			cacheBodyStore.setEnabled(false);
			cacheBodyStore.stageRequest(
				"req-disabled",
				"account-a",
				makeBody(),
				makeHeaders(),
				"/v1/messages",
			);
			expect(cacheBodyStore.getStagingSize()).toBe(0);
		});

		it("skips when accountId is null", () => {
			cacheBodyStore.stageRequest(
				"req-no-account",
				null,
				makeBody(),
				makeHeaders(),
				"/v1/messages",
			);
			expect(cacheBodyStore.getStagingSize()).toBe(0);
		});

		it("skips when body is null", () => {
			cacheBodyStore.stageRequest(
				"req-null-body",
				"account-a",
				null,
				makeHeaders(),
				"/v1/messages",
			);
			expect(cacheBodyStore.getStagingSize()).toBe(0);
		});

		it("skips when body is empty (byteLength === 0)", () => {
			cacheBodyStore.stageRequest(
				"req-empty-body",
				"account-a",
				makeEmptyBody(),
				makeHeaders(),
				"/v1/messages",
			);
			expect(cacheBodyStore.getStagingSize()).toBe(0);
		});

		it("skips /v1/messages bodies without cache-control hints", () => {
			cacheBodyStore.stageRequest(
				"req-no-cache-hint",
				"account-a",
				makeBodyWithoutCacheHint(),
				makeHeaders({ "content-type": "application/json" }),
				"/v1/messages",
			);
			expect(cacheBodyStore.getStagingSize()).toBe(0);
		});

		it("skips cache-control bodies outside /v1/messages", () => {
			cacheBodyStore.stageRequest(
				"req-wrong-path",
				"account-a",
				makeBody(),
				makeHeaders({ "content-type": "application/json" }),
				"/v1/completions",
			);
			expect(cacheBodyStore.getStagingSize()).toBe(0);
		});

		it("stages an entry when all conditions are met", () => {
			cacheBodyStore.stageRequest(
				"req-ok",
				"account-a",
				makeBody(),
				makeHeaders({ "content-type": "application/json" }),
				"/v1/messages",
			);
			expect(cacheBodyStore.getStagingSize()).toBe(1);
		});

		it("stages when body contains a hyphenated cache-control hint", () => {
			cacheBodyStore.stageRequest(
				"req-hyphen-hint",
				"account-a",
				makeBody(
					'{"model":"claude-opus-4-8","cache-control":{"type":"ephemeral"}}',
				),
				makeHeaders({ "content-type": "application/json" }),
				"/v1/messages",
			);
			expect(cacheBodyStore.getStagingSize()).toBe(1);
		});
	});

	// -----------------------------------------------------------------------
	// stageRequest — header sanitization (the routed slot carries sanitized headers)
	// -----------------------------------------------------------------------

	describe("stageRequest header sanitization", () => {
		const sensitiveHeaders: Record<string, string> = {
			authorization: "Bearer sk-ant-secret",
			"x-api-key": "secret-key",
			cookie: "session=abc123",
			"x-claude-code-session-id": "claude-session-id",
			"thread-id": "codex-thread-id",
			"session-id": "codex-session-id",
			"x-client-request-id": "client-request-id",
			"x-codex-installation-id": "codex-installation-id",
			"x-codex-window-id": "codex-thread-id:1",
			"x-codex-turn-state": "turn-state-token",
			"chatgpt-account-id": "chatgpt-account-id",
			traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
			tracestate: "vendor=value",
			"x-clankermux-account-id": "internal-id",
			"x-clankermux-bypass-session": "1",
			"x-clankermux-skip-cache": "true",
			"content-length": "42",
			"transfer-encoding": "chunked",
			"accept-encoding": "gzip, deflate",
			"content-encoding": "gzip",
			connection: "keep-alive",
			"keep-alive": "timeout=5",
			upgrade: "websocket",
			"proxy-authorization": "Basic xyz",
			"proxy-authenticate": "Basic realm=proxy",
			host: "api.anthropic.com",
		};

		const safeHeaders: Record<string, string> = {
			"anthropic-version": "2023-06-01",
			"anthropic-beta": "max-tokens-3-5-sonnet-2024-07-15",
			"content-type": "application/json",
			"user-agent": "Claude-Code/1.0",
		};

		it("strips sensitive/internal headers and keeps safe ones on the routed slot", () => {
			cacheBodyStore.stageRequest(
				"req-strip",
				"account-a",
				makeBody(),
				makeHeaders({ ...sensitiveHeaders, ...safeHeaders }),
				"/v1/messages",
				"session-strip",
			);
			cacheBodyStore.onSummary(
				"req-strip",
				BIG_CREATION,
				BIG_READ,
				PREMIUM_MODEL,
			);

			expect(sessionCacheStore.getSize()).toBe(1);
			const slot = sessionCacheStore.getAllSlots()[0];

			for (const key of Object.keys(sensitiveHeaders)) {
				expect(slot.headers[key]).toBeUndefined();
			}
			for (const [key, value] of Object.entries(safeHeaders)) {
				expect(slot.headers[key]).toBe(value);
			}
		});
	});

	// -----------------------------------------------------------------------
	// onSummary — always clears staging
	// -----------------------------------------------------------------------

	describe("onSummary", () => {
		it("always deletes the staging entry after call", () => {
			cacheBodyStore.stageRequest(
				"req-del",
				"account-a",
				makeBody(),
				makeHeaders(),
				"/v1/messages",
			);
			expect(cacheBodyStore.getStagingSize()).toBe(1);
			cacheBodyStore.onSummary("req-del", 0);
			expect(cacheBodyStore.getStagingSize()).toBe(0);

			// Call again — should be a no-op, not throw.
			expect(() =>
				cacheBodyStore.onSummary("req-del", BIG_CREATION),
			).not.toThrow();
		});

		it("handles unknown requestId gracefully without throwing", () => {
			expect(() =>
				cacheBodyStore.onSummary("req-does-not-exist", BIG_CREATION),
			).not.toThrow();
		});
	});

	// -----------------------------------------------------------------------
	// onSummary — session-store routing
	// -----------------------------------------------------------------------

	describe("onSummary session routing", () => {
		it("registers into sessionCacheStore for a premium, large, cache-creating keyed request", () => {
			expect(sessionCacheStore.getSize()).toBe(0);

			cacheBodyStore.stageRequest(
				"req-keyed",
				"account-keyed",
				makeBodyWithModel(PREMIUM_MODEL),
				makeHeaders({ "content-type": "application/json" }),
				"/v1/messages",
				"session-abc",
			);
			cacheBodyStore.onSummary(
				"req-keyed",
				BIG_CREATION,
				BIG_READ,
				PREMIUM_MODEL,
			);

			expect(sessionCacheStore.getSize()).toBe(1);
			const slot = sessionCacheStore.getAllSlots()[0];
			expect(slot.accountId).toBe("account-keyed");
			expect(slot.sessionKey).toBe("session-abc");
			// cachedTokens = read + creation
			expect(slot.cachedTokens).toBe(BIG_READ + BIG_CREATION);
			// Staging cleaned up.
			expect(cacheBodyStore.getStagingSize()).toBe(0);
		});

		it("uses a synthetic per-account key when sessionKey is null", () => {
			cacheBodyStore.stageRequest(
				"req-unkeyed",
				"account-unkeyed",
				makeBodyWithModel(PREMIUM_MODEL),
				makeHeaders({ "content-type": "application/json" }),
				"/v1/messages",
				null,
			);
			cacheBodyStore.onSummary(
				"req-unkeyed",
				BIG_CREATION,
				BIG_READ,
				PREMIUM_MODEL,
			);

			expect(sessionCacheStore.getSize()).toBe(1);
			const slot = sessionCacheStore.getAllSlots()[0];
			expect(slot.accountId).toBe("account-unkeyed");
			expect(slot.sessionKey).toBe("__account__:account-unkeyed");
		});

		it("touches an existing session slot on a cache-READ turn (creation=0, read>0)", () => {
			// Seed a slot via a cache-CREATING request, then spend some budget.
			cacheBodyStore.stageRequest(
				"req-seed",
				"account-read",
				makeBodyWithModel(PREMIUM_MODEL),
				makeHeaders({ "content-type": "application/json" }),
				"/v1/messages",
				"session-read",
			);
			cacheBodyStore.onSummary(
				"req-seed",
				BIG_CREATION,
				BIG_READ,
				PREMIUM_MODEL,
			);
			expect(sessionCacheStore.getSize()).toBe(1);

			// Charge a keepalive hit so spentUsd > 0.
			sessionCacheStore.recordKeepaliveResult(
				"account-read",
				"session-read",
				true,
				1,
			);
			let slot = sessionCacheStore.getAllSlots()[0];
			expect(slot.spentUsd).toBeGreaterThan(0);

			// A cache-READ turn (creation=0, read>0) on the same session.
			cacheBodyStore.stageRequest(
				"req-read",
				"account-read",
				makeBodyWithModel(PREMIUM_MODEL),
				makeHeaders({ "content-type": "application/json" }),
				"/v1/messages",
				"session-read",
			);
			cacheBodyStore.onSummary("req-read", 0, 150_000, PREMIUM_MODEL);

			// Still one slot; budget reset (spentUsd back to 0).
			expect(sessionCacheStore.getSize()).toBe(1);
			slot = sessionCacheStore.getAllSlots()[0];
			expect(slot.spentUsd).toBe(0);
			expect(slot.lastKeepaliveTs).toBeNull();
			expect(cacheBodyStore.getStagingSize()).toBe(0);
		});

		it("does NOT register a new slot on a cache-READ turn when none exists", () => {
			expect(sessionCacheStore.getSize()).toBe(0);
			cacheBodyStore.stageRequest(
				"req-read-noslot",
				"account-noslot",
				makeBodyWithModel(PREMIUM_MODEL),
				makeHeaders({ "content-type": "application/json" }),
				"/v1/messages",
				"session-noslot",
			);
			cacheBodyStore.onSummary("req-read-noslot", 0, 150_000, PREMIUM_MODEL);

			// touchActivity is a no-op on a missing slot — nothing created.
			expect(sessionCacheStore.getSize()).toBe(0);
			expect(cacheBodyStore.getStagingSize()).toBe(0);
		});

		it("stores nothing when cached tokens are below the min-token threshold", () => {
			cacheBodyStore.stageRequest(
				"req-small",
				"account-small",
				makeBodyWithModel(PREMIUM_MODEL),
				makeHeaders({ "content-type": "application/json" }),
				"/v1/messages",
				"session-small",
			);
			// 5_000 + 1_000 = 6_000 cached tokens, well under 100k.
			cacheBodyStore.onSummary("req-small", 5_000, 1_000, PREMIUM_MODEL);

			expect(sessionCacheStore.getSize()).toBe(0);
		});

		it("stores nothing for a model without a cache-write premium (cache_write == 0, e.g. zai/GLM)", () => {
			cacheBodyStore.stageRequest(
				"req-nopremium",
				"account-nopremium",
				makeBodyWithModel("glm-4.5"),
				makeHeaders({ "content-type": "application/json" }),
				"/v1/messages",
				"session-nopremium",
			);
			cacheBodyStore.onSummary(
				"req-nopremium",
				BIG_CREATION,
				BIG_READ,
				"glm-4.5",
			);

			expect(sessionCacheStore.getSize()).toBe(0);
		});

		it("does NOT register on a zero-creation, zero-read summary", () => {
			cacheBodyStore.stageRequest(
				"req-zero",
				"account-zero",
				makeBodyWithModel(PREMIUM_MODEL),
				makeHeaders({ "content-type": "application/json" }),
				"/v1/messages",
				"session-zero",
			);
			cacheBodyStore.onSummary("req-zero", 0, 0, PREMIUM_MODEL);

			expect(sessionCacheStore.getSize()).toBe(0);
		});
	});

	// -----------------------------------------------------------------------
	// discardStaged
	// -----------------------------------------------------------------------

	describe("discardStaged", () => {
		it("removes a staged entry so it can never be routed", () => {
			cacheBodyStore.stageRequest(
				"req-discard",
				"account-discard",
				makeBody(),
				makeHeaders(),
				"/v1/messages",
				"session-discard",
			);
			expect(cacheBodyStore.getStagingSize()).toBe(1);

			cacheBodyStore.discardStaged("req-discard");
			expect(cacheBodyStore.getStagingSize()).toBe(0);

			cacheBodyStore.onSummary(
				"req-discard",
				BIG_CREATION,
				BIG_READ,
				PREMIUM_MODEL,
			);
			expect(sessionCacheStore.getSize()).toBe(0);
		});

		it("is a no-op for an unknown requestId", () => {
			expect(() => cacheBodyStore.discardStaged("nope")).not.toThrow();
		});
	});

	// -----------------------------------------------------------------------
	// staging memory-safety: size, size cap, age sweep, discard
	// (regression coverage for the cacheBodyStore.staging unbounded-growth leak)
	// -----------------------------------------------------------------------

	describe("getStagingSize", () => {
		it("reflects in-flight staged entries and drops to 0 on summary", () => {
			expect(cacheBodyStore.getStagingSize()).toBe(0);
			cacheBodyStore.stageRequest(
				"req-size",
				"account-a",
				makeBody(),
				makeHeaders(),
				"/v1/messages",
			);
			expect(cacheBodyStore.getStagingSize()).toBe(1);
			cacheBodyStore.onSummary("req-size", 1);
			expect(cacheBodyStore.getStagingSize()).toBe(0);
		});
	});

	describe("staging size cap", () => {
		it("caps staging at MAX_STAGING_ENTRIES, evicting oldest-first", () => {
			for (let i = 0; i < MAX_STAGING_ENTRIES + 5; i++) {
				cacheBodyStore.stageRequest(
					`req-cap-${i}`,
					`account-cap-${i}`,
					makeBody(),
					makeHeaders(),
					"/v1/messages",
				);
			}
			expect(cacheBodyStore.getStagingSize()).toBe(MAX_STAGING_ENTRIES);
		});
	});

	describe("staging age sweep", () => {
		const t0 = new Date("2026-01-01T00:00:00.000Z").getTime();

		it("sweeps entries older than STAGING_MAX_AGE_MS on the next stageRequest", () => {
			setSystemTime(new Date(t0));
			cacheBodyStore.stageRequest(
				"req-aged",
				"account-aged",
				makeBody(),
				makeHeaders(),
				"/v1/messages",
			);
			expect(cacheBodyStore.getStagingSize()).toBe(1);

			// Jump past the max age; a fresh stage triggers the inline sweep.
			setSystemTime(new Date(t0 + STAGING_MAX_AGE_MS + 60_000));
			cacheBodyStore.stageRequest(
				"req-fresh",
				"account-fresh2",
				makeBody(),
				makeHeaders(),
				"/v1/messages",
			);
			// Old orphan swept, only the fresh one remains.
			expect(cacheBodyStore.getStagingSize()).toBe(1);
		});

		it("retains entries younger than STAGING_MAX_AGE_MS (e.g. a long stream)", () => {
			setSystemTime(new Date(t0));
			cacheBodyStore.stageRequest(
				"req-young",
				"account-young",
				makeBody(),
				makeHeaders(),
				"/v1/messages",
			);
			setSystemTime(new Date(t0 + STAGING_MAX_AGE_MS - 60_000));
			cacheBodyStore.stageRequest(
				"req-trigger",
				"account-trigger",
				makeBody(),
				makeHeaders(),
				"/v1/messages",
			);
			expect(cacheBodyStore.getStagingSize()).toBe(2);
		});

		it("evictStaleEntries also reaps orphaned staged entries when idle", () => {
			setSystemTime(new Date(t0));
			cacheBodyStore.stageRequest(
				"req-tick-aged",
				"account-tick",
				makeBody(),
				makeHeaders(),
				"/v1/messages",
			);
			expect(cacheBodyStore.getStagingSize()).toBe(1);

			// No new stageRequest arrives (idle); the keepalive tick must sweep it.
			setSystemTime(new Date(t0 + STAGING_MAX_AGE_MS + 60_000));
			cacheBodyStore.evictStaleEntries();
			expect(cacheBodyStore.getStagingSize()).toBe(0);
		});
	});
});
