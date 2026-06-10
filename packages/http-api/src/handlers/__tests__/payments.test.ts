/**
 * Tests for the payments mutation handlers: POST /api/payments (manual entry),
 * POST /api/payments/seed (bulk backfill), DELETE /api/payments/:id (soft
 * delete). Real temp sqlite DB via DatabaseOperations (ensureSchema).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "@clankermux/database";
import type { AccountPayment, AccountPaymentRow } from "@clankermux/types";
import {
	createPaymentCreateHandler,
	createPaymentDeleteHandler,
	createPaymentsSeedHandler,
} from "../payments";

let tmpDir: string;
let dbOps: DatabaseOperations;
let createHandler: (req: Request) => Promise<Response>;
let seedHandler: (req: Request) => Promise<Response>;
let deleteHandler: (paymentId: string) => Promise<Response>;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "clankermux-payments-"));
	dbOps = new DatabaseOperations(join(tmpDir, "test.db"));
	createHandler = createPaymentCreateHandler(dbOps);
	seedHandler = createPaymentsSeedHandler(dbOps);
	deleteHandler = createPaymentDeleteHandler(dbOps);
});

afterEach(async () => {
	await dbOps.dispose();
	rmSync(tmpDir, { recursive: true, force: true });
});

async function insertAccount(id: string, name: string): Promise<void> {
	await dbOps.getAdapter().run(
		`INSERT INTO accounts (id, name, provider, refresh_token, created_at, priority)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[id, name, "anthropic", "tok", Date.now(), 0],
	);
}

async function allPaymentRows(): Promise<AccountPaymentRow[]> {
	return dbOps
		.getAdapter()
		.query<AccountPaymentRow>(
			"SELECT * FROM account_payments ORDER BY recorded_at",
			[],
		);
}

function postJson(url: string, body: unknown): Request {
	return new Request(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("POST /api/payments", () => {
	it("inserts a manual credit payment and returns 201 with the created state", async () => {
		await insertAccount("acct-1", "Alpha");

		const response = await createHandler(
			postJson("http://localhost/api/payments", {
				accountId: "acct-1",
				kind: "credits",
				paidDate: "2026-06-01",
				amountUsd: 12.5,
				notes: "top-up",
			}),
		);

		expect(response.status).toBe(201);
		const data = (await response.json()) as {
			success: boolean;
			payment: AccountPayment;
		};
		expect(data.success).toBe(true);
		expect(data.payment.accountId).toBe("acct-1");
		expect(data.payment.accountName).toBe("Alpha");
		expect(data.payment.kind).toBe("credits");
		expect(data.payment.paidDate).toBe("2026-06-01");
		expect(data.payment.amountUsd).toBe(12.5);
		expect(data.payment.source).toBe("manual");
		expect(data.payment.notes).toBe("top-up");

		const rows = await allPaymentRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.amount_usd_micros).toBe(12_500_000);
	});

	it("updates an existing auto subscription row in place (no duplicate, source becomes manual)", async () => {
		await insertAccount("acct-1", "Alpha");
		const inserted = await dbOps.recordAutoPayment(
			"acct-1",
			"Alpha",
			"2026-06-01",
			20_000_000,
		);
		expect(inserted).toBe(true);

		const response = await createHandler(
			postJson("http://localhost/api/payments", {
				accountId: "acct-1",
				kind: "subscription",
				paidDate: "2026-06-01",
				amountUsd: 25,
			}),
		);
		expect(response.status).toBe(201);

		const rows = await allPaymentRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.amount_usd_micros).toBe(25_000_000);
		expect(rows[0]?.source).toBe("manual");
		expect(rows[0]?.deleted_at).toBeNull();
	});

	it("returns 404 for an unknown account", async () => {
		const response = await createHandler(
			postJson("http://localhost/api/payments", {
				accountId: "missing",
				kind: "credits",
				paidDate: "2026-06-01",
				amountUsd: 5,
			}),
		);
		expect(response.status).toBe(404);
		expect(await allPaymentRows()).toHaveLength(0);
	});

	it("rejects an invalid kind with 400", async () => {
		await insertAccount("acct-1", "Alpha");
		const response = await createHandler(
			postJson("http://localhost/api/payments", {
				accountId: "acct-1",
				kind: "refund",
				paidDate: "2026-06-01",
				amountUsd: 5,
			}),
		);
		expect(response.status).toBe(400);
	});

	it("rejects a malformed date with 400", async () => {
		await insertAccount("acct-1", "Alpha");
		const response = await createHandler(
			postJson("http://localhost/api/payments", {
				accountId: "acct-1",
				kind: "credits",
				paidDate: "06/01/2026",
				amountUsd: 5,
			}),
		);
		expect(response.status).toBe(400);
	});

	it("rejects an impossible calendar date with 400", async () => {
		await insertAccount("acct-1", "Alpha");
		const response = await createHandler(
			postJson("http://localhost/api/payments", {
				accountId: "acct-1",
				kind: "credits",
				paidDate: "2026-02-30",
				amountUsd: 5,
			}),
		);
		expect(response.status).toBe(400);
	});

	it("rejects non-positive and non-number amounts with 400", async () => {
		await insertAccount("acct-1", "Alpha");
		for (const amountUsd of [0, -1, "12.5"]) {
			const response = await createHandler(
				postJson("http://localhost/api/payments", {
					accountId: "acct-1",
					kind: "credits",
					paidDate: "2026-06-01",
					amountUsd,
				}),
			);
			expect(response.status).toBe(400);
		}
		expect(await allPaymentRows()).toHaveLength(0);
	});
});

describe("POST /api/payments/seed", () => {
	it("inserts a mixed batch and reports counts", async () => {
		await insertAccount("acct-1", "Alpha");
		await insertAccount("acct-2", "Beta");

		const response = await seedHandler(
			postJson("http://localhost/api/payments/seed", {
				payments: [
					{
						accountId: "acct-1",
						kind: "subscription",
						paidDate: "2026-04-01",
						amountUsd: 20,
					},
					{
						accountId: "acct-1",
						kind: "subscription",
						paidDate: "2026-05-01",
						amountUsd: 20,
					},
					{
						accountId: "acct-2",
						kind: "credits",
						paidDate: "2026-05-10",
						amountUsd: 50,
						importKey: "seed-credit-1",
						notes: "bulk",
					},
				],
			}),
		);

		expect(response.status).toBe(200);
		const data = (await response.json()) as {
			inserted: number;
			updated: number;
		};
		expect(data.inserted).toBe(3);
		expect(data.updated).toBe(0);

		const rows = await allPaymentRows();
		expect(rows).toHaveLength(3);
		expect(rows.every((r) => r.source === "backfill")).toBe(true);
	});

	it("is idempotent on retry (same importKeys, same subscription dates)", async () => {
		await insertAccount("acct-1", "Alpha");
		const body = {
			payments: [
				{
					accountId: "acct-1",
					kind: "subscription",
					paidDate: "2026-04-01",
					amountUsd: 20,
				},
				{
					accountId: "acct-1",
					kind: "credits",
					paidDate: "2026-05-10",
					amountUsd: 50,
					importKey: "seed-credit-1",
				},
			],
		};

		const first = await seedHandler(
			postJson("http://localhost/api/payments/seed", body),
		);
		expect(first.status).toBe(200);
		expect((await first.json()) as object).toEqual({
			inserted: 2,
			updated: 0,
		});

		const retry = await seedHandler(
			postJson("http://localhost/api/payments/seed", body),
		);
		expect(retry.status).toBe(200);
		expect((await retry.json()) as object).toEqual({
			inserted: 0,
			updated: 2,
		});

		expect(await allPaymentRows()).toHaveLength(2);
	});

	it("rejects a credits row missing importKey with 400 and writes nothing", async () => {
		await insertAccount("acct-1", "Alpha");

		const response = await seedHandler(
			postJson("http://localhost/api/payments/seed", {
				payments: [
					{
						accountId: "acct-1",
						kind: "subscription",
						paidDate: "2026-04-01",
						amountUsd: 20,
					},
					{
						accountId: "acct-1",
						kind: "credits",
						paidDate: "2026-05-10",
						amountUsd: 50,
					},
				],
			}),
		);

		expect(response.status).toBe(400);
		const data = (await response.json()) as { error: string };
		expect(data.error).toContain("1");
		expect(await allPaymentRows()).toHaveLength(0);
	});

	it("blocks the whole batch when any row is invalid (listing bad indices)", async () => {
		await insertAccount("acct-1", "Alpha");

		const response = await seedHandler(
			postJson("http://localhost/api/payments/seed", {
				payments: [
					{
						accountId: "acct-1",
						kind: "subscription",
						paidDate: "2026-04-01",
						amountUsd: 20,
					},
					{
						accountId: "acct-1",
						kind: "subscription",
						paidDate: "2026-02-30",
						amountUsd: 20,
					},
					{
						accountId: "no-such-account",
						kind: "subscription",
						paidDate: "2026-05-01",
						amountUsd: 20,
					},
				],
			}),
		);

		expect(response.status).toBe(400);
		const data = (await response.json()) as { error: string };
		expect(data.error).toContain("1");
		expect(data.error).toContain("2");
		expect(await allPaymentRows()).toHaveLength(0);
	});

	it("rejects a missing/empty payments array with 400", async () => {
		const response = await seedHandler(
			postJson("http://localhost/api/payments/seed", { payments: [] }),
		);
		expect(response.status).toBe(400);
	});
});

describe("DELETE /api/payments/:id", () => {
	it("soft-deletes a payment (row kept, excluded from recent), second delete 404s", async () => {
		await insertAccount("acct-1", "Alpha");
		await createHandler(
			postJson("http://localhost/api/payments", {
				accountId: "acct-1",
				kind: "credits",
				paidDate: "2026-06-01",
				amountUsd: 5,
			}),
		);
		const rows = await allPaymentRows();
		expect(rows).toHaveLength(1);
		const id = rows[0]?.id as string;

		const response = await deleteHandler(id);
		expect(response.status).toBe(200);

		const after = await allPaymentRows();
		expect(after).toHaveLength(1);
		expect(after[0]?.deleted_at).not.toBeNull();
		expect(await dbOps.getRecentPayments(20)).toHaveLength(0);

		const second = await deleteHandler(id);
		expect(second.status).toBe(404);
	});

	it("returns 404 for an unknown id", async () => {
		const response = await deleteHandler("nope");
		expect(response.status).toBe(404);
	});
});
