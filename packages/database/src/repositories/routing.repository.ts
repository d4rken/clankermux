import {
	isAccountAllowedByPin,
	isModelAliasId,
	isRoutingPinValid,
	validateRoutingRule,
} from "@clankermux/core";
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

/**
 * Whether an error means "this input does not fit this client" rather than a
 * server fault. {@link RoutingRepository.assertPinCompatible} and the
 * rule-reference guards throw plain `Error`s, so the class alone cannot tell
 * the two apart and the message has to be read.
 */
export function isClientInputError(error: unknown): boolean {
	return (
		error instanceof RoutingConflictError ||
		(error instanceof Error &&
			/referenced by routing rules|conflicts with API key destinations|UNIQUE constraint failed/.test(
				error.message,
			))
	);
}

/** One row of the substitution-history query: see `getModelSubstitutions`. */
type SubstitutionSeriesRow = {
	bucket: number;
	mismatch_provider: string | null;
	mismatch_outgoing: string | null;
	mismatch_reported: string | null;
	c: number;
};

/**
 * Regroup the flat bucket × mismatch-pair rows into one point per bucket.
 *
 * Every row counts towards its bucket's denominator; only the ones the CASEs
 * left non-null describe a mismatch. Insertion order follows the query's
 * `ORDER BY bucket`, so the points come out ascending without a second sort.
 */
function collectSubstitutionSeries(rows: readonly SubstitutionSeriesRow[]) {
	const byBucket = new Map<
		number,
		{
			bucketMs: number;
			comparable: number;
			candidates: Array<{
				provider: string | null;
				outgoingModel: string;
				reportedModel: string;
				count: number;
			}>;
		}
	>();
	for (const row of rows) {
		let point = byBucket.get(row.bucket);
		if (point === undefined) {
			point = { bucketMs: row.bucket, comparable: 0, candidates: [] };
			byBucket.set(row.bucket, point);
		}
		point.comparable += row.c;
		if (row.mismatch_outgoing !== null && row.mismatch_reported !== null) {
			point.candidates.push({
				provider: row.mismatch_provider,
				outgoingModel: row.mismatch_outgoing,
				reportedModel: row.mismatch_reported,
				count: row.c,
			});
		}
	}
	return [...byBucket.values()];
}

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
		return this.adapter.runTransaction(() =>
			this.saveRuleInTransaction(input, append),
		);
	}
	saveRuleInTransaction(input: RoutingRule, append = false): RoutingRule {
		const r = { ...validateRoutingRule(input) };
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
			!db.query("SELECT id FROM api_keys WHERE id = ?").get(r.match_api_key_id)
		)
			throw new Error("Routing rule references a missing API key");
		for (const id of r.pool_account_ids ?? [])
			if (!db.query("SELECT id FROM accounts WHERE id = ?").get(id))
				throw new Error(`Routing rule references missing account ${id}`);
		if (
			r.target_kind === "literal" &&
			r.target_model &&
			isModelAliasId(r.target_model) &&
			!db.query("SELECT id FROM model_aliases WHERE id=?").get(r.target_model)
		)
			throw new Error("Routing rule references a missing model alias");
		if (r.pool_provider !== null && !isKnownProvider(r.pool_provider))
			throw new Error("Unknown pool provider");
		if (r.match_api_key_id !== null) {
			const key = db
				.query(
					"SELECT pinned_account_id,pinned_providers,excluded_providers FROM api_keys WHERE id=?",
				)
				.get(r.match_api_key_id) as {
				pinned_account_id: string | null;
				pinned_providers: string | null;
				excluded_providers: string | null;
			};
			this.assertPinCompatible(
				r,
				key.pinned_account_id,
				key.pinned_providers,
				key.excluded_providers,
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
		return r;
	}

	assertPinCompatible(
		r: RoutingRule,
		accountId: string | null,
		rawProviders: string | null,
		rawExcludedProviders: string | null = null,
	): void {
		const providers = parsePinnedProviders(rawProviders);
		const excludedProviders = parsePinnedProviders(rawExcludedProviders);
		const pin = { accountId, providers, excludedProviders };
		if (
			(rawProviders !== null && !providers) ||
			(rawExcludedProviders !== null && !excludedProviders) ||
			!isRoutingPinValid(pin)
		)
			throw new Error("Key destinations are invalid");
		if (
			r.pool_kind === "inherit" ||
			(accountId === null && providers === null && excludedProviders === null)
		)
			return;
		if (r.pool_kind === "provider" && accountId === null) {
			if (
				!isAccountAllowedByPin(pin, { id: "", provider: r.pool_provider ?? "" })
			)
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
					isAccountAllowedByPin(pin, a) &&
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
		excludedProviders: string[] | null = null,
	): Promise<void> {
		for (const r of await this.listRules())
			if (r.match_api_key_id === keyId)
				this.assertPinCompatible(
					r,
					accountId,
					providers === null ? null : JSON.stringify(providers),
					excludedProviders === null ? null : JSON.stringify(excludedProviders),
				);
	}

	async updateApiKeyDestinations(
		id: string,
		accountId: string | null,
		providers: string[] | null,
		excludedProviders: string[] | null = null,
	): Promise<boolean> {
		return this.adapter.runTransaction(() =>
			this.updateDestinationsInTransaction(
				id,
				accountId,
				providers,
				excludedProviders,
			),
		);
	}
	updateDestinationsInTransaction(
		id: string,
		accountId: string | null,
		providers: string[] | null,
		excludedProviders: string[] | null = null,
	): boolean {
		if (!isRoutingPinValid({ accountId, providers, excludedProviders }))
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
				excludedProviders === null ? null : JSON.stringify(excludedProviders),
			);
		return (
			db
				.query(
					"UPDATE api_keys SET pinned_account_id=?,pinned_providers=?,excluded_providers=? WHERE id=?",
				)
				.run(
					accountId,
					providers === null ? null : JSON.stringify(providers),
					excludedProviders === null ? null : JSON.stringify(excludedProviders),
					id,
				).changes > 0
		);
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
		return (
			(await this.modelSuppressionReason(accountId, scope, model, now)) !== null
		);
	}
	/**
	 * The `reason` of a live suppression, or null when the pair is not suppressed.
	 *
	 * Route construction needs the reason, not just the fact: a route emptied by
	 * substitution suppressions must raise the substitution terminal rather than
	 * the generic 403 that says the destination no longer permits the model.
	 * A row with a NULL reason reads as "" so a caller can still distinguish it
	 * from "not suppressed".
	 */
	async modelSuppressionReason(
		accountId: string,
		scope: string,
		model: string,
		now: number,
	): Promise<string | null> {
		const row = await this.get<{ reason: string | null }>(
			"SELECT reason FROM account_model_suppressions WHERE account_id=? AND scope=? AND model=? AND until_at>?",
			[accountId, scope, model, now],
		);
		return row ? (row.reason ?? "") : null;
	}
	/**
	 * Drop every suppression this proxy wrote for a given reason.
	 *
	 * The suppression gates are unconditional, so turning the substitution
	 * setting down would otherwise leave accounts out of rotation for the rest of
	 * their window. Keyed on the reason so genuine `upstream_model_rejected`
	 * suppressions are untouched.
	 */
	async clearModelSuppressionsByReason(reason: string): Promise<void> {
		await this.run("DELETE FROM account_model_suppressions WHERE reason=?", [
			reason,
		]);
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
	/**
	 * `reportedModel` fills the served model for an attempt whose body was
	 * DISCARDED before the response observer could finish it. A substitution
	 * failover is exactly that case, and without this the row for the attempt
	 * the proxy acted on is the one row missing the evidence it acted on.
	 *
	 * COALESCE, so an observer that did finish first still wins.
	 */
	async annotateAttempt(
		id: string,
		error: string,
		status: number | null,
		reportedModel: string | null = null,
	): Promise<void> {
		await this.run(
			"UPDATE routing_attempts SET error=?,status=COALESCE(status,?),reported_model=COALESCE(reported_model,?) WHERE id=?",
			[error, status, reportedModel, id],
		);
	}

	/**
	 * (account, sent model, served model) counts where the provider answered as
	 * something other than what it was sent.
	 *
	 * Aggregated over `routing_attempts`, and deliberately NOT joined to
	 * `requests` for filtering. The standard request filters key on the FINAL
	 * row's `account_used` and `model`, and a substituted attempt is by design
	 * not the attempt that produced that row — the next account serves it. So
	 * filtering this by the request's account would hide account A's
	 * substitution in exactly the case the feature exists for.
	 *
	 * `comparable` counts attempts that sent the same model on the same account
	 * AND got some model back, so the share has an honest denominator: an
	 * attempt the provider never named a model for is "could not tell", not
	 * evidence of correct service.
	 *
	 * Virtual slugs are excluded by the caller, which owns that vocabulary.
	 */
	async getModelSubstitutions(opts: {
		sinceMs: number;
		bucketMs: number;
	}): Promise<{
		pairs: Array<{
			accountId: string;
			provider: string;
			outgoingModel: string;
			reportedModel: string;
			substituted: number;
			firstAtMs: number;
			lastAtMs: number;
		}>;
		comparable: Array<{
			accountId: string;
			outgoingModel: string;
			comparable: number;
		}>;
		/**
		 * History buckets, reported as a denominator plus the mismatch
		 * CANDIDATES that make it up.
		 *
		 * A bucket cannot carry a `substituted` count, because SQL cannot decide
		 * what a substitution is: the comparison that does lives in
		 * `@clankermux/proxy` and knows alias spellings and provider-keyed
		 * renames this query has no access to. Counting raw inequality here
		 * would draw a model its provider simply names differently as a swap,
		 * for as long as the rows are retained.
		 */
		series: Array<{
			bucketMs: number;
			comparable: number;
			candidates: Array<{
				provider: string | null;
				outgoingModel: string;
				reportedModel: string;
				count: number;
			}>;
		}>;
	}> {
		// One predicate, three shapes. `started_at` carries the only index that
		// matters here (idx_routing_attempts_started); everything else is a
		// filter over the window it selects.
		const live =
			"kind='upstream_send' AND reported_model IS NOT NULL AND outgoing_model IS NOT NULL AND started_at>=?";
		const [pairs, comparable, series] = await Promise.all([
			this.query<{
				account_id: string;
				provider: string;
				outgoing_model: string;
				reported_model: string;
				c: number;
				first_ms: number;
				last_ms: number;
			}>(
				`SELECT account_id,provider,outgoing_model,reported_model,COUNT(*) AS c,MIN(started_at) AS first_ms,MAX(started_at) AS last_ms
				 FROM routing_attempts WHERE ${live} AND reported_model<>outgoing_model
				 GROUP BY account_id,provider,outgoing_model,reported_model`,
				[opts.sinceMs],
			),
			this.query<{
				account_id: string;
				outgoing_model: string;
				c: number;
			}>(
				`SELECT account_id,outgoing_model,COUNT(*) AS c
				 FROM routing_attempts WHERE ${live}
				 GROUP BY account_id,outgoing_model`,
				[opts.sinceMs],
			),
			// Matching attempts collapse to ONE null-keyed row per bucket, so the
			// extra grouping columns only fan out over the distinct mismatched
			// pairs the caller has to judge anyway. Positional GROUP BY: naming
			// the aliases would bind to the source columns of the same name
			// (SQLite prefers those) and split the matched rows by provider too.
			this.query<SubstitutionSeriesRow>(
				`SELECT (started_at/?)*? AS bucket,
				        CASE WHEN reported_model<>outgoing_model THEN provider END AS mismatch_provider,
				        CASE WHEN reported_model<>outgoing_model THEN outgoing_model END AS mismatch_outgoing,
				        CASE WHEN reported_model<>outgoing_model THEN reported_model END AS mismatch_reported,
				        COUNT(*) AS c
				 FROM routing_attempts WHERE ${live}
				 GROUP BY 1,2,3,4 ORDER BY bucket`,
				[opts.bucketMs, opts.bucketMs, opts.sinceMs],
			),
		]);
		return {
			pairs: pairs.map((r) => ({
				accountId: r.account_id,
				provider: r.provider,
				outgoingModel: r.outgoing_model,
				reportedModel: r.reported_model,
				substituted: r.c,
				firstAtMs: r.first_ms,
				lastAtMs: r.last_ms,
			})),
			comparable: comparable.map((r) => ({
				accountId: r.account_id,
				outgoingModel: r.outgoing_model,
				comparable: r.c,
			})),
			series: collectSubstitutionSeries(series),
		};
	}

	async listAttempts(requestId: string): Promise<RoutingAttempt[]> {
		// Millisecond timestamps can tie; SQLite row order preserves dispatch
		// insertion order while random attempt UUIDs do not.
		return this.query(
			"SELECT a.*,s.content AS route_snapshot FROM routing_attempts a LEFT JOIN routing_snapshots s ON s.id=a.route_snapshot_id WHERE request_id=? ORDER BY started_at,a.rowid",
			[requestId],
		);
	}
}
