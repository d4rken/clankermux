/**
 * AnthropicBankedResetEventRepository — the ledger behind banked-reset claims.
 * Every claim, manual or automatic, is written `pending` BEFORE its POST, so a
 * crash or a lost response is replayed with the same request_id instead of
 * spending a second reset. Runs against the real ensureSchema() table so the
 * unique indexes and CHECKs are the deployed ones.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Force @clankermux/core to initialise before @clankermux/types resolves its
// circular dependency. Same pattern as codex-reset-credit-event.repository.test.ts.
import "@clankermux/core";
import { ANTHROPIC_BANKED_RESET_REPLAY_WINDOW_MS } from "@clankermux/types";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema } from "../../migrations";
import { AnthropicBankedResetEventRepository } from "../anthropic-banked-reset-event.repository";

const NOW = Date.parse("2026-09-22T12:00:00Z");
const HOUR = 60 * 60 * 1000;

const AUTO = {
	accountId: "acc-1",
	accountName: "Claude One",
	grantId: "g_week_1",
	grantEndsAt: NOW + 5 * 60_000,
	cause: "expiry" as const,
	now: NOW,
};

const MANUAL = {
	accountId: "acc-1",
	accountName: "Claude One",
	grantId: "g_week_1",
	requestId: "req-manual-1",
	grantEndsAt: NOW + HOUR,
	now: NOW,
};

describe("AnthropicBankedResetEventRepository", () => {
	let db: Database;
	let repo: AnthropicBankedResetEventRepository;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		repo = new AnthropicBankedResetEventRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	describe("claimAutoAttempt", () => {
		it("mints attempt 1 as a pending row with a deterministic id and a valid request id", async () => {
			const claim = await repo.claimAutoAttempt(AUTO);
			expect(claim).toMatchObject({
				id: "acc-1:g_week_1:1",
				attemptSeq: 1,
				reused: false,
			});
			expect(claim?.requestId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);

			const row = await repo.findByRequestId("acc-1", claim?.requestId ?? "");
			expect(row).toMatchObject({
				id: "acc-1:g_week_1:1",
				trigger: "auto",
				cause: "expiry",
				status: "pending",
				grant_id: "g_week_1",
				grant_ends_at: AUTO.grantEndsAt,
				next_attempt_at: null,
				created_at: NOW,
				resolved_at: null,
			});
		});

		it("reuses a pending attempt with the SAME request id", async () => {
			const first = await repo.claimAutoAttempt(AUTO);
			const again = await repo.claimAutoAttempt({
				...AUTO,
				cause: "weekly-limit",
				now: NOW + 60_000,
			});
			expect(again).toEqual({
				id: first?.id ?? "",
				requestId: first?.requestId ?? "",
				attemptSeq: 1,
				reused: true,
			});
			// The original cause stays on the row.
			expect((await repo.findRecentForAccount("acc-1", 10))[0]?.cause).toBe(
				"expiry",
			);
		});

		it("mints the next attempt_seq with a NEW request id once the last one resolved", async () => {
			const first = await repo.claimAutoAttempt(AUTO);
			if (!first) throw new Error("expected a claim");
			await repo.resolveAttempt(first.id, {
				status: "not_limited",
				reason: "not_limited",
				now: NOW + 1,
			});
			const second = await repo.claimAutoAttempt({ ...AUTO, now: NOW + 2 });
			expect(second?.attemptSeq).toBe(2);
			expect(second?.id).toBe("acc-1:g_week_1:2");
			expect(second?.requestId).not.toBe(first.requestId);
			expect(await repo.nextAttemptSeq("acc-1", "g_week_1")).toBe(3);
		});

		it("absorbs two concurrent claims into one row", async () => {
			const [a, b] = await Promise.all([
				repo.claimAutoAttempt(AUTO),
				repo.claimAutoAttempt(AUTO),
			]);
			expect(a?.id).toBe(b?.id ?? "");
			expect(a?.requestId).toBe(b?.requestId ?? "");
			expect(await repo.findPendingForAccount("acc-1")).toHaveLength(1);
		});

		it("starts no new attempt, expiry or weekly, while a manual claim is pending", async () => {
			await repo.beginManualAttempt(MANUAL);
			expect(await repo.claimAutoAttempt(AUTO)).toBeNull();
			expect(
				await repo.claimAutoAttempt({ ...AUTO, cause: "weekly-limit" }),
			).toBeNull();
			expect(await repo.findPendingForAccount("acc-1", "auto")).toEqual([]);
		});

		it("starts no new attempt, expiry or weekly, while another auto claim on the account is pending", async () => {
			const other = await repo.claimAutoAttempt({
				...AUTO,
				grantId: "g_other",
				cause: "weekly-limit",
			});
			expect(
				await repo.claimAutoAttempt({ ...AUTO, cause: "weekly-limit" }),
			).toBeNull();
			expect(
				await repo.claimAutoAttempt({ ...AUTO, cause: "expiry" }),
			).toBeNull();
			expect(
				(await repo.findPendingForAccount("acc-1")).map((r) => r.request_id),
			).toEqual([other?.requestId ?? ""]);
		});

		it("still hands back a grant's own pending attempt, whatever the cause", async () => {
			const first = await repo.claimAutoAttempt({
				...AUTO,
				cause: "weekly-limit",
			});
			const again = await repo.claimAutoAttempt({ ...AUTO, cause: "expiry" });
			expect(again).toEqual({
				id: first?.id ?? "",
				requestId: first?.requestId ?? "",
				attemptSeq: 1,
				reused: true,
			});
		});
	});

	describe("beginManualAttempt", () => {
		it("creates a pending manual row with the caller's request id", async () => {
			const begun = await repo.beginManualAttempt(MANUAL);
			expect(begun.kind).toBe("created");
			expect(begun.row).toMatchObject({
				trigger: "manual",
				cause: null,
				attempt_seq: null,
				request_id: "req-manual-1",
				status: "pending",
				grant_ends_at: MANUAL.grantEndsAt,
			});
		});

		it("reconciles a replayed request id onto the existing row", async () => {
			const first = await repo.beginManualAttempt(MANUAL);
			const replay = await repo.beginManualAttempt({
				...MANUAL,
				now: NOW + 5_000,
			});
			expect(replay.kind).toBe("existing");
			expect(replay.row.id).toBe(first.row.id);
			expect(await repo.findRecentForAccount("acc-1", 10)).toHaveLength(1);
		});

		it("rejects a request id already bound to a different grant", async () => {
			await repo.beginManualAttempt(MANUAL);
			const clash = await repo.beginManualAttempt({
				...MANUAL,
				grantId: "g_other",
			});
			expect(clash.kind).toBe("grant_mismatch");
			expect(clash.row.grant_id).toBe("g_week_1");
			expect(await repo.findRecentForAccount("acc-1", 10)).toHaveLength(1);
		});

		it("refuses a new request id while another claim on the account is pending, naming it", async () => {
			await repo.beginManualAttempt(MANUAL);
			const blocked = await repo.beginManualAttempt({
				...MANUAL,
				grantId: "g_other",
				requestId: "req-manual-2",
				now: NOW + 1,
			});
			expect(blocked.kind).toBe("pending_other");
			expect(blocked.row).toMatchObject({
				request_id: "req-manual-1",
				grant_id: "g_week_1",
			});
			expect(await repo.findByRequestId("acc-1", "req-manual-2")).toBeNull();
		});

		it("refuses a new manual claim while an auto claim is pending", async () => {
			const auto = await repo.claimAutoAttempt(AUTO);
			if (!auto) throw new Error("expected an auto claim");
			const blocked = await repo.beginManualAttempt(MANUAL);
			expect(blocked.kind).toBe("pending_other");
			expect(blocked.row.request_id).toBe(auto.requestId);
		});

		it("still reconciles the pending claim's own request id", async () => {
			const auto = await repo.claimAutoAttempt(AUTO);
			if (!auto) throw new Error("expected an auto claim");
			const replay = await repo.beginManualAttempt({
				...MANUAL,
				requestId: auto.requestId,
			});
			expect(replay.kind).toBe("existing");
			expect(replay.row.id).toBe(auto.id);
		});

		it("accepts a new request id once the pending claim resolved", async () => {
			const { row } = await repo.beginManualAttempt(MANUAL);
			await repo.resolveAttempt(row.id, { status: "reset", now: NOW + 1 });
			const next = await repo.beginManualAttempt({
				...MANUAL,
				requestId: "req-manual-2",
				now: NOW + 2,
			});
			expect(next.kind).toBe("created");
		});

		it("scopes request ids per account", async () => {
			await repo.beginManualAttempt(MANUAL);
			const other = await repo.beginManualAttempt({
				...MANUAL,
				accountId: "acc-2",
			});
			expect(other.kind).toBe("created");
		});
	});

	describe("resolution and replay bookkeeping", () => {
		it("resolves a pending row once, storing reason, cleared and resets left", async () => {
			const { row } = await repo.beginManualAttempt(MANUAL);
			expect(
				await repo.resolveAttempt(row.id, {
					status: "reset",
					reason: null,
					cleared: ["seven_day", "five_hour"],
					resetsLeft: 1,
					now: NOW + 1_000,
				}),
			).toBe(true);
			expect(
				await repo.resolveAttempt(row.id, {
					status: "failed",
					errorMessage: "late",
					now: NOW + 2_000,
				}),
			).toBe(false);

			const stored = await repo.findByRequestId("acc-1", "req-manual-1");
			expect(stored).toMatchObject({
				status: "reset",
				reason: null,
				cleared: '["seven_day","five_hour"]',
				resets_left: 1,
				error_message: null,
				resolved_at: NOW + 1_000,
			});
		});

		it("schedules the next replay only on a still-pending row", async () => {
			const { row } = await repo.beginManualAttempt(MANUAL);
			expect(
				await repo.setNextAttemptAt(row.id, NOW + 60_000, "HTTP 503"),
			).toBe(true);
			const pending = await repo.findPendingForAccount("acc-1");
			expect(pending).toHaveLength(1);
			expect(pending[0]).toMatchObject({
				next_attempt_at: NOW + 60_000,
				error_message: "HTTP 503",
			});

			await repo.resolveAttempt(row.id, { status: "cooldown", now: NOW + 1 });
			expect(await repo.setNextAttemptAt(row.id, NOW + 120_000, null)).toBe(
				false,
			);
			expect(await repo.findPendingForAccount("acc-1")).toEqual([]);
		});

		it("filters pending rows by trigger, oldest first", async () => {
			// Only a database written before claims excluded each other holds
			// two pending rows at once.
			db.run(
				`INSERT INTO anthropic_banked_reset_events (
					id, account_id, account_name, grant_id, trigger, cause,
					attempt_seq, request_id, status, created_at
				) VALUES
					('m1', 'acc-1', 'Claude One', 'g_week_1', 'manual', NULL, NULL,
						'req-manual-1', 'pending', ?),
					('acc-1:g_week_1:1', 'acc-1', 'Claude One', 'g_week_1', 'auto',
						'expiry', 1, 'req-auto-1', 'pending', ?)`,
				[NOW, NOW + 10],
			);
			expect(
				(await repo.findPendingForAccount("acc-1")).map((r) => r.trigger),
			).toEqual(["manual", "auto"]);
			expect(
				(await repo.findPendingForAccount("acc-1", "auto")).map(
					(r) => r.trigger,
				),
			).toEqual(["auto"]);
		});

		it("gives up a row unconfirmed 10 minutes after it opened as failed/unconfirmed", async () => {
			const { row } = await repo.beginManualAttempt(MANUAL);
			await repo.setNextAttemptAt(
				row.id,
				NOW + 15 * 60_000,
				"Banked-reset request returned 502 Bad Gateway",
			);
			await repo.claimAutoAttempt({
				...AUTO,
				accountId: "acc-2",
				now: NOW + 5 * 60_000,
			});
			expect(
				await repo.expireStalePending(
					NOW + ANTHROPIC_BANKED_RESET_REPLAY_WINDOW_MS - 1,
				),
			).toBe(0);
			expect(
				await repo.expireStalePending(
					NOW + ANTHROPIC_BANKED_RESET_REPLAY_WINDOW_MS,
				),
			).toBe(1);

			const expired = await repo.findByRequestId("acc-1", "req-manual-1");
			expect(expired).toMatchObject({
				status: "failed",
				reason: "unconfirmed",
				next_attempt_at: null,
				resolved_at: NOW + ANTHROPIC_BANKED_RESET_REPLAY_WINDOW_MS,
				error_message:
					"Unconfirmed 10 minutes after the attempt started; its request id is no longer replayed (last: Banked-reset request returned 502 Bad Gateway)",
			});
			expect(
				(await repo.findPendingForAccount("acc-2")).map((r) => r.status),
			).toEqual(["pending"]);
		});

		it("records a late answer over a given-up row, but not over another resolution", async () => {
			const { row } = await repo.beginManualAttempt(MANUAL);
			const late = NOW + ANTHROPIC_BANKED_RESET_REPLAY_WINDOW_MS;
			await repo.expireStalePending(late);
			expect(
				await repo.resolveAttempt(row.id, {
					status: "reset",
					cleared: ["seven_day"],
					now: late + 5_000,
				}),
			).toBe(true);
			expect(await repo.findByRequestId("acc-1", "req-manual-1")).toMatchObject(
				{
					status: "reset",
					reason: null,
					error_message: null,
					resolved_at: late + 5_000,
				},
			);
			expect(
				await repo.resolveAttempt(row.id, {
					status: "already_used",
					now: late + 6_000,
				}),
			).toBe(false);
		});

		it("explains a given-up row that recorded no error", async () => {
			await repo.beginManualAttempt(MANUAL);
			await repo.expireStalePending(
				NOW + ANTHROPIC_BANKED_RESET_REPLAY_WINDOW_MS,
			);
			expect(
				(await repo.findByRequestId("acc-1", "req-manual-1"))?.error_message,
			).toBe(
				"Unconfirmed 10 minutes after the attempt started; its request id is no longer replayed",
			);
		});

		it("lets a new claim on the account through once the unconfirmed one is given up", async () => {
			await repo.beginManualAttempt(MANUAL);
			const later = {
				...MANUAL,
				requestId: "req-manual-2",
				now: NOW + ANTHROPIC_BANKED_RESET_REPLAY_WINDOW_MS,
			};
			expect((await repo.beginManualAttempt(later)).kind).toBe("pending_other");
			await repo.expireStalePending(later.now);
			expect((await repo.beginManualAttempt(later)).kind).toBe("created");
		});
	});

	describe("getRearmAt", () => {
		it("re-arms an hour after not_limited, cooldown or ineligible, or at a later cooldown_until", async () => {
			expect(await repo.getRearmAt("acc-1")).toBeNull();
			const resolve = async (
				requestId: string,
				status: "not_limited" | "cooldown" | "ineligible" | "reset",
				now: number,
				cooldownUntil: number | null = null,
			) => {
				const { row } = await repo.beginManualAttempt({
					...MANUAL,
					requestId,
					now,
				});
				await repo.resolveAttempt(row.id, { status, now, cooldownUntil });
				return (await repo.findByRequestId("acc-1", requestId))?.rearm_at;
			};

			expect(await resolve("r-nl", "not_limited", NOW)).toBe(NOW + HOUR);
			expect(await resolve("r-in", "ineligible", NOW + 1)).toBe(NOW + 1 + HOUR);
			expect(await resolve("r-cd", "cooldown", NOW + 2, NOW + 3 * HOUR)).toBe(
				NOW + 3 * HOUR,
			);
			expect(await resolve("r-cd2", "cooldown", NOW + 3, NOW + 60_000)).toBe(
				NOW + 3 + HOUR,
			);
			expect(await resolve("r-ok", "reset", NOW + 4)).toBeNull();
			expect(await repo.getRearmAt("acc-1")).toBe(NOW + 3 * HOUR);
			expect(await repo.getRearmAt("acc-2")).toBeNull();
		});

		it("counts auto rows too", async () => {
			const claim = await repo.claimAutoAttempt(AUTO);
			if (!claim) throw new Error("expected a claim");
			await repo.resolveAttempt(claim.id, { status: "not_limited", now: NOW });
			expect(await repo.getRearmAt("acc-1")).toBe(NOW + HOUR);
		});
	});

	describe("overage-pause recovery marks", () => {
		it("records the obligation in the same write as the resolution, lists it across accounts, and clears it", async () => {
			const one = await repo.beginManualAttempt(MANUAL);
			await repo.resolveAttempt(one.row.id, {
				status: "reset",
				now: NOW,
				recovery: { until: NOW + HOUR, pauseEpoch: 4, pauseChangedAt: NOW - 5 },
			});
			const two = await repo.beginManualAttempt({
				...MANUAL,
				accountId: "acc-2",
				now: NOW + 1,
			});
			await repo.resolveAttempt(two.row.id, {
				status: "reset",
				now: NOW,
				recovery: { until: NOW + HOUR, pauseEpoch: 1, pauseChangedAt: null },
			});
			const three = await repo.beginManualAttempt({
				...MANUAL,
				accountId: "acc-3",
				now: NOW + 2,
			});
			await repo.resolveAttempt(three.row.id, { status: "reset", now: NOW });

			expect(
				(await repo.findRecoveryPending()).map((r) => [
					r.account_id,
					r.status,
					r.recovery_pending_until,
					r.recovery_pause_epoch,
					r.recovery_pause_changed_at,
				]),
			).toEqual([
				["acc-1", "reset", NOW + HOUR, 4, NOW - 5],
				["acc-2", "reset", NOW + HOUR, 1, null],
			]);

			expect(await repo.clearRecoveryPending(one.row.id)).toBe(true);
			expect(await repo.clearRecoveryPending(one.row.id)).toBe(false);
			expect(
				(await repo.findRecoveryPending()).map((r) => r.account_id),
			).toEqual(["acc-2"]);
		});
	});

	describe("getLatestAutoApplyCooldownAnchorAt", () => {
		it("anchors on the latest auto reset or already_used resolution only", async () => {
			expect(await repo.getLatestAutoApplyCooldownAnchorAt("acc-1")).toBeNull();

			const statuses = [
				["reset", NOW + 1],
				["cooldown", NOW + 50],
				["not_limited", NOW + 30],
				["failed", NOW + 60],
				["already_used", NOW + 20],
				["ineligible", NOW + 70],
			] as const;
			for (const [status, at] of statuses) {
				const claim = await repo.claimAutoAttempt({ ...AUTO, now: at });
				if (!claim) throw new Error("expected a claim");
				await repo.resolveAttempt(claim.id, { status, now: at });
			}
			// A manual reset never anchors the automatic cooldown.
			const { row } = await repo.beginManualAttempt(MANUAL);
			await repo.resolveAttempt(row.id, { status: "reset", now: NOW + 99 });

			expect(await repo.getLatestAutoApplyCooldownAnchorAt("acc-1")).toBe(
				NOW + 20,
			);
		});
	});

	it("lists recent events newest first", async () => {
		for (const [requestId, at] of [
			["req-manual-1", NOW],
			["req-2", NOW + 1],
			["req-3", NOW + 2],
		] as const) {
			const { row } = await repo.beginManualAttempt({
				...MANUAL,
				requestId,
				now: at,
			});
			await repo.resolveAttempt(row.id, { status: "reset", now: at });
		}
		expect(
			(await repo.findRecentForAccount("acc-1", 2)).map((r) => r.request_id),
		).toEqual(["req-3", "req-2"]);
	});
});
