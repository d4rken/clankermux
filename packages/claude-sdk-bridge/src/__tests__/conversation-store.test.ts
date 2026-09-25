import { describe, expect, it } from "bun:test";
import { ConversationStore, conversationKey } from "../conversation-store";

const session = (id: string) => ({
	sessionId: id,
	digests: [id],
	accountId: "acct-a",
});

describe("conversationKey", () => {
	const base = {
		apiKeyId: "key-1",
		affinityScope: "client_session",
		affinityKey: "sess-1",
		firstUserDigest: "d1",
	};

	it("is null without a session header", () => {
		expect(
			conversationKey({ ...base, affinityScope: null, affinityKey: null }),
		).toBeNull();
		expect(conversationKey({ ...base, affinityKey: null })).toBeNull();
		expect(conversationKey({ ...base, affinityScope: "project" })).toBeNull();
	});

	it("keeps identical content in different sessions, keys and helper calls apart", () => {
		const key = conversationKey(base);
		expect(conversationKey({ ...base, affinityKey: "sess-2" })).not.toBe(key);
		expect(conversationKey({ ...base, apiKeyId: "key-2" })).not.toBe(key);
		expect(
			conversationKey({ ...base, firstUserDigest: "title-helper" }),
		).not.toBe(key);
		expect(conversationKey({ ...base })).toBe(key);
	});
});

describe("ConversationStore", () => {
	it("waits for the previous turn's session to settle before handing it out", async () => {
		const discarded: string[] = [];
		const store = new ConversationStore({
			now: Date.now,
			onDiscard: (id) => discarded.push(id),
		});
		const first = await store.claim("k", 1_000);
		let settle!: (ok: boolean) => void;
		first.register(session("s1"), new Promise((resolve) => (settle = resolve)));
		const next = store.claim("k", 1_000);
		await Bun.sleep(20);
		settle(true);
		expect((await next).current?.sessionId).toBe("s1");
	});

	it("serialises turns of one conversation", async () => {
		const store = new ConversationStore({ now: Date.now, onDiscard: () => {} });
		const first = await store.claim("k", 1_000);
		let secondClaimed = false;
		const second = store.claim("k", 1_000).then((c) => {
			secondClaimed = true;
			return c;
		});
		await Bun.sleep(20);
		expect(secondClaimed).toBe(false);
		first.release();
		await second;
		expect(secondClaimed).toBe(true);
	});

	it("gives up waiting after the bound and ignores an unsettled session", async () => {
		const store = new ConversationStore({ now: Date.now, onDiscard: () => {} });
		const first = await store.claim("k", 1_000);
		first.register(session("s1"), new Promise(() => {}));
		const started = Date.now();
		const next = await store.claim("k", 60);
		expect(Date.now() - started).toBeGreaterThanOrEqual(50);
		expect(next.current).toBeNull();
	});

	it("keeps the last good session when a turn fails, and discards the failed one", async () => {
		const discarded: string[] = [];
		const store = new ConversationStore({
			now: Date.now,
			onDiscard: (id) => discarded.push(id),
		});
		(await store.claim("k", 100)).register(
			session("s1"),
			Promise.resolve(true),
		);
		const second = await store.claim("k", 100);
		expect(second.current?.sessionId).toBe("s1");
		second.register(session("s2"), Promise.resolve(false));
		const third = await store.claim("k", 100);
		expect(third.current?.sessionId).toBe("s1");
		expect(discarded).toEqual(["s2"]);
		third.register(session("s3"), Promise.resolve(true));
		expect((await store.claim("k", 100)).current?.sessionId).toBe("s3");
		expect(discarded).toEqual(["s2", "s1"]);
	});

	it("never lets a late settle replace a newer session", async () => {
		const discarded: string[] = [];
		const store = new ConversationStore({
			now: Date.now,
			onDiscard: (id) => discarded.push(id),
		});
		let settleOld!: (ok: boolean) => void;
		(await store.claim("k", 10)).register(
			session("old"),
			new Promise((resolve) => (settleOld = resolve)),
		);
		(await store.claim("k", 10)).register(
			session("new"),
			Promise.resolve(true),
		);
		await Bun.sleep(0);
		settleOld(true);
		await Bun.sleep(0);
		expect((await store.claim("k", 10)).current?.sessionId).toBe("new");
		expect(discarded).toContain("old");
	});

	it("reserves the conversation before waiting on a settle, so two waiters take turns", async () => {
		const store = new ConversationStore({ now: Date.now, onDiscard: () => {} });
		let settle!: (ok: boolean) => void;
		(await store.claim("k", 1_000)).register(
			session("s1"),
			new Promise((resolve) => (settle = resolve)),
		);
		// Both arrive while s1 is still settling.
		const order: string[] = [];
		const a = store.claim("k", 1_000).then((c) => {
			order.push("a");
			return c;
		});
		const b = store.claim("k", 1_000).then((c) => {
			order.push("b");
			return c;
		});
		await Bun.sleep(20);
		settle(true);
		const first = await a;
		await Bun.sleep(30);
		// b waits on a's reservation, not on s1's settle.
		expect(order).toEqual(["a"]);
		expect(first.current?.sessionId).toBe("s1");
		first.register(session("s2"), Promise.resolve(true));
		expect((await b).current?.sessionId).toBe("s2");
		expect(order).toEqual(["a", "b"]);
	});

	it("treats a settle that fails as a session never to resume", async () => {
		const discarded: string[] = [];
		const store = new ConversationStore({
			now: Date.now,
			onDiscard: (id) => discarded.push(id),
		});
		const first = await store.claim("k", 1_000);
		first.register(
			session("s1"),
			Promise.reject(new Error("settle failed")) as Promise<boolean>,
		);
		// Neither stranded nor thrown: the next claim gets no session.
		const next = await store.claim("k", 200);
		expect(next.current).toBeNull();
		expect(discarded).toEqual(["s1"]);
		next.release();
		const t0 = Date.now();
		(await store.claim("k", 1_000)).release();
		expect(Date.now() - t0).toBeLessThan(100);
	});

	describe("peek", () => {
		it("reads the settled session without taking the conversation", async () => {
			const store = new ConversationStore({
				now: Date.now,
				onDiscard: () => {},
			});
			expect(await store.peek("k", 100)).toBeNull();
			(await store.claim("k", 100)).register(
				session("s1"),
				Promise.resolve(true),
			);
			const holder = await store.claim("k", 100);
			const t0 = Date.now();
			// A turn holding the conversation does not delay a peek.
			expect((await store.peek("k", 1_000))?.sessionId).toBe("s1");
			expect(Date.now() - t0).toBeLessThan(100);
			// Nor does a peek hold up the next claim.
			holder.release();
			expect((await store.claim("k", 100)).current?.sessionId).toBe("s1");
		});

		it("waits for a session already settling, at most the bound", async () => {
			const store = new ConversationStore({
				now: Date.now,
				onDiscard: () => {},
			});
			(await store.claim("k", 100)).register(
				session("s1"),
				Promise.resolve(true),
			);
			let settle!: (ok: boolean) => void;
			(await store.claim("k", 100)).register(
				session("s2"),
				new Promise((resolve) => (settle = resolve)),
			);
			const peeked = store.peek("k", 1_000);
			await Bun.sleep(20);
			settle(true);
			expect((await peeked)?.sessionId).toBe("s2");

			let never!: (ok: boolean) => void;
			(await store.claim("k", 100)).register(
				session("s3"),
				new Promise((resolve) => (never = resolve)),
			);
			const t0 = Date.now();
			expect((await store.peek("k", 60))?.sessionId).toBe("s2");
			expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
			never(false);
		});

		it("never changes the conversation's session", async () => {
			const discarded: string[] = [];
			const store = new ConversationStore({
				now: Date.now,
				onDiscard: (id) => discarded.push(id),
			});
			(await store.claim("k", 100)).register(
				session("s1"),
				Promise.resolve(true),
			);
			await store.peek("k", 100);
			await store.peek("other", 100);
			expect(store.size).toBe(1);
			expect((await store.claim("k", 100)).current?.sessionId).toBe("s1");
			expect(discarded).toEqual([]);
		});
	});
});
