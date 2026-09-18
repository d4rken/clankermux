import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, it } from "bun:test";
import {
	AccountRepository,
	BunSqlAdapter,
	type DatabaseOperations,
	ensureSchema,
} from "@clankermux/database";
import { getForcedAccount, setForcedAccount } from "@clankermux/proxy";
import {
	createAccountDisabledHandler,
	createAccountForceHandler,
	createAccountRefreshUsageHandler,
} from "../accounts";

let db: Database;
let repo: AccountRepository;
let dbOps: DatabaseOperations;
const req = () =>
	new Request("http://localhost/api/accounts/saved/disable", {
		method: "POST",
	});
beforeEach(() => {
	db = new Database(":memory:");
	ensureSchema(db);
	const adapter = new BunSqlAdapter(db);
	repo = new AccountRepository(adapter);
	db.run(
		"INSERT INTO accounts (id, name, created_at, provider, paused, pause_reason) VALUES ('saved', 'Saved', 1, 'zai', 1, 'subscription_expired')",
	);
	dbOps = {
		getAccount: (id: string) => repo.findById(id),
		getAdapter: () => adapter,
		setAccountDisabled: (id: string, disabled: boolean, date: string) =>
			repo.setDisabled(id, disabled, date),
	} as unknown as DatabaseOperations;
});
afterEach(() => {
	db.close();
	setForcedAccount(null);
});

it("disables by id, clears force, rejects upstream actions, and explicitly enables without erasing health", async () => {
	setForcedAccount("saved");
	expect(
		(await createAccountDisabledHandler(dbOps, true)(req(), "saved")).status,
	).toBe(200);
	expect(getForcedAccount()).toBeNull();
	expect(await repo.findAll()).toEqual([]);
	expect((await createAccountForceHandler(dbOps)(req(), "saved")).status).toBe(
		400,
	);
	expect(
		(await createAccountRefreshUsageHandler(dbOps)(req(), "saved")).status,
	).toBe(400);
	expect(
		(await createAccountDisabledHandler(dbOps, false)(req(), "saved")).status,
	).toBe(200);
	expect((await repo.findAll())[0]).toMatchObject({
		disabled: false,
		paused: true,
		pause_reason: "subscription_expired",
	});
});

it("returns 404 for a missing account", async () => {
	expect(
		(await createAccountDisabledHandler(dbOps, true)(req(), "missing")).status,
	).toBe(404);
});

it("reports a failed access recheck separately after enabling", async () => {
	db.run(
		"UPDATE accounts SET provider = 'codex', disabled = 1 WHERE id = 'saved'",
	);
	const response = await createAccountDisabledHandler(dbOps, false)(
		req(),
		"saved",
	);
	expect(response.status).toBe(200);
	const body = await response.json();
	expect(body.success).toBe(true);
	expect(body.disabled).toBe(false);
	expect(typeof body.recheckError).toBe("string");
	expect((await repo.findById("saved"))?.disabled).toBe(false);
});
