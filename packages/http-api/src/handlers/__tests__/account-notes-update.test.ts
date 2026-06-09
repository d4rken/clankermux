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
import { createAccountNotesUpdateHandler } from "../accounts";

const TEST_DB_PATH = "/tmp/test-account-notes-update.db";

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
		[id, name, "anthropic", "tok", Date.now(), 0],
	);
	return id;
}

/** Read the raw notes value (or null) for an account. */
async function readNotes(
	dbOps: DatabaseOperations,
	id: string,
): Promise<string | null> {
	const db = dbOps.getAdapter();
	const row = await db.get<{ notes: string | null }>(
		"SELECT notes FROM accounts WHERE id = ?",
		[id],
	);
	return row?.notes ?? null;
}

/** Build a fake POST Request carrying the given JSON body. */
function makeRequest(body: unknown): Request {
	return new Request("http://localhost/api/accounts/x/notes", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("createAccountNotesUpdateHandler", () => {
	let dbOps: DatabaseOperations;
	let handler: (req: Request, accountId: string) => Promise<Response>;

	beforeAll(() => {
		if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
		handler = createAccountNotesUpdateHandler(dbOps);
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

	it("valid notes returns success and persists the value", async () => {
		const id = await insertAccount(dbOps, "acc1");

		const response = await handler(
			makeRequest({ notes: "  primary account  " }),
			id,
		);
		const data = (await response.json()) as {
			success: boolean;
			notes: string | null;
		};

		expect(response.status).toBe(200);
		expect(data.success).toBe(true);
		// trimmed
		expect(data.notes).toBe("primary account");
		expect(await readNotes(dbOps, id)).toBe("primary account");
	});

	it("empty string stores null", async () => {
		const id = await insertAccount(dbOps, "acc2");
		// Pre-seed a value so we can verify it gets cleared.
		await dbOps
			.getAdapter()
			.run("UPDATE accounts SET notes = ? WHERE id = ?", ["existing", id]);

		const response = await handler(makeRequest({ notes: "" }), id);
		const data = (await response.json()) as { notes: string | null };

		expect(response.status).toBe(200);
		expect(data.notes).toBeNull();
		expect(await readNotes(dbOps, id)).toBeNull();
	});

	it("whitespace-only string stores null", async () => {
		const id = await insertAccount(dbOps, "acc3");
		await dbOps
			.getAdapter()
			.run("UPDATE accounts SET notes = ? WHERE id = ?", ["existing", id]);

		const response = await handler(makeRequest({ notes: "    \n\t  " }), id);
		const data = (await response.json()) as { notes: string | null };

		expect(response.status).toBe(200);
		expect(data.notes).toBeNull();
		expect(await readNotes(dbOps, id)).toBeNull();
	});

	it("null notes stores null (clear)", async () => {
		const id = await insertAccount(dbOps, "acc4");
		await dbOps
			.getAdapter()
			.run("UPDATE accounts SET notes = ? WHERE id = ?", ["existing", id]);

		const response = await handler(makeRequest({ notes: null }), id);
		const data = (await response.json()) as { notes: string | null };

		expect(response.status).toBe(200);
		expect(data.notes).toBeNull();
		expect(await readNotes(dbOps, id)).toBeNull();
	});

	it("notes over 2000 chars returns 400", async () => {
		const id = await insertAccount(dbOps, "acc5");

		const response = await handler(
			makeRequest({ notes: "x".repeat(2001) }),
			id,
		);

		expect(response.status).toBe(400);
		// must not have persisted anything
		expect(await readNotes(dbOps, id)).toBeNull();
	});

	it("notes at exactly 2000 chars is accepted", async () => {
		const id = await insertAccount(dbOps, "acc6");

		const response = await handler(
			makeRequest({ notes: "y".repeat(2000) }),
			id,
		);

		expect(response.status).toBe(200);
		expect(await readNotes(dbOps, id)).toBe("y".repeat(2000));
	});

	it("unknown account returns 404", async () => {
		const response = await handler(
			makeRequest({ notes: "ghost" }),
			"nonexistent-id",
		);
		expect(response.status).toBe(404);
	});
});
