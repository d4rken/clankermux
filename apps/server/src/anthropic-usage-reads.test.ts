import { describe, expect, it } from "bun:test";
import type { AnthropicUsageReadRow } from "@clankermux/database";
import type { AnthropicUsageReadStore, UsageData } from "@clankermux/providers";
import { restoreAnthropicUsageReads } from "./anthropic-usage-reads";

function fakes(rows: AnthropicUsageReadRow[] | Error) {
	const restored: Array<[string, unknown]> = [];
	const writes: string[] = [];
	const warnings: string[] = [];
	let store: AnthropicUsageReadStore | null = null;
	const db = {
		getAnthropicUsageReads: async () => {
			if (rows instanceof Error) throw rows;
			return rows;
		},
		recordAnthropicUsageReadAt: async (id: string, at: number) => {
			writes.push(`read ${id} ${at}`);
		},
		recordAnthropicUsageReading: async (
			id: string,
			reading: string,
			at: number,
		) => {
			if (id === "broken") throw new Error("disk full");
			writes.push(`reading ${id} ${reading} ${at}`);
		},
	};
	const cache = {
		restoreAnthropicUsageRead: (id: string, value: unknown) => {
			restored.push([id, value]);
		},
		setAnthropicUsageReadStore: (s: AnthropicUsageReadStore | null) => {
			store = s;
		},
	};
	const log = {
		info: () => {},
		warn: (message: string) => {
			warnings.push(message);
		},
	};
	return {
		db,
		cache,
		log,
		restored,
		writes,
		warnings,
		store: () => store,
	};
}

describe("restoreAnthropicUsageReads", () => {
	it("restores each row, dropping a reading that does not parse", async () => {
		const f = fakes([
			{
				accountId: "a",
				lastReadAt: 100,
				reading: '{"five_hour":null}',
				readingObservedAt: 90,
			},
			{
				accountId: "b",
				lastReadAt: 200,
				reading: "{not json",
				readingObservedAt: 190,
			},
		]);
		await restoreAnthropicUsageReads(f.db, f.cache, f.log);

		expect(f.restored).toEqual([
			[
				"a",
				{
					lastReadAt: 100,
					reading: { five_hour: null },
					readingObservedAt: 90,
				},
			],
			["b", { lastReadAt: 200, reading: null, readingObservedAt: 190 }],
		]);
	});

	it("installs a store that persists reads and readings and swallows write failures", async () => {
		const f = fakes([]);
		await restoreAnthropicUsageReads(f.db, f.cache, f.log);
		const store = f.store();
		if (!store) throw new Error("no store installed");

		store.recordReadAt("a", 5);
		store.recordReading("a", { five_hour: null } as unknown as UsageData, 6);
		store.recordReading("broken", {} as UsageData, 7);
		await Bun.sleep(0);

		expect(f.writes).toEqual(["read a 5", 'reading a {"five_hour":null} 6']);
		expect(f.warnings).toHaveLength(1);
	});

	it("still installs the store when the rows cannot be read", async () => {
		const f = fakes(new Error("locked"));
		await restoreAnthropicUsageReads(f.db, f.cache, f.log);
		expect(f.restored).toEqual([]);
		expect(f.store()).not.toBeNull();
		expect(f.warnings).toHaveLength(1);
	});
});
