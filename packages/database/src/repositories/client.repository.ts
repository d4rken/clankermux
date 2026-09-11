import type { ClientProfile } from "@clankermux/types";
import { BaseRepository } from "./base.repository";
import { RoutingConflictError } from "./routing.repository";

const MARKER = "backfill:client-catalogues-v1";
interface ProfileRow {
	api_key_id: string;
	application: ClientProfile["application"];
	revision: number;
	catalogues: string;
	notices: string;
}
export class ClientRepository extends BaseRepository<ClientProfile> {
	async getProfile(id: string): Promise<ClientProfile | null> {
		const row = await this.get<ProfileRow>(
			"SELECT * FROM client_profiles WHERE api_key_id=?",
			[id],
		);
		return row
			? {
					apiKeyId: row.api_key_id,
					application: row.application,
					revision: row.revision,
					catalogues: JSON.parse(row.catalogues),
					notices: JSON.parse(row.notices),
				}
			: null;
	}
	async isBootstrapped(): Promise<boolean> {
		return !!(await this.get("SELECT 1 FROM strategies WHERE name=?", [
			MARKER,
		]));
	}
	insertInTransaction(profile: ClientProfile): void {
		const db = this.adapter.getSQLiteDb();
		if (!db.query("SELECT 1 FROM api_keys WHERE id=?").get(profile.apiKeyId))
			throw new Error("Client key does not exist");
		db.query(
			"INSERT INTO client_profiles(api_key_id,application,revision,catalogues,notices) VALUES(?,?,?,?,?)",
		).run(
			profile.apiKeyId,
			profile.application,
			profile.revision,
			JSON.stringify(profile.catalogues),
			JSON.stringify(profile.notices),
		);
	}
	async bootstrap(profiles: ClientProfile[]): Promise<boolean> {
		return this.adapter.runTransaction(() => {
			const db = this.adapter.getSQLiteDb();
			if (db.query("SELECT 1 FROM strategies WHERE name=?").get(MARKER))
				return false;
			const keys = db.query("SELECT id FROM api_keys").all() as {
				id: string;
			}[];
			if (
				keys.length !== profiles.length ||
				keys.some((k) => !profiles.some((p) => p.apiKeyId === k.id))
			)
				throw new RoutingConflictError("Client keys changed during migration");
			for (const profile of profiles) this.insertInTransaction(profile);
			db.query(
				"INSERT INTO strategies(name,config,updated_at) VALUES(?,?,?)",
			).run(MARKER, "{}", Date.now());
			return true;
		});
	}
	saveInTransaction(profile: ClientProfile, expectedRevision: number): void {
		if (expectedRevision === 0) {
			if (
				this.adapter
					.getSQLiteDb()
					.query("SELECT 1 FROM client_profiles WHERE api_key_id=?")
					.get(profile.apiKeyId)
			)
				throw new RoutingConflictError(
					"Client changed; reload and review again",
				);
			this.insertInTransaction({ ...profile, revision: 1 });
			return;
		}
		const changes = this.adapter
			.getSQLiteDb()
			.query(
				"UPDATE client_profiles SET application=?,revision=revision+1,catalogues=?,notices=? WHERE api_key_id=? AND revision=?",
			)
			.run(
				profile.application,
				JSON.stringify(profile.catalogues),
				JSON.stringify(profile.notices),
				profile.apiKeyId,
				expectedRevision,
			).changes;
		if (!changes)
			throw new RoutingConflictError("Client changed; reload and review again");
	}
	async saveProfile(
		profile: ClientProfile,
		expectedRevision: number,
	): Promise<void> {
		await this.adapter.runTransaction(() =>
			this.saveInTransaction(profile, expectedRevision),
		);
	}
	async ownedRuleIds(id: string): Promise<string[]> {
		return (
			await this.query<{ rule_id: string }>(
				"SELECT rule_id FROM client_alias_rules WHERE api_key_id=?",
				[id],
			)
		).map((r) => r.rule_id);
	}
}
