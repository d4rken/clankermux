import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import type { DatabaseOperations } from "@clankermux/database";
import { DatabaseFactory } from "@clankermux/database";
import { tempDbTracker } from "@clankermux/test-support";
import { createAccountCustomEndpointUpdateHandler } from "../accounts";

const tmpDb = tempDbTracker("test-account-custom-endpoint-update");

/**
 * The endpoint only means something for providers whose `buildUrl` reads
 * `account.custom_endpoint`. For zai, minimax and ollama-cloud it is pinned in
 * the provider, so a write accepted here would be stored, echoed back by the
 * API and badged in the dashboard while every request still went to the fixed
 * host. The handler refuses those rather than storing a setting that does
 * nothing.
 */

async function insertAccount(
	dbOps: DatabaseOperations,
	name: string,
	provider: string,
): Promise<string> {
	const db = dbOps.getAdapter();
	const id = crypto.randomUUID();
	await db.run(
		`INSERT INTO accounts (id, name, provider, refresh_token, created_at, priority)
     VALUES (?, ?, ?, ?, ?, ?)`,
		[id, name, provider, "tok", Date.now(), 0],
	);
	return id;
}

async function readEndpoint(
	dbOps: DatabaseOperations,
	id: string,
): Promise<string | null> {
	const db = dbOps.getAdapter();
	const row = await db.get<{ custom_endpoint: string | null }>(
		"SELECT custom_endpoint FROM accounts WHERE id = ?",
		[id],
	);
	return row?.custom_endpoint ?? null;
}

function makeRequest(body: unknown): Request {
	return new Request("http://localhost/api/accounts/x/custom-endpoint", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("createAccountCustomEndpointUpdateHandler", () => {
	let dbOps: DatabaseOperations;
	let handler: (req: Request, accountId: string) => Promise<Response>;
	let counter = 0;

	beforeAll(() => {
		DatabaseFactory.initialize(tmpDb.next());
		dbOps = DatabaseFactory.getInstance();
		handler = createAccountCustomEndpointUpdateHandler(dbOps);
	});

	afterAll(() => {
		try {
			DatabaseFactory.reset();
		} finally {
			tmpDb.cleanup();
		}
	});

	beforeEach(() => {
		counter += 1;
	});

	it("stores the endpoint for a provider that honours it", async () => {
		const id = await insertAccount(dbOps, `ok-${counter}`, "anthropic");

		const res = await handler(
			makeRequest({ customEndpoint: "https://mirror.example.com" }),
			id,
		);

		expect(res.status).toBe(200);
		expect(await readEndpoint(dbOps, id)).toBe("https://mirror.example.com");
	});

	it("clears the endpoint when given an empty value", async () => {
		const id = await insertAccount(dbOps, `clear-${counter}`, "anthropic");
		await handler(
			makeRequest({ customEndpoint: "https://mirror.example.com" }),
			id,
		);

		const res = await handler(makeRequest({ customEndpoint: "" }), id);

		expect(res.status).toBe(200);
		expect(await readEndpoint(dbOps, id)).toBeNull();
	});

	for (const provider of ["zai", "minimax", "ollama-cloud"]) {
		it(`refuses ${provider}, whose endpoint is pinned in the provider`, async () => {
			const id = await insertAccount(dbOps, `${provider}-${counter}`, provider);

			const res = await handler(
				makeRequest({ customEndpoint: "https://mirror.example.com" }),
				id,
			);

			expect(res.status).toBe(400);
			// The refusal names the provider, so an operator reading the response
			// learns why rather than just that it failed.
			expect(await res.text()).toContain(provider);
			// Nothing written: the refusal is not a partial apply.
			expect(await readEndpoint(dbOps, id)).toBeNull();
		});
	}

	it("404s for an account that does not exist", async () => {
		const res = await handler(
			makeRequest({ customEndpoint: "https://mirror.example.com" }),
			crypto.randomUUID(),
		);

		expect(res.status).toBe(404);
	});
});
