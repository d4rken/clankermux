/**
 * Cross-thread integration test: the REAL payload-write Worker driven by the
 * real client, against a temp-file database (never the live DB).
 *
 * The unit tests fake the transport; this one exercises the parts that only
 * exist across a thread boundary — the embedded worker bundle, structured-clone
 * transport, the worker's own SQLite connection and FK enforcement, replay
 * after a crash before AND after commit, and concurrent main-thread writes.
 *
 * The encryption key is set before the first import-time use of the payload
 * encryption module, so `encryptPayload` is live for the encrypted case; the
 * plaintext case publishes the envelope exactly as a key-less deployment would.
 */
process.env.PAYLOAD_ENCRYPTION_KEY =
	"00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../migrations";
import { decryptPayload, encryptPayload } from "../payload-encryption";
import {
	createWorkerTransport,
	type PayloadSettlement,
	PayloadWriteClient,
	type PayloadWriteTransport,
	type PayloadWriteTransportFactory,
} from "../payload-write-client";
import type { PayloadWriteResponse } from "../payload-write-worker";

let dir: string;
let dbPath: string;
let db: Database;
let clients: PayloadWriteClient[] = [];

const TEST_TIMEOUT_MS = 20_000;

function seedRequest(id: string): void {
	db.run(
		`INSERT INTO requests (id, timestamp, method, path, status_code, success, failover_attempts)
		 VALUES (?, ?, 'POST', '/v1/messages', 200, 1, 0)`,
		[id, Date.now()],
	);
}

function storedPayload(id: string): string | null {
	const row = db
		.query("SELECT json FROM request_payloads WHERE id = ?")
		.get(id) as { json: string } | null;
	return row?.json ?? null;
}

function payloadCount(): number {
	return (
		db.query("SELECT COUNT(*) AS n FROM request_payloads").get() as {
			n: number;
		}
	).n;
}

async function waitFor(
	predicate: () => boolean,
	label: string,
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error(`timed out waiting for: ${label}`);
}

function makeClient(options: {
	settlements: PayloadSettlement[];
	spawn?: PayloadWriteTransportFactory;
	retentionMs?: number;
}): PayloadWriteClient {
	const client = new PayloadWriteClient({
		dbPath,
		busyTimeoutMs: 5_000,
		getRetentionMs: () => options.retentionMs ?? 24 * 60 * 60 * 1000,
		onSettled: (settlement) => options.settlements.push(settlement),
		spawn: options.spawn,
	});
	clients.push(client);
	return client;
}

function publish(
	client: PayloadWriteClient,
	id: string,
	ciphertext: string,
): boolean {
	return client.publish({
		requestId: id,
		ciphertext,
		timestamp: Date.now(),
		transportBytes: Buffer.byteLength(ciphertext),
		payloadBytes: Buffer.byteLength(ciphertext),
	});
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "payload-write-integration-"));
	dbPath = join(dir, "test.db");
	db = new Database(dbPath, { create: true });
	runMigrations(db);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	db.exec("PRAGMA busy_timeout = 5000");
});

afterEach(async () => {
	for (const client of clients) {
		await client.dispose(2_000);
	}
	clients = [];
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

test(
	"writes plaintext payloads across the thread boundary",
	async () => {
		const settlements: PayloadSettlement[] = [];
		const client = makeClient({ settlements });

		for (let i = 0; i < 5; i++) {
			seedRequest(`req-${i}`);
			expect(
				publish(client, `req-${i}`, JSON.stringify({ index: i, body: "x" })),
			).toBe(true);
		}

		await waitFor(() => settlements.length === 5, "5 settlements");
		expect(settlements.every((s) => s.outcome === "committed")).toBe(true);
		expect(payloadCount()).toBe(5);
		expect(JSON.parse(storedPayload("req-3") ?? "null")).toEqual({
			index: 3,
			body: "x",
		});
		expect(client.getStats().unackedEntries).toBe(0);
	},
	TEST_TIMEOUT_MS,
);

test(
	"writes encrypted payloads the reader can decrypt",
	async () => {
		const settlements: PayloadSettlement[] = [];
		const client = makeClient({ settlements });

		seedRequest("enc-1");
		const envelope = JSON.stringify({ secret: "hunter2" });
		const ciphertext = await encryptPayload(envelope);
		expect(ciphertext.startsWith("enc:")).toBe(true);
		expect(publish(client, "enc-1", ciphertext)).toBe(true);

		await waitFor(() => settlements.length === 1, "settlement");
		const stored = storedPayload("enc-1");
		expect(stored).toBe(ciphertext);
		expect(await decryptPayload(stored ?? "")).toBe(envelope);
	},
	TEST_TIMEOUT_MS,
);

test(
	"enforces the FK: a payload without its request row is entry-permanent",
	async () => {
		const settlements: PayloadSettlement[] = [];
		const client = makeClient({ settlements });

		// No requests row yet — the worker connection has foreign_keys = ON.
		expect(publish(client, "orphan", '{"a":1}')).toBe(true);
		await waitFor(() => settlements.length === 1, "orphan settlement");
		expect(settlements[0].outcome).toBe("dropped");
		expect(settlements[0].errorClass).toBe("entry-permanent");
		expect(payloadCount()).toBe(0);

		// Once the parent exists the same payload commits.
		seedRequest("orphan");
		expect(publish(client, "orphan", '{"a":1}')).toBe(true);
		await waitFor(() => settlements.length === 2, "second settlement");
		expect(settlements[1].outcome).toBe("committed");
		expect(payloadCount()).toBe(1);
	},
	TEST_TIMEOUT_MS,
);

test(
	"replays after a crash BEFORE the commit — the payload still lands",
	async () => {
		const settlements: PayloadSettlement[] = [];
		let crashed = false;
		// Kill the first generation the moment it receives a write, before it can
		// possibly have committed, and report the death like a real worker crash.
		const spawn: PayloadWriteTransportFactory = () => {
			const inner = createWorkerTransport();
			let onError: ((detail: string) => void) | null = null;
			const wrapper: PayloadWriteTransport = {
				postMessage(message) {
					inner.postMessage(message);
					if (message.type === "write" && !crashed) {
						crashed = true;
						inner.terminate();
						onError?.("simulated crash before commit");
					}
				},
				onMessage: (handler) => inner.onMessage(handler),
				onError: (handler) => {
					onError = handler;
					inner.onError(handler);
				},
				terminate: () => inner.terminate(),
			};
			return wrapper;
		};

		const client = makeClient({ settlements, spawn });
		seedRequest("crashy");
		expect(publish(client, "crashy", '{"v":1}')).toBe(true);

		await waitFor(() => settlements.length === 1, "settlement after replay");
		expect(settlements[0].outcome).toBe("committed");
		expect(payloadCount()).toBe(1);
		expect(client.getStats().replays).toBeGreaterThanOrEqual(1);
	},
	TEST_TIMEOUT_MS,
);

test(
	"replays after a crash AFTER the commit without duplicating the row",
	async () => {
		const settlements: PayloadSettlement[] = [];
		let swallowed = false;
		// Let the first generation commit, then swallow its ack and kill it — the
		// client must replay, and the upsert must make that harmless.
		const spawn: PayloadWriteTransportFactory = () => {
			const inner = createWorkerTransport();
			let onError: ((detail: string) => void) | null = null;
			const wrapper: PayloadWriteTransport = {
				postMessage: (message) => inner.postMessage(message),
				onMessage: (handler) => {
					inner.onMessage((message: PayloadWriteResponse) => {
						if (message.type === "ack" && !swallowed) {
							swallowed = true;
							inner.terminate();
							onError?.("simulated crash after commit");
							return; // ack never reaches the client
						}
						handler(message);
					});
				},
				onError: (handler) => {
					onError = handler;
					inner.onError(handler);
				},
				terminate: () => inner.terminate(),
			};
			return wrapper;
		};

		const client = makeClient({ settlements, spawn });
		seedRequest("dup");
		expect(publish(client, "dup", '{"v":"first"}')).toBe(true);

		await waitFor(() => swallowed, "first ack swallowed");
		await waitFor(() => settlements.length === 1, "settlement after replay");
		expect(settlements[0].outcome).toBe("committed");
		// Exactly one row: the replay upserted over the committed row.
		expect(payloadCount()).toBe(1);
		expect(storedPayload("dup")).toBe('{"v":"first"}');
	},
	TEST_TIMEOUT_MS,
);

test(
	"an expired entry is dropped instead of resurrecting a deleted payload",
	async () => {
		const settlements: PayloadSettlement[] = [];
		let crashed = false;
		const spawn: PayloadWriteTransportFactory = () => {
			const inner = createWorkerTransport();
			let onError: ((detail: string) => void) | null = null;
			return {
				postMessage(message) {
					if (message.type === "write" && !crashed) {
						// Never delivered: the generation dies with the write in hand.
						crashed = true;
						inner.terminate();
						onError?.("simulated crash");
						return;
					}
					inner.postMessage(message);
				},
				onMessage: (handler) => inner.onMessage(handler),
				onError: (handler) => {
					onError = handler;
					inner.onError(handler);
				},
				terminate: () => inner.terminate(),
			};
		};

		const settlementsRef = settlements;
		const client = new PayloadWriteClient({
			dbPath,
			// A retention window of 1 ms means the entry is already outside it.
			getRetentionMs: () => 1,
			onSettled: (s) => settlementsRef.push(s),
			spawn,
		});
		clients.push(client);

		seedRequest("stale");
		expect(publish(client, "stale", '{"v":1}')).toBe(true);
		await waitFor(() => settlements.length === 1, "expiry settlement");
		expect(settlements[0].outcome).toBe("expired");
		expect(payloadCount()).toBe(0);
		expect(client.getStats().expired).toBe(1);
	},
	TEST_TIMEOUT_MS,
);

test(
	"tolerates concurrent main-thread writes on the shared database",
	async () => {
		const settlements: PayloadSettlement[] = [];
		const client = makeClient({ settlements });

		const total = 40;
		for (let i = 0; i < total; i++) {
			seedRequest(`c-${i}`);
			publish(client, `c-${i}`, JSON.stringify({ i, blob: "y".repeat(2048) }));
			// Interleave main-connection writes while the worker holds the writer
			// slot — both connections must make progress.
			db.run(
				`INSERT INTO requests (id, timestamp, method, path, status_code, success, failover_attempts)
				 VALUES (?, ?, 'GET', '/health', 200, 1, 0)`,
				[`main-${i}`, Date.now()],
			);
			if (i % 8 === 0) await Bun.sleep(5);
		}

		await waitFor(
			() => settlements.length === total,
			`${total} settlements`,
			15_000,
		);
		expect(settlements.every((s) => s.outcome === "committed")).toBe(true);
		expect(payloadCount()).toBe(total);
		expect(
			(
				db
					.query("SELECT COUNT(*) AS n FROM requests WHERE id LIKE 'main-%'")
					.get() as { n: number }
			).n,
		).toBe(total);
	},
	TEST_TIMEOUT_MS,
);

test(
	"dispose flushes in-flight payloads before terminating the worker",
	async () => {
		const settlements: PayloadSettlement[] = [];
		const client = makeClient({ settlements });

		for (let i = 0; i < 10; i++) {
			seedRequest(`d-${i}`);
			publish(client, `d-${i}`, JSON.stringify({ i }));
		}
		// Dispose immediately: the batch is still queued inside the worker.
		await client.dispose(5_000);

		expect(payloadCount()).toBe(10);
		expect(settlements.filter((s) => s.outcome === "committed")).toHaveLength(
			10,
		);
		expect(client.getStats().liveGenerations).toBe(0);
	},
	TEST_TIMEOUT_MS,
);
