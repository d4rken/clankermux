import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import type { Config } from "@clankermux/config";
import { DatabaseFactory, type DatabaseOperations } from "@clankermux/database";
import { mockFetch, tempDbTracker } from "@clankermux/test-support";
import type { AccountPermissionReader } from "../handlers/routing";
import { APIRouter } from "../router";
import type { APIContext } from "../types";

/**
 * Model discovery for a new account rides on the router's post-mutation
 * `tick()`, so a refused add must not fire it and an accepted one must.
 */
const tmp = tempDbTracker("router-account-add-tick");

describe("router: model-discovery tick after an account add", () => {
	let dbOps: DatabaseOperations;
	let fetchSpy: ReturnType<typeof spyOn>;
	let tick: ReturnType<typeof mock<() => Promise<void>>>;

	beforeEach(() => {
		DatabaseFactory.initialize(tmp.next());
		dbOps = DatabaseFactory.getInstance();
		tick = mock(async () => {});
	});

	afterEach(() => {
		fetchSpy.mockRestore();
		try {
			DatabaseFactory.reset();
		} finally {
			tmp.cleanup();
		}
	});

	function answerProbe(status: number) {
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			mockFetch(async () => new Response(null, { status })),
		);
	}

	async function addMimo() {
		const modelPermissions = {
			tick,
			permissions: async () => {
				throw new Error("not used");
			},
			refresh: async () => {},
		} as unknown as AccountPermissionReader;
		const context = {
			db: dbOps.getAdapter(),
			config: {} as Config,
			dbOps,
			modelPermissions,
		} as APIContext;
		const url = new URL("http://localhost/api/accounts/mimo");
		return new APIRouter(context).handleRequest(
			url,
			new Request(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "mimo-1", apiKey: "tp-key" }),
			}),
		);
	}

	it("fires tick() after a successful add", async () => {
		answerProbe(200);

		const response = await addMimo();

		expect(response?.status).toBe(200);
		expect(tick).toHaveBeenCalledTimes(1);
	});

	it("does not fire tick() when the credential check refuses the add", async () => {
		answerProbe(401);

		const response = await addMimo();

		expect(response?.status).toBe(400);
		expect(tick).not.toHaveBeenCalled();
	});
});
