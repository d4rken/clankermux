/**
 * The raw upstream-response observation hook.
 *
 * The hook exists because both kinds of evidence it captures are destroyed on
 * the way to the client — one by the openai-formats header sanitizer, one by the
 * Codex provider's normalization — so it has to run on the raw response, and it
 * has to keep what normalization would throw away.
 *
 * The load-bearing properties here are the KEYS: one observation id per upstream
 * ATTEMPT (so a failover's two responses stay apart) and one captured instant
 * per attempt (so every row of one response is dated identically).
 */
import { describe, expect, it, mock, spyOn } from "bun:test";
import { Logger } from "@clankermux/logger";
import type {
	Account,
	CodexWindowObservationRow,
	OpenAiBucketObservationRow,
} from "@clankermux/types";
import {
	captureRawUpstreamObservation,
	type RawObservationSink,
} from "../raw-response-observations";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "codex",
		api_key: null,
		refresh_token: null,
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		codex_auto_apply_reset_credits_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	};
}

interface Harness {
	sink: RawObservationSink;
	codex: CodexWindowObservationRow[][];
	buckets: OpenAiBucketObservationRow[][];
	enqueueCalls: number;
}

function makeHarness(opts: { enqueueAccepts?: boolean } = {}): Harness {
	const accepts = opts.enqueueAccepts ?? true;
	const codex: CodexWindowObservationRow[][] = [];
	const buckets: OpenAiBucketObservationRow[][] = [];
	const harness: Harness = {
		codex,
		buckets,
		enqueueCalls: 0,
		sink: undefined as unknown as RawObservationSink,
	};
	harness.sink = {
		asyncWriter: {
			enqueue: (job: () => void | Promise<void>) => {
				harness.enqueueCalls++;
				if (!accepts) return false;
				void job();
				return true;
			},
		},
		dbOps: {
			saveCodexWindowObservations: mock(
				async (rows: CodexWindowObservationRow[]) => {
					codex.push(rows);
				},
			),
			saveOpenAiBucketObservations: mock(
				async (rows: OpenAiBucketObservationRow[]) => {
					buckets.push(rows);
				},
			),
		},
	};
	return harness;
}

const CODEX_HEADERS = {
	"x-codex-primary-used-percent": "43.5",
	"x-codex-primary-window-minutes": "10080",
	"x-codex-secondary-used-percent": "0",
	"x-codex-active-limit": "primary",
};

const BUCKET_HEADERS = {
	"x-ratelimit-limit-tokens": "2000000",
	"x-ratelimit-remaining-tokens": "1999000",
	"x-ratelimit-reset-tokens": "6m0s",
};

function capture(
	h: Harness,
	opts: {
		headers: Record<string, string>;
		account?: Account | null;
		requestId?: string;
		source?: "client" | "keepalive" | "auto-refresh";
		httpStatus?: number;
		endpoint?: string | null;
	},
): void {
	captureRawUpstreamObservation(
		{
			requestId: opts.requestId ?? "req-1",
			account: opts.account === undefined ? makeAccount() : opts.account,
			source: opts.source ?? "client",
			requestStartedAt: 1_700_000_000_000,
			endpoint: opts.endpoint === undefined ? "/v1/responses" : opts.endpoint,
			httpStatus: opts.httpStatus ?? 200,
			headers: new Headers(opts.headers),
		},
		h.sink,
	);
}

describe("captureRawUpstreamObservation", () => {
	it("records the Codex window lines of a response", () => {
		const h = makeHarness();
		capture(h, { headers: CODEX_HEADERS });

		expect(h.codex).toHaveLength(1);
		const rows = h.codex[0];
		expect(rows.map((r) => r.slot)).toEqual(["primary", "secondary"]);
		expect(rows[0].requestId).toBe("req-1");
		expect(rows[0].accountId).toBe("acc-1");
		expect(rows[0].usedPercent).toBe(43.5);
		expect(rows[0].activeLimit).toBe("primary");
		// Root rows carry the empty string, never null — the UNIQUE binding
		// depends on it.
		expect(rows.every((r) => r.familyCodename === "")).toBe(true);
	});

	it("dates every row of one response identically", () => {
		const h = makeHarness();
		capture(h, { headers: { ...CODEX_HEADERS, ...BUCKET_HEADERS } });

		const observedAt = h.codex[0][0].observedAt;
		expect(h.codex[0].every((r) => r.observedAt === observedAt)).toBe(true);
		// The bucket rows share the SAME instant: one clock read per attempt.
		expect(h.buckets[0].every((r) => r.observedAt === observedAt)).toBe(true);
		expect(observedAt).toBeGreaterThan(1_700_000_000_000);
	});

	it("gives one attempt ONE observation id, and two attempts two", () => {
		const h = makeHarness();
		capture(h, { headers: { ...CODEX_HEADERS, ...BUCKET_HEADERS } });
		capture(h, { headers: { ...CODEX_HEADERS, ...BUCKET_HEADERS } });

		const first = h.codex[0][0].observationId;
		// Every row of one attempt shares its id — across both tables.
		expect(h.codex[0].every((r) => r.observationId === first)).toBe(true);
		expect(h.buckets[0].every((r) => r.observationId === first)).toBe(true);
		// A second attempt for the SAME logical request gets its own id, or the
		// failover's readings would be dropped as duplicates.
		expect(h.codex[1][0].observationId).not.toBe(first);
		expect(h.codex[1][0].requestId).toBe("req-1");
	});

	it("records the OpenAI bucket readings with the endpoint they came from", () => {
		const h = makeHarness();
		capture(h, {
			headers: BUCKET_HEADERS,
			endpoint: "/v1/chat/completions",
			httpStatus: 429,
		});

		expect(h.buckets).toHaveLength(1);
		expect(h.buckets[0]).toHaveLength(1);
		expect(h.buckets[0][0]).toMatchObject({
			bucket: "tokens",
			limitValue: 2_000_000,
			remaining: 1_999_000,
			resetRaw: "6m0s",
			endpoint: "/v1/chat/completions",
			httpStatus: 429,
			source: "client",
		});
	});

	it("labels an internal probe's rows with the probe source", () => {
		const h = makeHarness();
		capture(h, { headers: CODEX_HEADERS, source: "auto-refresh" });
		expect(h.codex[0].every((r) => r.source === "auto-refresh")).toBe(true);

		// Buckets too: a probe routed through an openai-compatible account spends
		// the same buckets client traffic does, and an unlabelled row folds that
		// burn into the demand signal.
		const buckets = makeHarness();
		capture(buckets, { headers: BUCKET_HEADERS, source: "keepalive" });
		expect(buckets.buckets[0].every((r) => r.source === "keepalive")).toBe(
			true,
		);
	});

	it("writes nothing when the response carries neither kind of header", () => {
		const h = makeHarness();
		capture(h, { headers: { "content-type": "application/json" } });
		expect(h.enqueueCalls).toBe(0);
		expect(h.codex).toHaveLength(0);
		expect(h.buckets).toHaveLength(0);
	});

	it("writes nothing for an unauthenticated attempt", () => {
		const h = makeHarness();
		capture(h, { headers: CODEX_HEADERS, account: null });
		expect(h.enqueueCalls).toBe(0);
	});

	it("enqueues the two kinds independently", () => {
		const h = makeHarness();
		capture(h, { headers: CODEX_HEADERS });
		expect(h.enqueueCalls).toBe(1);

		const bucketsOnly = makeHarness();
		capture(bucketsOnly, { headers: BUCKET_HEADERS });
		expect(bucketsOnly.enqueueCalls).toBe(1);
		expect(bucketsOnly.codex).toHaveLength(0);
	});

	it("warns when the writer queue rejects a job", () => {
		const lines: string[] = [];
		const spy = spyOn(Logger.prototype, "warn").mockImplementation(
			(message: string) => {
				lines.push(message);
			},
		);
		try {
			const h = makeHarness({ enqueueAccepts: false });
			capture(h, { headers: { ...CODEX_HEADERS, ...BUCKET_HEADERS } });

			expect(h.codex).toHaveLength(0);
			expect(h.buckets).toHaveLength(0);
			expect(
				lines.filter((l) => l.includes("Codex window observation")),
			).toHaveLength(1);
			expect(
				lines.filter((l) => l.includes("OpenAI bucket observation")),
			).toHaveLength(1);
		} finally {
			spy.mockRestore();
		}
	});
});
