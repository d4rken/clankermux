#!/usr/bin/env bun
/**
 * Payload-writer soak: dev tooling, NOT part of `bun test` / CI.
 *
 *   bun run packages/database/scripts/payload-worker-soak.ts [--rotations N]
 *
 * Drives realistic payload sizes and rates through the real (rotating) payload
 * writer against a TEMP database — never the live one — across at least three
 * rotations, and reports per-rotation RSS, heap/external usage and timing.
 *
 * Why it exists: Bun 1.3.14 never reclaims the native backing stores of
 * structured-clone postMessage payloads while the receiving worker lives
 * (Bun #5709). The rotating design depends on worker TERMINATION to free them,
 * so the property that actually matters — memory returning to a flat baseline
 * after each rotation — can only be observed over several rotations at
 * realistic volume.
 *
 * Exits non-zero when either guard trips:
 *   - post-warmup RSS slope > 5 MB per rotation
 *   - any cutover (rotation start → replacement active) longer than 2 s
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../src/migrations";
import {
	type PayloadSettlement,
	PayloadWriteClient,
} from "../src/payload-write-client";

// --- knobs -----------------------------------------------------------------

/**
 * Rotations to drive. Enough samples that the RSS regression is robust: a
 * 5-6 sample fit is dominated by JS-heap phase (a single GC-timing outlier
 * swings the slope by >5 MB/rotation and flaps the verdict), while a dozen
 * samples average that out and expose a genuine trend.
 */
const DEFAULT_ROTATIONS = 12;

/** Leading samples excluded from the slope (page cache + arena first-touch). */
const WARMUP_ROTATIONS = 2;

/** Rotation budget for the soak — small enough to rotate in seconds. */
const ROTATION_BYTE_BUDGET = 64 * 1024 * 1024;

/** Realistic payload sizes: the live average is ~635 KB with a multi-MB tail. */
const PAYLOAD_SIZES = [
	64 * 1024,
	256 * 1024,
	640 * 1024,
	1024 * 1024,
	3 * 1024 * 1024,
];

/** Publish cadence — roughly the burst rate of a busy proxy. */
const PUBLISH_INTERVAL_MS = 5;

/** Quiesce time between draining and sampling memory. */
const SETTLE_MS = 500;

/** Bound on the per-rotation drain wait. */
const DRAIN_TIMEOUT_MS = 10_000;

/** Guard: allowed RSS growth per rotation after warmup. */
const MAX_RSS_SLOPE_BYTES_PER_ROTATION = 5 * 1024 * 1024;

/** Guard: allowed cutover duration. */
const MAX_CUTOVER_MS = 2_000;

// --- helpers ---------------------------------------------------------------

const MB = 1024 * 1024;
const mb = (bytes: number): string => `${(bytes / MB).toFixed(1)} MB`;

function parseRotations(): number {
	const idx = process.argv.indexOf("--rotations");
	if (idx === -1) return DEFAULT_ROTATIONS;
	const n = Number.parseInt(process.argv[idx + 1] ?? "", 10);
	return Number.isFinite(n) && n >= 2 ? n : DEFAULT_ROTATIONS;
}

interface RotationSample {
	rotation: number;
	rss: number;
	heapUsed: number;
	external: number;
	committed: number;
	cutoverMs: number;
	elapsedMs: number;
}

/** Wait (bounded) until nothing is in flight, so samples are comparable. */
async function drain(client: PayloadWriteClient): Promise<void> {
	const deadline = Date.now() + DRAIN_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (client.getStats().unackedEntries === 0) return;
		await Bun.sleep(10);
	}
}

/** Least-squares slope of rss over rotation index, bytes per rotation. */
function rssSlope(samples: RotationSample[]): number {
	if (samples.length < 2) return 0;
	const n = samples.length;
	const meanX = samples.reduce((a, s) => a + s.rotation, 0) / n;
	const meanY = samples.reduce((a, s) => a + s.rss, 0) / n;
	let num = 0;
	let den = 0;
	for (const s of samples) {
		num += (s.rotation - meanX) * (s.rss - meanY);
		den += (s.rotation - meanX) ** 2;
	}
	return den === 0 ? 0 : num / den;
}

async function main(): Promise<number> {
	const targetRotations = parseRotations();
	const dir = mkdtempSync(join(tmpdir(), "payload-worker-soak-"));
	const dbPath = join(dir, "soak.db");
	const db = new Database(dbPath, { create: true });
	runMigrations(db);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA busy_timeout = 5000");

	const insertRequest = db.prepare(
		`INSERT INTO requests (id, timestamp, method, path, status_code, success, failover_attempts)
		 VALUES (?, ?, 'POST', '/v1/messages', 200, 1, 0)`,
	);

	let committed = 0;
	let dropped = 0;
	let expired = 0;
	const client = new PayloadWriteClient({
		dbPath,
		busyTimeoutMs: 5_000,
		getRetentionMs: () => 24 * 60 * 60 * 1000,
		rotationByteBudget: ROTATION_BYTE_BUDGET,
		onSettled: (s: PayloadSettlement) => {
			if (s.outcome === "committed") committed++;
			else if (s.outcome === "expired") expired++;
			else dropped++;
		},
	});

	console.log(
		`Payload writer soak: ${targetRotations} rotations, budget ${mb(ROTATION_BYTE_BUDGET)}, db=${dbPath}`,
	);

	const samples: RotationSample[] = [];
	const cutovers: number[] = [];
	const startedAt = Date.now();
	let published = 0;
	let seenRotations = 0;
	let rotationStartedAt: number | null = null;

	while (seenRotations < targetRotations) {
		const id = `soak-${published}`;
		const size = PAYLOAD_SIZES[published % PAYLOAD_SIZES.length];
		insertRequest.run(id, Date.now());
		client.publish({
			requestId: id,
			ciphertext: "p".repeat(size),
			timestamp: Date.now(),
			transportBytes: size,
			payloadBytes: size,
		});
		published++;

		await Bun.sleep(PUBLISH_INTERVAL_MS);

		const stats = client.getStats();
		if (stats.activeGeneration === null) {
			// No active writer: a cutover (or the initial spawn) is in progress.
			if (rotationStartedAt === null) rotationStartedAt = Date.now();
		} else if (stats.rotations > seenRotations) {
			const cutoverMs =
				rotationStartedAt === null ? 0 : Date.now() - rotationStartedAt;
			rotationStartedAt = null;
			seenRotations = stats.rotations;
			cutovers.push(cutoverMs);

			// Sample only at a QUIESCENT point: drain the in-flight entries first
			// (otherwise the reading includes a variable amount of unacked payload
			// data and the slope measures traffic phase, not retained memory),
			// then give the freed generation's native buffers a moment and force a
			// GC so what remains is genuinely retained.
			await drain(client);
			await Bun.sleep(SETTLE_MS);
			// Twice: the first pass releases the large ciphertext strings, the
			// second collects what that pass made unreachable.
			Bun.gc(true);
			await Bun.sleep(50);
			Bun.gc(true);
			const memory = process.memoryUsage();
			const sample: RotationSample = {
				rotation: seenRotations,
				rss: process.memoryUsage.rss(),
				heapUsed: memory.heapUsed,
				external: memory.external,
				committed,
				cutoverMs,
				elapsedMs: Date.now() - startedAt,
			};
			samples.push(sample);
			console.log(
				`rotation ${sample.rotation}: rss=${mb(sample.rss)} heapUsed=${mb(sample.heapUsed)} ` +
					`external=${mb(sample.external)} committed=${sample.committed} ` +
					`cutover=${sample.cutoverMs}ms elapsed=${(sample.elapsedMs / 1000).toFixed(1)}s`,
			);
		} else {
			// Active writer, no rotation pending — any earlier null reading was the
			// initial spawn, not a cutover.
			rotationStartedAt = null;
		}
	}

	// Drain what is still in flight, then close everything down.
	await client.dispose(30_000);
	const finalStats = client.getStats();
	const storedRows = (
		db.query("SELECT COUNT(*) AS n FROM request_payloads").get() as {
			n: number;
		}
	).n;
	db.close();
	rmSync(dir, { recursive: true, force: true });

	// --- verdict -------------------------------------------------------------

	// Warmup rotations are excluded: page-cache growth and the SQLite arena's
	// first-touch allocations are one-off, not a leak.
	const postWarmup = samples.slice(WARMUP_ROTATIONS);
	const slope = rssSlope(postWarmup);
	const worstCutover = cutovers.length > 0 ? Math.max(...cutovers) : 0;

	console.log("");
	console.log(
		`published=${published} committed=${committed} dropped=${dropped} expired=${expired} storedRows=${storedRows}`,
	);
	console.log(
		`rotations=${finalStats.rotations} replays=${finalStats.replays} retries=${finalStats.retries} spawnFailures=${finalStats.spawnFailures} fences=${finalStats.fences}`,
	);
	console.log(
		`post-warmup RSS slope: ${mb(slope)}/rotation (limit ${mb(MAX_RSS_SLOPE_BYTES_PER_ROTATION)})`,
	);
	console.log(
		`worst cutover: ${worstCutover}ms (limit ${MAX_CUTOVER_MS}ms), cutovers=[${cutovers.join(", ")}]`,
	);

	let failed = false;
	if (slope > MAX_RSS_SLOPE_BYTES_PER_ROTATION) {
		console.error(`FAIL: RSS slope ${mb(slope)}/rotation exceeds the limit`);
		failed = true;
	}
	if (worstCutover > MAX_CUTOVER_MS) {
		console.error(`FAIL: cutover ${worstCutover}ms exceeds the limit`);
		failed = true;
	}
	if (dropped > 0) {
		console.error(`FAIL: ${dropped} payloads were dropped`);
		failed = true;
	}
	if (!failed) console.log("PASS");
	return failed ? 1 : 0;
}

process.exit(await main());
