import { afterEach, describe, expect, it } from "bun:test";
import { hashRoutingAffinityKey as hashNullable } from "@clankermux/core";
import { SessionStrategy } from "@clankermux/load-balancer";
import { makeAccount as canonicalAccount } from "@clankermux/test-support";
import type {
	Account,
	AffinityPin,
	RequestMeta,
	StrategyStore,
} from "@clankermux/types";

const hashRoutingAffinityKey = (key: string) => hashNullable(key) as string;

const SESSION_MS = 5 * 60 * 60 * 1000;
const BASE = 1_800_000_000_000;

const store: StrategyStore = { resetAccountSession() {} };

function makeAccount(id: string, priority = 0): Account {
	return canonicalAccount({
		id,
		name: id,
		priority,
		refresh_token: "test",
		access_token: "test",
		expires_at: BASE + 10 * SESSION_MS,
		created_at: BASE,
	});
}

function makeStrategy(): SessionStrategy {
	const strategy = new SessionStrategy(SESSION_MS);
	strategy.initialize(store);
	return strategy;
}

function metaFor(overrides: Partial<RequestMeta>): RequestMeta {
	return {
		id: "req",
		headers: new Headers(),
		path: "/v1/messages",
		method: "POST",
		timestamp: BASE,
		...overrides,
	};
}

const realNow = Date.now;
let clock = BASE;
function setNow(t: number) {
	clock = t;
	Date.now = () => clock;
}
afterEach(() => {
	Date.now = realNow;
});

function pin(key: string, accountId: string, lastUsedAt: number): AffinityPin {
	return {
		keyHash: hashRoutingAffinityKey(key),
		accountId,
		lastUsedAt,
	};
}

describe("SessionStrategy affinity export/import", () => {
	it("exports hashed pins in least-recently-used order", () => {
		const a = makeAccount("acc-a");
		const strategy = makeStrategy();
		setNow(BASE);
		strategy.select([a], metaFor({ project: "first" }));
		setNow(BASE + 10);
		strategy.select([a], metaFor({ project: "second" }));
		setNow(BASE + 20);
		strategy.select([a], metaFor({ project: "first" }));

		expect(strategy.exportAffinity()).toEqual([
			pin("project:second", "acc-a", BASE + 10),
			pin("project:first", "acc-a", BASE + 20),
		]);
	});

	it("round-trips into a fresh strategy that then serves the pin as a hit", () => {
		const a = makeAccount("acc-a", 0);
		const b = makeAccount("acc-b", 1);
		const meta = {
			affinityKey: "conversation",
			affinityScope: "claude_session",
			affinityPartition: "pool-x",
		} as const;
		const before = makeStrategy();
		setNow(BASE);
		// Offered only b, the conversation pins to the lower-priority account.
		before.select([b], metaFor(meta));
		const exported = before.exportAffinity();
		expect(exported).toEqual([
			pin("partition:pool-x:claude_session:conversation", "acc-b", BASE),
		]);

		const after = makeStrategy();
		setNow(BASE + 60_000);
		after.importAffinity(exported, BASE + 60_000);
		expect(after.exportAffinity()).toEqual(exported);

		const next = metaFor(meta);
		const selected = after.select([a, b], next);
		expect(selected[0].id).toBe("acc-b");
		expect(next.routing?.decision).toBe("affinity_hit");
		// Telemetry keeps the raw composite; the recorder hashes it later.
		expect(next.routing?.affinityKey).toBe(
			"partition:pool-x:claude_session:conversation",
		);
	});

	it("round-trips per-model pins and their conversation anchor", () => {
		const a = makeAccount("acc-a", 0);
		const b = makeAccount("acc-b", 1);
		const turn = (model: string) =>
			metaFor({
				affinityKey: "conversation",
				affinityScope: "claude_session",
				affinityModel: model,
			});
		const before = makeStrategy();
		setNow(BASE);
		before.select([a, b], turn("claude-fable-5-1"));
		const side = turn("claude-haiku-4-5");
		before.select([a, b], side);
		before.reassignAffinity(side, b);
		const exported = before.exportAffinity();
		expect(exported).toHaveLength(3);

		const after = makeStrategy();
		setNow(BASE + 60_000);
		after.importAffinity(exported, BASE + 60_000);
		expect(after.exportAffinity()).toEqual(exported);

		for (const [model, account] of [
			["claude-fable-5-1", "acc-a"],
			["claude-haiku-4-5", "acc-b"],
			// A model the conversation never used seeds from the anchor.
			["claude-sonnet-4-5", "acc-a"],
		] as const) {
			const next = turn(model);
			expect(after.select([a, b], next)[0].id).toBe(account);
			expect(next.routing?.decision).toBe("affinity_hit");
		}
	});

	it("drops pins older than the session duration", () => {
		const strategy = makeStrategy();
		const now = BASE + SESSION_MS * 2;
		strategy.importAffinity(
			[
				pin("project:expired", "acc-a", now - SESSION_MS - 1),
				pin("project:live", "acc-a", now - SESSION_MS + 1),
			],
			now,
		);
		expect(strategy.exportAffinity()).toEqual([
			pin("project:live", "acc-a", now - SESSION_MS + 1),
		]);
	});

	it("stores imported pins in ascending order so pruning still stops early", () => {
		const a = makeAccount("acc-a");
		const strategy = makeStrategy();
		const now = BASE + SESSION_MS;
		strategy.importAffinity(
			[
				pin("project:recent", "acc-a", now - 60 * 60 * 1000),
				pin("project:older", "acc-a", now - 4 * 60 * 60 * 1000),
			],
			now,
		);
		expect(strategy.exportAffinity().map((p) => p.lastUsedAt)).toEqual([
			now - 4 * 60 * 60 * 1000,
			now - 60 * 60 * 1000,
		]);

		// 90 minutes on, "older" is past the session duration and "recent" is not.
		setNow(now + 90 * 60 * 1000);
		strategy.select([a], metaFor({ project: "new" }));
		expect(strategy.exportAffinity().map((p) => p.keyHash)).toEqual([
			hashRoutingAffinityKey("project:recent"),
			hashRoutingAffinityKey("project:new"),
		]);
	});

	it("never replaces a newer in-memory pin with an older imported one", () => {
		const a = makeAccount("acc-a");
		const strategy = makeStrategy();
		setNow(BASE);
		strategy.select([a], metaFor({ project: "shared" }));

		strategy.importAffinity(
			[
				pin("project:shared", "acc-old", BASE - 1_000),
				pin("project:other", "acc-b", BASE - 500),
			],
			BASE,
		);
		expect(strategy.exportAffinity()).toEqual([
			pin("project:other", "acc-b", BASE - 500),
			pin("project:shared", "acc-a", BASE),
		]);

		strategy.importAffinity([pin("project:other", "acc-c", BASE)], BASE);
		expect(strategy.exportAffinity()).toEqual([
			pin("project:shared", "acc-a", BASE),
			pin("project:other", "acc-c", BASE),
		]);
	});

	it("keeps only the newest pins when the import exceeds the cap", () => {
		const strategy = makeStrategy();
		const pins = Array.from({ length: 10_001 }, (_, i) =>
			pin(`project:p${i}`, "acc-a", BASE + i),
		);
		strategy.importAffinity(pins, BASE + 10_001);
		const exported = strategy.exportAffinity();
		expect(exported).toHaveLength(10_000);
		expect(exported[0].keyHash).toBe(hashRoutingAffinityKey("project:p1"));
	});

	it("caps imported stamps at now and clamps later writes to them", () => {
		const a = makeAccount("acc-a");
		const strategy = makeStrategy();
		strategy.importAffinity(
			[
				pin("project:future", "acc-a", BASE + 60_000),
				pin("project:past", "acc-a", BASE - 1_000),
			],
			BASE,
		);
		expect(strategy.exportAffinity().map((p) => p.lastUsedAt)).toEqual([
			BASE - 1_000,
			BASE,
		]);

		// The wall clock steps backwards: the new write is clamped up to the
		// newest imported stamp, keeping the map ordered.
		setNow(BASE - 5_000);
		strategy.select([a], metaFor({ project: "later" }));
		expect(strategy.exportAffinity().at(-1)).toEqual(
			pin("project:later", "acc-a", BASE),
		);
	});

	it("advances the revision on every change and only on changes", () => {
		const a = makeAccount("acc-a");
		const strategy = makeStrategy();
		const start = strategy.affinityRevision;

		setNow(BASE);
		strategy.select([a], metaFor({ project: "one" }));
		const afterSelect = strategy.affinityRevision;
		expect(afterSelect).toBeGreaterThan(start);

		strategy.exportAffinity();
		expect(strategy.affinityRevision).toBe(afterSelect);

		strategy.importAffinity([], BASE);
		strategy.importAffinity([pin("project:one", "acc-z", BASE - 1)], BASE);
		expect(strategy.affinityRevision).toBe(afterSelect);

		strategy.importAffinity([pin("project:two", "acc-a", BASE)], BASE);
		const afterImport = strategy.affinityRevision;
		expect(afterImport).toBeGreaterThan(afterSelect);

		expect(strategy.clearAffinityForAccount("acc-none")).toBe(0);
		expect(strategy.affinityRevision).toBe(afterImport);
		expect(strategy.clearAffinityForAccount("acc-a")).toBe(2);
		const afterClear = strategy.affinityRevision;
		expect(afterClear).toBeGreaterThan(afterImport);

		strategy.importAffinity([pin("project:three", "acc-a", BASE)], BASE);
		const beforePrune = strategy.affinityRevision;
		setNow(BASE + SESSION_MS + 1);
		strategy.peek([a]);
		expect(strategy.affinityRevision).toBe(beforePrune);
		strategy.select([a], metaFor({ project: "four" }));
		expect(strategy.exportAffinity().map((p) => p.keyHash)).toEqual([
			hashRoutingAffinityKey("project:four"),
		]);
		expect(strategy.affinityRevision).toBeGreaterThan(beforePrune);
	});

	it("drops an imported pin whose account no longer exists", () => {
		const a = makeAccount("acc-a");
		const strategy = makeStrategy();
		strategy.importAffinity([pin("project:gone", "acc-deleted", BASE)], BASE);
		setNow(BASE + 1_000);
		const meta = metaFor({ project: "gone" });
		expect(strategy.select([a], meta)[0].id).toBe("acc-a");
		expect(meta.routing?.decision).toBe("affinity_reassigned");
		expect(meta.routing?.previousAccountId).toBe("acc-deleted");
		expect(strategy.exportAffinity()).toEqual([
			pin("project:gone", "acc-a", BASE + 1_000),
		]);
	});
});
