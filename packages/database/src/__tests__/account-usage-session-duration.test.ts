import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { tempDbTracker } from "@clankermux/test-support";
import { DatabaseOperations } from "../database-operations";

const tmpDb = tempDbTracker("account-usage-session-duration");
const HOUR_MS = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

describe("account usage session duration", () => {
	let dbOps: DatabaseOperations;
	let clock: ReturnType<typeof spyOn<typeof Date, "now">>;

	beforeEach(() => {
		dbOps = new DatabaseOperations(tmpDb.next());
		clock = spyOn(Date, "now").mockReturnValue(NOW);
	});

	afterEach(async () => {
		clock.mockRestore();
		try {
			await dbOps?.close();
		} finally {
			tmpDb.cleanup();
		}
	});

	it.each([
		{
			name: "preserves a configured zero duration",
			duration: 0,
			ageHours: 2,
			resets: true,
		},
		{
			name: "keeps an unexpired configured session",
			duration: 3 * HOUR_MS,
			ageHours: 2,
			resets: false,
		},
		{
			name: "resets an expired configured session",
			duration: HOUR_MS,
			ageHours: 2,
			resets: true,
		},
		{
			name: "keeps the configured five-hour default",
			duration: 5 * HOUR_MS,
			ageHours: 2,
			resets: false,
		},
		{
			name: "uses five hours without runtime config for an unexpired session",
			duration: undefined,
			ageHours: 2,
			resets: false,
		},
		{
			name: "uses five hours without runtime config for an expired session",
			duration: undefined,
			ageHours: 6,
			resets: true,
		},
	])("$name", async ({ duration, ageHours, resets }) => {
		if (duration !== undefined) {
			dbOps.setRuntimeConfig({
				clientId: "test-client",
				port: 8080,
				sessionDurationMs: duration,
			});
		}
		const sessionStart = NOW - ageHours * HOUR_MS;
		await dbOps.getAdapter().run(
			`INSERT INTO accounts (id, name, provider, created_at, refresh_token,
				request_count, total_requests, session_start, session_request_count)
			 VALUES ('acc-1', 'test', 'anthropic', ?, 'rt', 10, 20, ?, 3)`,
			[NOW, sessionStart],
		);

		await dbOps.updateAccountUsage("acc-1");

		expect(await dbOps.getAccount("acc-1")).toMatchObject({
			last_used: NOW,
			request_count: 11,
			total_requests: 21,
			session_start: resets ? NOW : sessionStart,
			session_request_count: resets ? 1 : 4,
		});
	});
});
