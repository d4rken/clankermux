import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { DatabaseOperations } from "@clankermux/database";
import { DatabaseFactory } from "@clankermux/database";
import { createAccountRenewalUpdateHandler } from "../accounts";

const TEST_DB_PATH = "/tmp/test-account-renewal-update.db";

/** Insert a minimal account row and return its generated id. */
async function insertAccount(
	dbOps: DatabaseOperations,
	name: string,
): Promise<string> {
	const db = dbOps.getAdapter();
	const id = crypto.randomUUID();
	await db.run(
		`INSERT INTO accounts (id, name, provider, refresh_token, created_at, priority)
     VALUES (?, ?, ?, ?, ?, ?)`,
		[id, name, "openai-compatible", "tok", Date.now(), 0],
	);
	return id;
}

/** Read the raw renewal columns for an account. */
async function readRenewal(
	dbOps: DatabaseOperations,
	id: string,
): Promise<{
	renewal_anchor: string | null;
	renewal_cadence: string | null;
	renewal_price_usd_micros: number | null;
	renewal_auto_start_date: string | null;
}> {
	const db = dbOps.getAdapter();
	const row = await db.get<{
		renewal_anchor: string | null;
		renewal_cadence: string | null;
		renewal_price_usd_micros: number | null;
		renewal_auto_start_date: string | null;
	}>(
		`SELECT renewal_anchor, renewal_cadence, renewal_price_usd_micros,
		        renewal_auto_start_date
		 FROM accounts WHERE id = ?`,
		[id],
	);
	return (
		row ?? {
			renewal_anchor: null,
			renewal_cadence: null,
			renewal_price_usd_micros: null,
			renewal_auto_start_date: null,
		}
	);
}

/** Local "YYYY-MM-DD" of today (matches the handler's auto-start stamping). */
function localToday(): string {
	const d = new Date();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Build a fake POST Request carrying the given JSON body. */
function makeRequest(body: unknown): Request {
	return new Request("http://localhost/api/accounts/x/renewal", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("createAccountRenewalUpdateHandler", () => {
	let dbOps: DatabaseOperations;
	let handler: (req: Request, accountId: string) => Promise<Response>;

	beforeAll(() => {
		if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
		handler = createAccountRenewalUpdateHandler(dbOps);
	});

	afterAll(() => {
		DatabaseFactory.reset();
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch {
			// ignore
		}
	});

	beforeEach(async () => {
		await dbOps.getAdapter().run("DELETE FROM accounts", []);
	});

	it("stores a valid anchor + cadence", async () => {
		const id = await insertAccount(dbOps, "acc1");

		const response = await handler(
			makeRequest({ renewalAnchor: "2026-01-14", renewalCadence: "monthly" }),
			id,
		);
		const data = (await response.json()) as {
			success: boolean;
			renewalAnchor: string | null;
			renewalCadence: string | null;
		};

		expect(response.status).toBe(200);
		expect(data.success).toBe(true);
		expect(data.renewalAnchor).toBe("2026-01-14");
		expect(data.renewalCadence).toBe("monthly");

		const stored = await readRenewal(dbOps, id);
		expect(stored.renewal_anchor).toBe("2026-01-14");
		expect(stored.renewal_cadence).toBe("monthly");
	});

	it("clears the renewal when renewalAnchor is null", async () => {
		const id = await insertAccount(dbOps, "acc2");
		await dbOps.setAccountRenewal(id, "2026-03-31", "yearly", null, null);

		const response = await handler(
			makeRequest({ renewalAnchor: null, renewalCadence: "monthly" }),
			id,
		);
		const data = (await response.json()) as {
			renewalAnchor: string | null;
			renewalCadence: string | null;
		};

		expect(response.status).toBe(200);
		// anchor null forces cadence null too
		expect(data.renewalAnchor).toBeNull();
		expect(data.renewalCadence).toBeNull();

		const stored = await readRenewal(dbOps, id);
		expect(stored.renewal_anchor).toBeNull();
		expect(stored.renewal_cadence).toBeNull();
	});

	it("accepts cadence 'none' (one-time date)", async () => {
		const id = await insertAccount(dbOps, "acc3");

		const response = await handler(
			makeRequest({ renewalAnchor: "2026-06-09", renewalCadence: "none" }),
			id,
		);
		expect(response.status).toBe(200);

		const stored = await readRenewal(dbOps, id);
		expect(stored.renewal_anchor).toBe("2026-06-09");
		expect(stored.renewal_cadence).toBe("none");
	});

	it("rejects an invalid cadence with 400", async () => {
		const id = await insertAccount(dbOps, "acc4");

		const response = await handler(
			makeRequest({ renewalAnchor: "2026-01-14", renewalCadence: "weekly" }),
			id,
		);
		expect(response.status).toBe(400);
	});

	it("rejects a missing cadence with 400", async () => {
		const id = await insertAccount(dbOps, "acc5");

		const response = await handler(
			makeRequest({ renewalAnchor: "2026-01-14" }),
			id,
		);
		expect(response.status).toBe(400);
	});

	it("rejects a malformed anchor with 400", async () => {
		const id = await insertAccount(dbOps, "acc6");

		const response = await handler(
			makeRequest({ renewalAnchor: "01/14/2026", renewalCadence: "monthly" }),
			id,
		);
		expect(response.status).toBe(400);
	});

	it("rejects an impossible calendar date (2026-02-30) with 400", async () => {
		const id = await insertAccount(dbOps, "acc7");

		const response = await handler(
			makeRequest({ renewalAnchor: "2026-02-30", renewalCadence: "monthly" }),
			id,
		);
		expect(response.status).toBe(400);
	});

	it("returns 404 when the account does not exist", async () => {
		const response = await handler(
			makeRequest({ renewalAnchor: "2026-01-14", renewalCadence: "monthly" }),
			"nonexistent-id",
		);
		expect(response.status).toBe(404);
	});

	describe("renewalPriceUsd", () => {
		it("persists the price as micros and stamps auto_start with today on first set", async () => {
			const id = await insertAccount(dbOps, "price1");

			const response = await handler(
				makeRequest({
					renewalAnchor: "2026-01-14",
					renewalCadence: "monthly",
					renewalPriceUsd: 21.5,
				}),
				id,
			);
			const data = (await response.json()) as {
				renewalPriceUsd: number | null;
			};

			expect(response.status).toBe(200);
			expect(data.renewalPriceUsd).toBe(21.5);

			const stored = await readRenewal(dbOps, id);
			expect(stored.renewal_price_usd_micros).toBe(21_500_000);
			expect(stored.renewal_auto_start_date).toBe(localToday());
		});

		it("keeps the existing auto_start when the price changes", async () => {
			const id = await insertAccount(dbOps, "price2");
			await dbOps.setAccountRenewal(
				id,
				"2026-01-14",
				"monthly",
				20_000_000,
				"2026-02-01",
			);

			const response = await handler(
				makeRequest({
					renewalAnchor: "2026-01-14",
					renewalCadence: "monthly",
					renewalPriceUsd: 25,
				}),
				id,
			);
			expect(response.status).toBe(200);

			const stored = await readRenewal(dbOps, id);
			expect(stored.renewal_price_usd_micros).toBe(25_000_000);
			expect(stored.renewal_auto_start_date).toBe("2026-02-01");
		});

		it("clears auto_start when the price is cleared", async () => {
			const id = await insertAccount(dbOps, "price3");
			await dbOps.setAccountRenewal(
				id,
				"2026-01-14",
				"monthly",
				20_000_000,
				"2026-02-01",
			);

			const response = await handler(
				makeRequest({
					renewalAnchor: "2026-01-14",
					renewalCadence: "monthly",
					renewalPriceUsd: null,
				}),
				id,
			);
			const data = (await response.json()) as {
				renewalPriceUsd: number | null;
			};

			expect(response.status).toBe(200);
			expect(data.renewalPriceUsd).toBeNull();

			const stored = await readRenewal(dbOps, id);
			expect(stored.renewal_price_usd_micros).toBeNull();
			expect(stored.renewal_auto_start_date).toBeNull();
		});

		it("clears cadence, price, and auto_start when the anchor is cleared", async () => {
			const id = await insertAccount(dbOps, "price4");
			await dbOps.setAccountRenewal(
				id,
				"2026-01-14",
				"monthly",
				20_000_000,
				"2026-02-01",
			);

			const response = await handler(
				makeRequest({
					renewalAnchor: null,
					renewalCadence: "monthly",
					renewalPriceUsd: 25,
				}),
				id,
			);
			expect(response.status).toBe(200);

			const stored = await readRenewal(dbOps, id);
			expect(stored.renewal_anchor).toBeNull();
			expect(stored.renewal_cadence).toBeNull();
			expect(stored.renewal_price_usd_micros).toBeNull();
			expect(stored.renewal_auto_start_date).toBeNull();
		});

		it("treats an empty-string price as no price", async () => {
			const id = await insertAccount(dbOps, "price5");

			const response = await handler(
				makeRequest({
					renewalAnchor: "2026-01-14",
					renewalCadence: "monthly",
					renewalPriceUsd: "",
				}),
				id,
			);
			expect(response.status).toBe(200);

			const stored = await readRenewal(dbOps, id);
			expect(stored.renewal_price_usd_micros).toBeNull();
			expect(stored.renewal_auto_start_date).toBeNull();
		});

		it("rejects a negative price with 400", async () => {
			const id = await insertAccount(dbOps, "price6");

			const response = await handler(
				makeRequest({
					renewalAnchor: "2026-01-14",
					renewalCadence: "monthly",
					renewalPriceUsd: -5,
				}),
				id,
			);
			expect(response.status).toBe(400);
		});

		it("rejects a zero price with 400", async () => {
			const id = await insertAccount(dbOps, "price7");

			const response = await handler(
				makeRequest({
					renewalAnchor: "2026-01-14",
					renewalCadence: "monthly",
					renewalPriceUsd: 0,
				}),
				id,
			);
			expect(response.status).toBe(400);
		});

		it("rejects a non-number price with 400", async () => {
			const id = await insertAccount(dbOps, "price8");

			const response = await handler(
				makeRequest({
					renewalAnchor: "2026-01-14",
					renewalCadence: "monthly",
					renewalPriceUsd: "12.5",
				}),
				id,
			);
			expect(response.status).toBe(400);
		});
	});
});
