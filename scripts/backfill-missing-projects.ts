#!/usr/bin/env bun
/**
 * Fill only missing projects from retained request payloads, using live rules.
 * Default is read-only. Example:
 *   bun scripts/backfill-missing-projects.ts --before=2026-09-09T12:00:00Z
 *   bun scripts/backfill-missing-projects.ts --before=2026-09-09T12:00:00Z \
 *     --apply --audit=/absolute/path/project-repair.json
 *
 * Choose a cutoff after the old service drained when repairing a deployment.
 * No session guessing, no overwriting named projects, no rewriting payloads.
 * The audit is written exclusively and fsynced BEFORE any database writes;
 * it records old values and proposed replacements for verification/rollback.
 */
import { Database } from "bun:sqlite";
import { closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import type { ProjectRules } from "@clankermux/types";
import { Config } from "../packages/config/src/index";
import { resolveDbPath } from "../packages/database/src/paths";
import { decryptPayload } from "../packages/database/src/payload-encryption";
import { extractProjectFromRequest } from "../packages/proxy/src/project-extraction";

interface Candidate {
	id: string;
	timestamp: number;
	method: string;
	path: string;
	source: string | null;
}

export interface ProjectRepair {
	id: string;
	timestamp: number;
	previousProject: null;
	previousSource: string | null;
	project: string;
	source: string;
}

export async function planMissingProjects(
	db: Database,
	rules: ProjectRules,
	before: number,
) {
	// Materialize metadata only. Fetch large payloads one at a time, and finish
	// all parsing before writing anything (a decryption failure aborts the plan).
	const candidates = db
		.query<Candidate, [number]>(`
		SELECT r.id, r.timestamp, r.method, r.path,
		       r.project_attribution_source AS source
		FROM requests r JOIN request_payloads p ON p.id = r.id
		WHERE r.project IS NULL AND r.timestamp < ?
		ORDER BY r.timestamp, r.id
	`)
		.all(before);
	const payload = db.query<{ json: string }, [string]>(
		"SELECT json FROM request_payloads WHERE id = ?",
	);
	const repairs: ProjectRepair[] = [];
	let missingBody = 0;
	let invalidBody = 0;
	let unresolved = 0;
	for (const row of candidates) {
		const stored = payload.get(row.id);
		if (!stored) {
			missingBody++;
			continue;
		}
		const plaintext = await decryptPayload(stored.json);
		let envelope;
		let body;
		try {
			envelope = JSON.parse(plaintext);
			const raw = envelope?.request?.body;
			if (raw == null) {
				missingBody++;
				continue;
			}
			if (typeof raw !== "string") throw new Error("Invalid body encoding");
			body = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
			if (!body || typeof body !== "object" || Array.isArray(body)) {
				throw new Error("Invalid request body");
			}
		} catch {
			invalidBody++;
			continue;
		}
		const extracted = extractProjectFromRequest(
			row.method,
			row.path,
			new Headers(envelope.request.headers ?? {}),
			body,
			rules,
		);
		if (extracted.project === null) {
			unresolved++;
			continue;
		}
		repairs.push({
			id: row.id,
			timestamp: row.timestamp,
			previousProject: null,
			previousSource: row.source,
			project: extracted.project,
			source: extracted.source,
		});
	}
	return {
		examined: candidates.length,
		missingBody,
		invalidBody,
		unresolved,
		repairs,
	};
}

export function applyProjectRepairs(
	db: Database,
	repairs: ProjectRepair[],
): number {
	const update = db.query(`
		UPDATE requests SET project = ?, project_attribution_source = ?
		WHERE id = ? AND timestamp = ? AND project IS NULL
		  AND project_attribution_source IS ?
	`);
	let changed = 0;
	// Short transactions coexist with the live WAL writer. Compare the old
	// values so concurrent corrections and repeated runs are harmless.
	for (let i = 0; i < repairs.length; i += 100) {
		db.transaction(() => {
			for (const r of repairs.slice(i, i + 100)) {
				changed += update.run(
					r.project,
					r.source,
					r.id,
					r.timestamp,
					r.previousSource,
				).changes;
			}
		})();
	}
	return changed;
}

async function main() {
	let apply = false;
	let audit: string | undefined;
	let before = Date.now() - 5 * 60_000;
	for (const arg of process.argv.slice(2)) {
		if (arg === "--apply") apply = true;
		else if (arg.startsWith("--audit=")) audit = arg.slice(8);
		else if (arg.startsWith("--before=")) before = Date.parse(arg.slice(9));
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!Number.isFinite(before)) throw new Error("Invalid --before timestamp");
	if (apply && !audit) throw new Error("--apply requires --audit=<new file>");
	const dbPath = resolveDbPath();
	const rules = new Config().getProjectRules();
	const db = new Database(dbPath, { readonly: !apply, create: false });
	try {
		db.exec("PRAGMA busy_timeout = 5000");
		const plan = await planMissingProjects(db, rules, before);
		const byProject: Record<string, number> = Object.create(null);
		for (const r of plan.repairs)
			byProject[r.project] = (byProject[r.project] ?? 0) + 1;
		const { repairs, ...counts } = plan;
		console.log(
			JSON.stringify(
				{
					dbPath,
					before: new Date(before).toISOString(),
					...counts,
					proposed: repairs.length,
					byProject,
				},
				null,
				2,
			),
		);
		if (apply && audit) {
			const fd = openSync(audit, "wx", 0o600);
			try {
				writeFileSync(
					fd,
					JSON.stringify({ dbPath, before, rules, ...plan }, null, 2),
				);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			console.log(
				`Applied ${applyProjectRepairs(db, repairs)} repairs. Audit: ${audit}`,
			);
		} else console.log("Read-only preview; no changes written.");
	} finally {
		db.close();
	}
}

if (import.meta.main) await main();
