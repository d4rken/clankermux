/**
 * Tests for CodexResetCreditEventRepository — the durable ledger behind
 * auto-applied (and manually consumed) Codex usage-limit reset credits.
 *
 * Uses the REAL schema from ensureSchema() so the partial unique index and
 * CHECK constraints are exercised exactly as deployed:
 *  - claimAutoAttempt mints attempt 1 with a deterministic id/idempotency key
 *  - a pending claim is reused (same key) so transport retries stay idempotent
 *  - a nothingToReset resolution allows a NEW attempt with a NEW key
 *  - terminal outcomes (reset/alreadyRedeemed/noCredit/failed) block automation
 *  - resolveAttempt only touches pending rows
 *  - the partial unique index absorbs concurrent duplicate auto claims
 *  - recordManual inserts one-shot resolved rows
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Force @clankermux/core to initialise before @clankermux/types resolves its
// circular dependency. Same pattern as account-payment.repository.test.ts.
import "@clankermux/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema } from "../../migrations";
import { CodexResetCreditEventRepository } from "../codex-reset-credit-event.repository";

const NOW = new Date(2026, 6, 20, 12).getTime();

function makeDb(): { db: Database; repo: CodexResetCreditEventRepository } {
	const db = new Database(":memory:");
	ensureSchema(db);
	const adapter = new BunSqlAdapter(db);
	const repo = new CodexResetCreditEventRepository(adapter);
	return { db, repo };
}

const CLAIM_INPUT = {
	accountId: "acc-1",
	accountName: "Codex One",
	creditId: "credit-a",
	creditExpiresAt: 1_790_000_000,
	cause: "expiry" as const,
	now: NOW,
};

describe("CodexResetCreditEventRepository", () => {
	let db: Database;
	let repo: CodexResetCreditEventRepository;

	beforeEach(() => {
		({ db, repo } = makeDb());
	});

	afterEach(() => {
		db.close();
	});

	describe("claimAutoAttempt", () => {
		it("mints attempt 1 with deterministic id and idempotency key", async () => {
			const claim = await repo.claimAutoAttempt(CLAIM_INPUT);
			expect(claim).not.toBeNull();
			expect(claim?.attemptSeq).toBe(1);
			expect(claim?.id).toBe("acc-1:credit-a:1");
			expect(claim?.idempotencyKey).toBe("codex-reset-auto:acc-1:credit-a:1");
			expect(claim?.reused).toBe(false);

			const rows = await repo.findRecentForAccount("acc-1", 10);
			expect(rows.length).toBe(1);
			expect(rows[0]?.status).toBe("pending");
			expect(rows[0]?.trigger).toBe("auto");
			expect(rows[0]?.account_name).toBe("Codex One");
			expect(rows[0]?.credit_expires_at).toBe(1_790_000_000);
			expect(rows[0]?.created_at).toBe(NOW);
			expect(rows[0]?.resolved_at).toBeNull();
			expect(rows[0]?.cause).toBe("expiry");
		});

		it("stores cause 'weekly-limit' on the claimed row", async () => {
			await repo.claimAutoAttempt({ ...CLAIM_INPUT, cause: "weekly-limit" });

			const rows = await repo.findRecentForAccount("acc-1", 10);
			expect(rows[0]?.cause).toBe("weekly-limit");
		});

		it("reusing a pending claim keeps the ORIGINAL stored cause", async () => {
			await repo.claimAutoAttempt(CLAIM_INPUT); // cause: expiry
			const reused = await repo.claimAutoAttempt({
				...CLAIM_INPUT,
				cause: "weekly-limit",
				now: NOW + 60_000,
			});
			expect(reused?.reused).toBe(true);

			const rows = await repo.findRecentForAccount("acc-1", 10);
			expect(rows.length).toBe(1);
			// The stored cause reflects the ORIGINAL attempt, not the retry's.
			expect(rows[0]?.cause).toBe("expiry");
		});

		it("reuses a pending claim — same id and idempotency key", async () => {
			const first = await repo.claimAutoAttempt(CLAIM_INPUT);
			const second = await repo.claimAutoAttempt({
				...CLAIM_INPUT,
				now: NOW + 60_000,
			});
			expect(second).not.toBeNull();
			expect(second?.reused).toBe(true);
			expect(second?.id).toBe(first?.id);
			expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
			expect(second?.attemptSeq).toBe(1);

			// Still exactly one row — no duplicate pending attempts.
			expect((await repo.findRecentForAccount("acc-1", 10)).length).toBe(1);
		});

		it("nothingToReset → next claim mints attempt 2 with a NEW key", async () => {
			const first = await repo.claimAutoAttempt(CLAIM_INPUT);
			await repo.resolveAttempt(
				first?.id as string,
				"nothingToReset",
				0,
				null,
				NOW + 1,
			);

			const second = await repo.claimAutoAttempt({
				...CLAIM_INPUT,
				now: NOW + 2,
			});
			expect(second).not.toBeNull();
			expect(second?.reused).toBe(false);
			expect(second?.attemptSeq).toBe(2);
			expect(second?.id).toBe("acc-1:credit-a:2");
			expect(second?.idempotencyKey).toBe("codex-reset-auto:acc-1:credit-a:2");
			expect(second?.idempotencyKey).not.toBe(first?.idempotencyKey);

			expect((await repo.findRecentForAccount("acc-1", 10)).length).toBe(2);
		});

		for (const terminal of [
			"reset",
			"alreadyRedeemed",
			"noCredit",
			"failed",
		] as const) {
			it(`terminal status '${terminal}' → claim returns null`, async () => {
				const first = await repo.claimAutoAttempt(CLAIM_INPUT);
				await repo.resolveAttempt(
					first?.id as string,
					terminal,
					terminal === "reset" ? 2 : null,
					terminal === "failed" ? "boom" : null,
					NOW + 1,
				);

				const second = await repo.claimAutoAttempt({
					...CLAIM_INPUT,
					now: NOW + 2,
				});
				expect(second).toBeNull();
				expect((await repo.findRecentForAccount("acc-1", 10)).length).toBe(1);
			});
		}

		it("claims are scoped per (account, credit)", async () => {
			await repo.claimAutoAttempt(CLAIM_INPUT);
			const otherCredit = await repo.claimAutoAttempt({
				...CLAIM_INPUT,
				creditId: "credit-b",
			});
			expect(otherCredit?.reused).toBe(false);
			expect(otherCredit?.attemptSeq).toBe(1);
			expect(otherCredit?.id).toBe("acc-1:credit-b:1");

			const otherAccount = await repo.claimAutoAttempt({
				...CLAIM_INPUT,
				accountId: "acc-2",
				accountName: "Codex Two",
			});
			expect(otherAccount?.reused).toBe(false);
			expect(otherAccount?.id).toBe("acc-2:credit-a:1");
		});

		it("a concurrent duplicate claim is absorbed by the unique index and reused", async () => {
			// Simulate the loser of a claim race: the winner's row already exists,
			// so a duplicate manual INSERT of the same auto attempt is ignored.
			const first = await repo.claimAutoAttempt(CLAIM_INPUT);
			expect(() =>
				db.run(
					`INSERT OR IGNORE INTO codex_reset_credit_events (
						id, account_id, account_name, credit_id, trigger, attempt_seq,
						idempotency_key, status, created_at
					) VALUES ('other-id', 'acc-1', 'Codex One', 'credit-a', 'auto', 1,
						'other-key', 'pending', ${NOW + 5})`,
				),
			).not.toThrow();

			// The duplicate row was ignored; the original claim is intact.
			const rows = await repo.findRecentForAccount("acc-1", 10);
			expect(rows.length).toBe(1);
			expect(rows[0]?.id).toBe(first?.id);
			expect(rows[0]?.idempotency_key).toBe(first?.idempotencyKey);
		});
	});

	describe("resolveAttempt", () => {
		it("resolves a pending row with status, windows and timestamp", async () => {
			const claim = await repo.claimAutoAttempt(CLAIM_INPUT);
			await repo.resolveAttempt(claim?.id as string, "reset", 2, null, NOW + 9);

			const rows = await repo.findRecentForAccount("acc-1", 10);
			expect(rows[0]?.status).toBe("reset");
			expect(rows[0]?.windows_reset).toBe(2);
			expect(rows[0]?.error_message).toBeNull();
			expect(rows[0]?.resolved_at).toBe(NOW + 9);
		});

		it("only updates pending rows — a resolved row stays as-is", async () => {
			const claim = await repo.claimAutoAttempt(CLAIM_INPUT);
			await repo.resolveAttempt(claim?.id as string, "reset", 2, null, NOW + 1);
			await repo.resolveAttempt(
				claim?.id as string,
				"failed",
				null,
				"late error",
				NOW + 2,
			);

			const rows = await repo.findRecentForAccount("acc-1", 10);
			expect(rows[0]?.status).toBe("reset");
			expect(rows[0]?.windows_reset).toBe(2);
			expect(rows[0]?.error_message).toBeNull();
			expect(rows[0]?.resolved_at).toBe(NOW + 1);
		});

		it("is a no-op for an unknown id", async () => {
			await repo.resolveAttempt("nope", "failed", null, "x", NOW);
			expect((await repo.findRecentForAccount("acc-1", 10)).length).toBe(0);
		});
	});

	describe("recordManual", () => {
		it("inserts a one-shot resolved manual row", async () => {
			await repo.recordManual({
				accountId: "acc-1",
				accountName: "Codex One",
				creditId: null,
				idempotencyKey: "manual-key-1",
				status: "reset",
				windowsReset: 1,
				errorMessage: null,
				now: NOW,
			});

			const rows = await repo.findRecentForAccount("acc-1", 10);
			expect(rows.length).toBe(1);
			expect(rows[0]?.trigger).toBe("manual");
			expect(rows[0]?.attempt_seq).toBeNull();
			expect(rows[0]?.credit_id).toBeNull();
			expect(rows[0]?.status).toBe("reset");
			expect(rows[0]?.windows_reset).toBe(1);
			expect(rows[0]?.idempotency_key).toBe("manual-key-1");
			expect(rows[0]?.created_at).toBe(NOW);
			expect(rows[0]?.resolved_at).toBe(NOW);
			// Manual rows carry no automation cause.
			expect(rows[0]?.cause).toBeNull();
		});

		it("manual rows never collide with auto rows or each other", async () => {
			await repo.claimAutoAttempt(CLAIM_INPUT);
			await repo.recordManual({
				accountId: "acc-1",
				accountName: "Codex One",
				creditId: "credit-a",
				idempotencyKey: "manual-key-1",
				status: "failed",
				windowsReset: null,
				errorMessage: "consume endpoint returned 500",
				now: NOW + 1,
			});
			await repo.recordManual({
				accountId: "acc-1",
				accountName: "Codex One",
				creditId: "credit-a",
				idempotencyKey: "manual-key-2",
				status: "reset",
				windowsReset: 1,
				errorMessage: null,
				now: NOW + 2,
			});

			expect((await repo.findRecentForAccount("acc-1", 10)).length).toBe(3);
			// Manual rows do not affect auto claim state.
			const claim = await repo.claimAutoAttempt({
				...CLAIM_INPUT,
				now: NOW + 3,
			});
			expect(claim?.reused).toBe(true);
		});
	});

	describe("getTerminallyResolvedCreditIds", () => {
		it("returns credit ids of terminally-resolved AUTO rows only", async () => {
			// Terminal auto rows for credits a..d, one per terminal status.
			const outcomes = [
				["credit-a", "reset"],
				["credit-b", "alreadyRedeemed"],
				["credit-c", "noCredit"],
				["credit-d", "failed"],
			] as const;
			for (const [creditId, status] of outcomes) {
				const claim = await repo.claimAutoAttempt({
					...CLAIM_INPUT,
					creditId,
				});
				await repo.resolveAttempt(
					claim?.id as string,
					status,
					status === "reset" ? 1 : null,
					null,
					NOW + 1,
				);
			}
			// Pending auto row: excluded.
			await repo.claimAutoAttempt({ ...CLAIM_INPUT, creditId: "credit-e" });
			// nothingToReset auto row: retryable, excluded.
			const retryable = await repo.claimAutoAttempt({
				...CLAIM_INPUT,
				creditId: "credit-f",
			});
			await repo.resolveAttempt(
				retryable?.id as string,
				"nothingToReset",
				0,
				null,
				NOW + 1,
			);
			// Manual terminal row: excluded (automation only tracks auto rows).
			await repo.recordManual({
				accountId: "acc-1",
				accountName: "Codex One",
				creditId: "credit-g",
				idempotencyKey: "manual-key-1",
				status: "reset",
				windowsReset: 1,
				errorMessage: null,
				now: NOW,
			});
			// Other account: excluded.
			const other = await repo.claimAutoAttempt({
				...CLAIM_INPUT,
				accountId: "acc-2",
				creditId: "credit-h",
			});
			await repo.resolveAttempt(other?.id as string, "reset", 1, null, NOW + 1);

			const resolved = await repo.getTerminallyResolvedCreditIds("acc-1");
			expect(resolved).toEqual(
				new Set(["credit-a", "credit-b", "credit-c", "credit-d"]),
			);
		});
	});

	describe("findRecentForAccount", () => {
		it("orders by created_at DESC and honors the limit", async () => {
			for (let i = 0; i < 3; i++) {
				await repo.recordManual({
					accountId: "acc-1",
					accountName: "Codex One",
					creditId: null,
					idempotencyKey: `manual-key-${i}`,
					status: "reset",
					windowsReset: 1,
					errorMessage: null,
					now: NOW + i,
				});
			}
			await repo.recordManual({
				accountId: "acc-2",
				accountName: "Codex Two",
				creditId: null,
				idempotencyKey: "other-account",
				status: "reset",
				windowsReset: 1,
				errorMessage: null,
				now: NOW + 99,
			});

			const rows = await repo.findRecentForAccount("acc-1", 2);
			expect(rows.length).toBe(2);
			expect(rows[0]?.created_at).toBe(NOW + 2);
			expect(rows[1]?.created_at).toBe(NOW + 1);
			expect(rows.every((r) => r.account_id === "acc-1")).toBe(true);
		});
	});

	describe("getLatestAutoApplyCooldownAnchorAt", () => {
		it("returns null when the account has no ledger rows at all", async () => {
			expect(await repo.getLatestAutoApplyCooldownAnchorAt("acc-1")).toBeNull();
		});

		it("picks the MAX resolved_at across reset and alreadyRedeemed auto rows", async () => {
			const first = await repo.claimAutoAttempt(CLAIM_INPUT);
			await repo.resolveAttempt(
				first?.id as string,
				"reset",
				1,
				null,
				NOW + 10,
			);

			const second = await repo.claimAutoAttempt({
				...CLAIM_INPUT,
				creditId: "credit-b",
				now: NOW + 20,
			});
			await repo.resolveAttempt(
				second?.id as string,
				"alreadyRedeemed",
				null,
				null,
				NOW + 30,
			);

			expect(await repo.getLatestAutoApplyCooldownAnchorAt("acc-1")).toBe(
				NOW + 30,
			);
		});

		it("anchors on a nothingToReset resolution (weekly retry-storm guard)", async () => {
			// A nothingToReset outcome re-arms the CLAIM (a later attempt may fire),
			// but it must still anchor the weekly cooldown — otherwise a weekly
			// usage stuck at >=100% would hit the redeem endpoint every tick.
			const attempt = await repo.claimAutoAttempt(CLAIM_INPUT);
			await repo.resolveAttempt(
				attempt?.id as string,
				"nothingToReset",
				0,
				null,
				NOW + 40,
			);

			expect(await repo.getLatestAutoApplyCooldownAnchorAt("acc-1")).toBe(
				NOW + 40,
			);
		});

		it("ignores manual, pending, failed and noCredit rows", async () => {
			// Successful MANUAL row — excluded (only auto rows count).
			await repo.recordManual({
				accountId: "acc-1",
				accountName: "Codex One",
				creditId: "credit-m",
				idempotencyKey: "manual-key-1",
				status: "reset",
				windowsReset: 1,
				errorMessage: null,
				now: NOW + 100,
			});
			// Pending auto row — excluded (unresolved).
			await repo.claimAutoAttempt({ ...CLAIM_INPUT, creditId: "credit-p" });
			// failed auto row — excluded (terminal claims never re-fire, so they
			// don't need to anchor the cooldown).
			const failed = await repo.claimAutoAttempt({
				...CLAIM_INPUT,
				creditId: "credit-f",
			});
			await repo.resolveAttempt(
				failed?.id as string,
				"failed",
				null,
				"boom",
				NOW + 200,
			);
			// noCredit auto row — excluded (terminal, same reasoning).
			const noCredit = await repo.claimAutoAttempt({
				...CLAIM_INPUT,
				creditId: "credit-nc",
			});
			await repo.resolveAttempt(
				noCredit?.id as string,
				"noCredit",
				null,
				null,
				NOW + 300,
			);

			expect(await repo.getLatestAutoApplyCooldownAnchorAt("acc-1")).toBeNull();

			// An anchoring AUTO row on another account never leaks in.
			const other = await repo.claimAutoAttempt({
				...CLAIM_INPUT,
				accountId: "acc-2",
			});
			await repo.resolveAttempt(other?.id as string, "reset", 1, null, NOW + 5);
			expect(await repo.getLatestAutoApplyCooldownAnchorAt("acc-1")).toBeNull();

			// And once acc-1 gains an anchoring auto row, it is returned.
			const success = await repo.claimAutoAttempt({
				...CLAIM_INPUT,
				creditId: "credit-s",
			});
			await repo.resolveAttempt(
				success?.id as string,
				"reset",
				1,
				null,
				NOW + 50,
			);
			expect(await repo.getLatestAutoApplyCooldownAnchorAt("acc-1")).toBe(
				NOW + 50,
			);
		});
	});

	describe("CHECK constraints", () => {
		it("rejects a bad trigger", () => {
			expect(() =>
				db.run(
					`INSERT INTO codex_reset_credit_events (id, account_id, account_name, trigger, idempotency_key, status, created_at)
					 VALUES ('x', 'a', 'A', 'cron', 'k', 'pending', 0)`,
				),
			).toThrow();
		});

		it("rejects a bad status", () => {
			expect(() =>
				db.run(
					`INSERT INTO codex_reset_credit_events (id, account_id, account_name, trigger, idempotency_key, status, created_at)
					 VALUES ('x', 'a', 'A', 'manual', 'k', 'exploded', 0)`,
				),
			).toThrow();
		});

		it("rejects a bad cause but allows NULL", () => {
			expect(() =>
				db.run(
					`INSERT INTO codex_reset_credit_events (id, account_id, account_name, trigger, cause, idempotency_key, status, created_at)
					 VALUES ('x', 'a', 'A', 'auto', 'because', 'k', 'pending', 0)`,
				),
			).toThrow();

			expect(() =>
				db.run(
					`INSERT INTO codex_reset_credit_events (id, account_id, account_name, trigger, cause, idempotency_key, status, created_at)
					 VALUES ('x', 'a', 'A', 'manual', NULL, 'k', 'pending', 0)`,
				),
			).not.toThrow();
		});
	});
});
