import { isAccountAllowedByPin, validateRoutingRule } from "@clankermux/core";
import type {
	AccountModelPermissions,
	RoutingAttempt,
	RoutingRule,
} from "@clankermux/types";
import { isKnownProvider, parsePinnedProviders } from "@clankermux/types";
import { BaseRepository } from "./base.repository";

type RuleRow = Omit<RoutingRule, "enabled" | "pool_account_ids"> & {
	enabled: number;
	pool_account_ids: string | null;
};
type PermissionRow = Omit<
	AccountModelPermissions,
	"discovered_ids" | "manual_ids"
> & { discovered_ids: string; manual_ids: string };
const decodePermission = (r: PermissionRow): AccountModelPermissions => ({
	...r,
	discovered_ids: JSON.parse(r.discovered_ids),
	manual_ids: JSON.parse(r.manual_ids),
});
function modelIds(ids: string[]): string[] {
	if (
		!Array.isArray(ids) ||
		ids.length > 10000 ||
		ids.some(
			(id) =>
				typeof id !== "string" ||
				!id.trim() ||
				id !== id.trim() ||
				id.length > 256,
		)
	)
		throw new Error("Invalid model IDs");
	return [...new Set(ids)].sort();
}
export class RoutingConflictError extends Error {}

export class RoutingRepository extends BaseRepository<RoutingRule> {
	async listRules(): Promise<RoutingRule[]> {
		return (
			await this.query<RuleRow>("SELECT * FROM routing_rules ORDER BY position")
		).map((r) =>
			validateRoutingRule({
				...r,
				enabled: r.enabled === 1,
				pool_account_ids:
					r.pool_account_ids === null ? null : JSON.parse(r.pool_account_ids),
			}),
		);
	}
	async saveRule(input: RoutingRule, append = false): Promise<RoutingRule> {
		const r = { ...validateRoutingRule(input) };
		await this.adapter.runTransaction(() => {
			const db = this.adapter.getSQLiteDb();
			if (append)
				r.position = (
					db
						.query(
							"SELECT COALESCE(MAX(position),-1)+1 AS position FROM routing_rules",
						)
						.get() as { position: number }
				).position;
			if (
				db
					.query("SELECT 1 FROM routing_rules WHERE position=? AND id<>?")
					.get(r.position, r.id)
			)
				throw new RoutingConflictError(
					"Rule position is already in use; reload the routing table",
				);

			if (
				r.match_api_key_id !== null &&
				!db
					.query("SELECT id FROM api_keys WHERE id = ?")
					.get(r.match_api_key_id)
			)
				throw new Error("Routing rule references a missing API key");
			for (const id of r.pool_account_ids ?? [])
				if (!db.query("SELECT id FROM accounts WHERE id = ?").get(id))
					throw new Error(`Routing rule references missing account ${id}`);
			if (r.pool_provider !== null && !isKnownProvider(r.pool_provider))
				throw new Error("Unknown pool provider");
			if (r.match_api_key_id !== null) {
				const key = db
					.query(
						"SELECT pinned_account_id,pinned_providers FROM api_keys WHERE id=?",
					)
					.get(r.match_api_key_id) as {
					pinned_account_id: string | null;
					pinned_providers: string | null;
				};
				this.assertPinCompatible(
					r,
					key.pinned_account_id,
					key.pinned_providers,
				);
			}

			db.query(`INSERT INTO routing_rules (id,name,enabled,position,match_api_key_id,match_model_kind,match_model_value,pool_kind,pool_provider,pool_account_ids,target_kind,target_model)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled,position=excluded.position,match_api_key_id=excluded.match_api_key_id,match_model_kind=excluded.match_model_kind,match_model_value=excluded.match_model_value,pool_kind=excluded.pool_kind,pool_provider=excluded.pool_provider,pool_account_ids=excluded.pool_account_ids,target_kind=excluded.target_kind,target_model=excluded.target_model`).run(
				r.id,
				r.name,
				r.enabled ? 1 : 0,
				r.position,
				r.match_api_key_id,
				r.match_model_kind,
				r.match_model_value,
				r.pool_kind,
				r.pool_provider,
				r.pool_account_ids === null ? null : JSON.stringify(r.pool_account_ids),
				r.target_kind,
				r.target_model,
			);
		});
		return r;
	}
	private assertPinCompatible(
		r: RoutingRule,
		accountId: string | null,
		rawProviders: string | null,
	): void {
		const providers = parsePinnedProviders(rawProviders);
		if (
			(rawProviders !== null && !providers) ||
			(accountId !== null && providers !== null)
		)
			throw new Error("Key destinations are invalid");
		if (r.pool_kind === "inherit" || (accountId === null && providers === null))
			return;
		if (r.pool_kind === "provider" && providers !== null) {
			if (!providers.includes(r.pool_provider ?? ""))
				throw new Error(`Rule ${r.name} conflicts with API key destinations`);
			return;
		}
		const accounts = this.adapter
			.getSQLiteDb()
			.query("SELECT id,provider FROM accounts")
			.all() as { id: string; provider: string }[];
		if (
			!accounts.some(
				(a) =>
					isAccountAllowedByPin({ accountId, providers }, a) &&
					(r.pool_kind === "provider"
						? a.provider === r.pool_provider
						: r.pool_account_ids?.includes(a.id)),
			)
		)
			throw new Error(`Rule ${r.name} conflicts with API key destinations`);
	}
	async validatePinRules(
		keyId: string,
		accountId: string | null,
		providers: string[] | null,
	): Promise<void> {
		for (const r of await this.listRules())
			if (r.match_api_key_id === keyId)
				this.assertPinCompatible(
					r,
					accountId,
					providers === null ? null : JSON.stringify(providers),
				);
	}

	async updateApiKeyDestinations(
		id: string,
		accountId: string | null,
		providers: string[] | null,
	): Promise<boolean> {
		return this.adapter.runTransaction(() => {
			if (
				(accountId !== null && providers !== null) ||
				(providers !== null &&
					(!providers.length || providers.some((p) => !isKnownProvider(p))))
			)
				throw new Error("Invalid API key destinations");
			const db = this.adapter.getSQLiteDb();
			if (
				accountId !== null &&
				!db.query("SELECT id FROM accounts WHERE id=?").get(accountId)
			)
				throw new Error("Destination account does not exist");
			const rows = db
				.query("SELECT * FROM routing_rules WHERE match_api_key_id=?")
				.all(id) as RuleRow[];
			for (const row of rows)
				this.assertPinCompatible(
					validateRoutingRule({
						...row,
						enabled: row.enabled === 1,
						pool_account_ids:
							row.pool_account_ids === null
								? null
								: JSON.parse(row.pool_account_ids),
					}),
					accountId,
					providers === null ? null : JSON.stringify(providers),
				);
			return (
				db
					.query(
						"UPDATE api_keys SET pinned_account_id=?,pinned_providers=? WHERE id=?",
					)
					.run(
						accountId,
						providers === null ? null : JSON.stringify(providers),
						id,
					).changes > 0
			);
		});
	}

	async removeRule(id: string): Promise<void> {
		await this.run("DELETE FROM routing_rules WHERE id = ?", [id]);
	}
	async reorderRules(ids: string[]): Promise<void> {
		await this.adapter.runTransaction(() => {
			const db = this.adapter.getSQLiteDb();
			const rows = db.query("SELECT id FROM routing_rules").all() as {
				id: string;
			}[];
			if (
				new Set(ids).size !== ids.length ||
				rows.length !== ids.length ||
				rows.some((r) => !ids.includes(r.id))
			)
				throw new Error("Reorder must contain every rule exactly once");
			// Negative positions are reserved for this transaction and never committed.
			for (const [i, id] of ids.entries())
				db.query("UPDATE routing_rules SET position=? WHERE id=?").run(
					-i - 1,
					id,
				);
			for (const [i, id] of ids.entries())
				db.query("UPDATE routing_rules SET position=? WHERE id=?").run(i, id);
		});
	}
	async getPermissions(
		accountId: string,
	): Promise<AccountModelPermissions | null> {
		const row = await this.get<PermissionRow>(
			"SELECT * FROM account_model_permissions WHERE account_id=?",
			[accountId],
		);
		return row ? decodePermission(row) : null;
	}
	async ensurePermissionScope(
		accountId: string,
		scope: string,
		expectedGeneration?: number,
	): Promise<AccountModelPermissions> {
		return this.adapter.runTransaction(() => {
			const db = this.adapter.getSQLiteDb();
			db.query(`INSERT INTO account_model_permissions(account_id,scope,generation,completeness,discovered_ids,manual_ids) VALUES(?,?,1,'unknown','[]','[]')
    ON CONFLICT(account_id) DO UPDATE SET scope=excluded.scope,generation=generation+1,completeness='unknown',discovered_ids='[]',manual_ids='[]',last_success_at=NULL,last_attempt_at=NULL,last_error=NULL WHERE scope<>excluded.scope AND (? IS NULL OR generation=?)`).run(
				accountId,
				scope,
				expectedGeneration ?? null,
				expectedGeneration ?? null,
			);
			return decodePermission(
				db
					.query("SELECT * FROM account_model_permissions WHERE account_id=?")
					.get(accountId) as PermissionRow,
			);
		});
	}
	async setManualModels(
		accountId: string,
		scope: string,
		ids: string[],
		declareEmpty = false,
		expectedGeneration?: number,
	): Promise<AccountModelPermissions> {
		const manual = modelIds(ids);
		if (expectedGeneration === undefined)
			await this.ensurePermissionScope(accountId, scope);
		return this.adapter.runTransaction(() => {
			const db = this.adapter.getSQLiteDb();
			const result = db
				.query(`UPDATE account_model_permissions SET manual_ids=?, generation=generation+1,
    completeness=CASE WHEN last_success_at IS NULL THEN CASE WHEN ?=1 THEN 'known-empty' ELSE completeness END ELSE completeness END
    WHERE account_id=? AND scope=? AND (? IS NULL OR generation=?)`)
				.run(
					JSON.stringify(manual),
					declareEmpty && manual.length === 0 ? 1 : 0,
					accountId,
					scope,
					expectedGeneration ?? null,
					expectedGeneration ?? null,
				);
			if (!result.changes)
				throw new RoutingConflictError(
					"Account identity changed during model edit",
				);
			return decodePermission(
				db
					.query("SELECT * FROM account_model_permissions WHERE account_id=?")
					.get(accountId) as PermissionRow,
			);
		});
	}
	async completeDiscovery(
		accountId: string,
		scope: string,
		generation: number,
		ids: string[],
		now: number,
	): Promise<boolean> {
		const discovered = modelIds(ids);
		return (
			(await this.runWithChanges(
				`UPDATE account_model_permissions SET discovered_ids=?,completeness=?,last_success_at=?,last_attempt_at=?,last_error=NULL WHERE account_id=? AND scope=? AND generation=?`,
				[
					JSON.stringify(discovered),
					discovered.length ? "known-complete" : "known-empty",
					now,
					now,
					accountId,
					scope,
					generation,
				],
			)) > 0
		);
	}
	async failDiscovery(
		accountId: string,
		scope: string,
		generation: number,
		error: string,
		now: number,
	): Promise<void> {
		await this.run(
			"UPDATE account_model_permissions SET last_attempt_at=?,last_error=? WHERE account_id=? AND scope=? AND generation=?",
			[now, error.slice(0, 2000), accountId, scope, generation],
		);
	}
	async suppressModel(
		accountId: string,
		scope: string,
		model: string,
		until: number,
		reason: string,
	): Promise<void> {
		await this.run(
			`INSERT INTO account_model_suppressions(account_id,scope,model,until_at,reason) VALUES(?,?,?,?,?) ON CONFLICT(account_id,scope,model) DO UPDATE SET until_at=MAX(until_at,excluded.until_at),reason=excluded.reason`,
			[accountId, scope, model, until, reason],
		);
	}
	async isModelSuppressed(
		accountId: string,
		scope: string,
		model: string,
		now: number,
	): Promise<boolean> {
		return !!(await this.get(
			"SELECT 1 FROM account_model_suppressions WHERE account_id=? AND scope=? AND model=? AND until_at>?",
			[accountId, scope, model, now],
		));
	}
	async clearModelSuppression(
		accountId: string,
		scope: string,
		model: string,
	): Promise<void> {
		await this.run(
			"DELETE FROM account_model_suppressions WHERE account_id=? AND scope=? AND model=?",
			[accountId, scope, model],
		);
	}
	async recordAttempt(
		a: RoutingAttempt & { route_snapshot: string },
	): Promise<void> {
		const snapshotId = new Bun.CryptoHasher("sha256")
			.update(a.route_snapshot)
			.digest("hex");
		await this.adapter.runTransaction(() => {
			const db = this.adapter.getSQLiteDb();
			db.query(
				"INSERT OR IGNORE INTO routing_snapshots(id,content) VALUES(?,?)",
			).run(snapshotId, a.route_snapshot);
			db.query(
				`INSERT INTO routing_attempts(id,request_id,rule_id,route_snapshot_id,account_id,provider,requested_model,resolved_model,outgoing_model,reported_model,kind,started_at,finished_at,status,error,reasoning_effort_requested,reasoning_effort_effective,reasoning_effort_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			).run(
				a.id,
				a.request_id,
				a.rule_id,
				snapshotId,
				a.account_id,
				a.provider,
				a.requested_model,
				a.resolved_model,
				a.outgoing_model,
				a.reported_model,
				a.kind,
				a.started_at,
				a.finished_at,
				a.status,
				a.error,
				a.reasoning_effort_requested,
				a.reasoning_effort_effective,
				a.reasoning_effort_reason,
			);
		});
	}
	async finishAttempt(
		id: string,
		finishedAt: number,
		status: number,
		error: string | null,
		reportedModel: string | null,
	): Promise<void> {
		await this.run(
			"UPDATE routing_attempts SET finished_at=?,status=?,error=COALESCE(error,?),reported_model=? WHERE id=?",
			[finishedAt, status, error, reportedModel, id],
		);
	}
	async annotateAttempt(
		id: string,
		error: string,
		status: number | null,
	): Promise<void> {
		await this.run(
			"UPDATE routing_attempts SET error=?,status=COALESCE(status,?) WHERE id=?",
			[error, status, id],
		);
	}

	async listAttempts(requestId: string): Promise<RoutingAttempt[]> {
		return this.query(
			"SELECT a.*,s.content AS route_snapshot FROM routing_attempts a LEFT JOIN routing_snapshots s ON s.id=a.route_snapshot_id WHERE request_id=? ORDER BY started_at,a.id",
			[requestId],
		);
	}
}
