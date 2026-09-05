/**
 * The four stop reads under the analytics filter panel.
 *
 * The card these feed moved onto a tab that carries filters, so "N of M
 * requests blocked" is now a claim about a SELECTION rather than about the
 * whole range. Numerator and denominator have to narrow together — a filtered
 * blocked count over an unfiltered total is a rate that is simply wrong — and
 * the candidate distribution, which lives on `request_routing` and carries none
 * of the filter columns, has to reach `requests` to narrow at all.
 *
 * The dataset is built so that each single condition of the combined filter is
 * falsified by exactly one row: whichever predicate were dropped, one extra row
 * would appear.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema } from "../../migrations";
import { RequestRepository } from "../request.repository";
import { EMPTY_REQUEST_FILTERS, type RequestFilters } from "../request-filters";

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);
const SINCE = NOW - 24 * HOUR;

const ACCOUNT_A = "acct-a";
const ACCOUNT_B = "acct-b";
const MODEL_M = "claude-opus-5";
const MODEL_OTHER = "gpt-5.2-codex";
const KEY_K = "key-k";
const KEY_OTHER = "key-other";
const PROJECT_P = "alpha";
const PROJECT_OTHER = "beta";

type Row = {
	id: string;
	account: string | null;
	model: string | null;
	apiKey: string | null;
	project: string | null;
	success: boolean;
	errorMessage: string | null;
	statusCode: number;
	candidates: number;
};

function row(over: Partial<Row> & { id: string }): Row {
	return {
		account: ACCOUNT_A,
		model: MODEL_M,
		apiKey: KEY_K,
		project: PROJECT_P,
		success: false,
		errorMessage: "all_accounts_failed",
		statusCode: 503,
		candidates: 2,
		...over,
	};
}

/**
 * Ten rows. `hit` and `hit-other-cause` satisfy the combined filter
 * `(account A OR no account) AND model M AND key K AND (project P OR no
 * project) AND status error`; each `miss-*` row fails exactly one of its
 * conditions, and the remaining rows exercise the NULL buckets while failing at
 * least two — so widening any single dimension admits exactly the row built to
 * fail it.
 */
const ROWS: Row[] = [
	row({ id: "hit" }),
	row({ id: "miss-account", account: ACCOUNT_B }),
	row({
		id: "miss-model",
		model: MODEL_OTHER,
		errorMessage: "model_not_served",
		statusCode: 400,
	}),
	row({ id: "miss-key", apiKey: KEY_OTHER }),
	row({ id: "miss-project", project: PROJECT_OTHER }),
	row({
		id: "miss-status",
		success: true,
		errorMessage: null,
		statusCode: 200,
	}),
	// SQL-NULL account: only reachable through `accountsNone`. It fails TWO of
	// the combined filter's conditions (project and model), so it cannot stand
	// in for either single-condition miss row below.
	row({
		id: "null-account",
		account: null,
		project: PROJECT_OTHER,
		model: MODEL_OTHER,
	}),
	// SQL-NULL project: only reachable through `projectsNone`. Fails two
	// conditions as well (account and key).
	row({
		id: "null-project",
		project: null,
		account: ACCOUNT_B,
		apiKey: KEY_OTHER,
		errorMessage: "family_weekly_exhausted",
		statusCode: 429,
	}),
	// A second success, so the denominator is not simply "all failures + 1".
	row({
		id: "success-b",
		account: ACCOUNT_B,
		success: true,
		errorMessage: null,
		statusCode: 200,
		candidates: 3,
	}),
	// Distinct cause under the SAME filter-matching dimensions as `hit`, so a
	// filtered read still returns more than one message group where it should.
	row({
		id: "hit-other-cause",
		errorMessage: "provider_overloaded",
		statusCode: 529,
		project: null,
		candidates: 1,
	}),
];

function filters(over: Partial<RequestFilters> = {}): RequestFilters {
	return { ...EMPTY_REQUEST_FILTERS, ...over };
}

const COMBINED = filters({
	accounts: [ACCOUNT_A],
	accountsNone: true,
	models: [MODEL_M],
	apiKeys: [KEY_K],
	projects: [PROJECT_P],
	projectsNone: true,
	status: "error",
});

let db: Database;
let repo: RequestRepository;

beforeEach(() => {
	db = new Database(":memory:");
	ensureSchema(db);
	const insertRequest = db.prepare(
		`INSERT INTO requests
			(id, timestamp, method, path, account_used, status_code, success,
			 error_message, response_time_ms, failover_attempts, model,
			 requested_model, api_key_id, api_key_name, project)
		 VALUES (?, ?, 'POST', '/v1/messages', ?, ?, ?, ?, 100, 0, ?, ?, ?, ?, ?)`,
	);
	const insertRouting = db.prepare(
		`INSERT INTO request_routing
			(request_id, strategy, decision, affinity_scope, affinity_key_hash,
			 selected_account_id, previous_account_id, candidates_count,
			 failover_attempts, failover_reason, created_at)
		 VALUES (?, 'session', 'ordered', NULL, NULL, ?, NULL, ?, 0, NULL, ?)`,
	);
	for (const r of ROWS) {
		insertRequest.run(
			r.id,
			NOW - HOUR,
			r.account,
			r.statusCode,
			r.success ? 1 : 0,
			r.errorMessage,
			r.model,
			r.model,
			r.apiKey,
			r.apiKey === null ? null : "key-name",
			r.project,
		);
		insertRouting.run(r.id, r.account, r.candidates, NOW - HOUR);
	}
	repo = new RequestRepository(new BunSqlAdapter(db));
});

afterEach(() => {
	db.close();
});

/** Total blocked requests the bucket read accounts for. */
async function blocked(f?: RequestFilters): Promise<number> {
	const rows = await repo.getStopsByBucket({
		sinceMs: SINCE,
		bucketMs: HOUR,
		filters: f,
	});
	return rows.reduce((sum, r) => sum + r.count, 0);
}

/** Total blocked requests the model breakdown accounts for. */
async function blockedByModel(f?: RequestFilters): Promise<number> {
	const rows = await repo.getStopModelBreakdown({ sinceMs: SINCE, filters: f });
	return rows.reduce((sum, r) => sum + r.count, 0);
}

/** Total routing rows the candidate distribution accounts for. */
async function observed(f?: RequestFilters): Promise<number> {
	const rows = await repo.getCandidateCountDistribution({
		sinceMs: SINCE,
		filters: f,
	});
	return rows.reduce((sum, r) => sum + r.requests, 0);
}

const FAILURES = ROWS.filter((r) => !r.success).length;

describe("stop reads with no filters", () => {
	it("count the whole range, exactly as before", async () => {
		expect(await blocked()).toBe(FAILURES);
		expect(await blockedByModel()).toBe(FAILURES);
		expect(await repo.countRequestsSince({ sinceMs: SINCE })).toBe(ROWS.length);
		expect(await observed()).toBe(ROWS.length);
	});

	it("treat a cleared selection the same as none at all", async () => {
		expect(await blocked(EMPTY_REQUEST_FILTERS)).toBe(FAILURES);
		expect(await blockedByModel(EMPTY_REQUEST_FILTERS)).toBe(FAILURES);
		expect(
			await repo.countRequestsSince({
				sinceMs: SINCE,
				filters: EMPTY_REQUEST_FILTERS,
			}),
		).toBe(ROWS.length);
		expect(await observed(EMPTY_REQUEST_FILTERS)).toBe(ROWS.length);
	});
});

describe("stop reads under a single filter", () => {
	it("narrow to one API key", async () => {
		const f = filters({ apiKeys: [KEY_K] });
		const expected = ROWS.filter((r) => r.apiKey === KEY_K);
		expect(await blocked(f)).toBe(expected.filter((r) => !r.success).length);
		expect(await blockedByModel(f)).toBe(
			expected.filter((r) => !r.success).length,
		);
		expect(await repo.countRequestsSince({ sinceMs: SINCE, filters: f })).toBe(
			expected.length,
		);
		expect(await observed(f)).toBe(expected.length);
	});

	it("narrow to one model", async () => {
		const f = filters({ models: [MODEL_M] });
		const expected = ROWS.filter((r) => r.model === MODEL_M);
		expect(await blocked(f)).toBe(expected.filter((r) => !r.success).length);
		expect(await repo.countRequestsSince({ sinceMs: SINCE, filters: f })).toBe(
			expected.length,
		);
		expect(await observed(f)).toBe(expected.length);
	});

	it("select ONLY the no-account bucket for accountsNone alone", async () => {
		// The bucket the moved card's description warns about: a request blocked
		// before an account was chosen carries no account at all.
		const f = filters({ accountsNone: true });
		expect(await repo.countRequestsSince({ sinceMs: SINCE, filters: f })).toBe(
			1,
		);
		expect(await blocked(f)).toBe(1);
		expect(await observed(f)).toBe(1);
	});

	it("add the no-account bucket to the named accounts", async () => {
		const f = filters({ accounts: [ACCOUNT_A], accountsNone: true });
		const expected = ROWS.filter(
			(r) => r.account === ACCOUNT_A || r.account === null,
		);
		expect(await repo.countRequestsSince({ sinceMs: SINCE, filters: f })).toBe(
			expected.length,
		);
		expect(await blocked(f)).toBe(expected.filter((r) => !r.success).length);
		expect(await observed(f)).toBe(expected.length);
	});

	it("add the no-project bucket to the named projects", async () => {
		const f = filters({ projects: [PROJECT_P], projectsNone: true });
		const expected = ROWS.filter(
			(r) => r.project === PROJECT_P || r.project === null,
		);
		expect(await repo.countRequestsSince({ sinceMs: SINCE, filters: f })).toBe(
			expected.length,
		);
		expect(await blocked(f)).toBe(expected.filter((r) => !r.success).length);
		expect(await observed(f)).toBe(expected.length);
	});

	it("leave the failure reads empty under status=success while the total still counts", async () => {
		const f = filters({ status: "success" });
		const successes = ROWS.filter((r) => r.success).length;
		expect(await blocked(f)).toBe(0);
		expect(await blockedByModel(f)).toBe(0);
		// The denominator is still a real measurement of the selection.
		expect(await repo.countRequestsSince({ sinceMs: SINCE, filters: f })).toBe(
			successes,
		);
		expect(await observed(f)).toBe(successes);
	});
});

describe("stop reads under the combined filter", () => {
	it("return exactly the one row that satisfies every condition", async () => {
		// `hit-other-cause` matches too (its project is NULL, covered by
		// projectsNone), so the expectation is those two and nothing else.
		const rows = await repo.getStopsByBucket({
			sinceMs: SINCE,
			bucketMs: HOUR,
			filters: COMBINED,
		});
		expect(rows.map((r) => r.errorMessage).sort()).toEqual([
			"all_accounts_failed",
			"provider_overloaded",
		]);
		expect(rows.reduce((sum, r) => sum + r.count, 0)).toBe(2);
	});

	it("drops a row for each single condition that would be lost", async () => {
		// Widening any one dimension admits exactly the row built to fail it.
		const base = await repo.countRequestsSince({
			sinceMs: SINCE,
			filters: COMBINED,
		});
		expect(base).toBe(2);

		const widened: Array<[string, RequestFilters]> = [
			["account", { ...COMBINED, accounts: [ACCOUNT_A, ACCOUNT_B] }],
			["model", { ...COMBINED, models: [MODEL_M, MODEL_OTHER] }],
			["key", { ...COMBINED, apiKeys: [KEY_K, KEY_OTHER] }],
			["project", { ...COMBINED, projects: [PROJECT_P, PROJECT_OTHER] }],
			["status", { ...COMBINED, status: "all" }],
		];
		for (const [label, f] of widened) {
			const count = await repo.countRequestsSince({
				sinceMs: SINCE,
				filters: f,
			});
			expect(`${label}:${count}`).toBe(`${label}:3`);
		}
	});

	it("names the model of the blocked rows and nothing else", async () => {
		const rows = await repo.getStopModelBreakdown({
			sinceMs: SINCE,
			filters: COMBINED,
		});
		expect(rows.every((r) => r.model === MODEL_M)).toBe(true);
		expect(rows.reduce((sum, r) => sum + r.count, 0)).toBe(2);
	});

	it("reports the candidate counts of only the joined rows", async () => {
		// `hit` has 2 candidates, `hit-other-cause` has 1 — and nothing else in
		// the table may contribute.
		const rows = await repo.getCandidateCountDistribution({
			sinceMs: SINCE,
			filters: COMBINED,
		});
		expect(rows).toEqual([
			{ candidatesCount: 1, requests: 1 },
			{ candidatesCount: 2, requests: 1 },
		]);
	});

	it("counts a routing row only when a matching request row exists", async () => {
		// The join is the whole mechanism: `request_routing` carries none of the
		// filter columns, so without it a filtered distribution would report the
		// unfiltered table. Foreign keys are off on this connection (bun:sqlite's
		// default, and this suite never turns them on), so deleting the request
		// leaves its routing row behind — an orphan the unfiltered read still
		// counts and the filtered read must not.
		db.run("DELETE FROM requests WHERE id = 'hit'");
		expect(
			db
				.query(
					"SELECT request_id FROM request_routing WHERE request_id = 'hit'",
				)
				.all(),
		).toHaveLength(1);

		expect(await observed()).toBe(ROWS.length);
		const rows = await repo.getCandidateCountDistribution({
			sinceMs: SINCE,
			filters: COMBINED,
		});
		expect(rows).toEqual([{ candidatesCount: 1, requests: 1 }]);
	});
});
