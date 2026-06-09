import { type ApiKey, type ApiKeyRow, toApiKey } from "@clankermux/types";
import { BaseRepository } from "./base.repository";

export class ApiKeyRepository extends BaseRepository<ApiKey> {
	/**
	 * Find all API keys, ordered by creation date (newest first)
	 */
	async findAll(): Promise<ApiKey[]> {
		const rows = await this.query<ApiKeyRow>(`
			SELECT
				id, name, hashed_key, prefix_last_8, created_at,
				last_used, usage_count, is_active,
				pinned_account_id, pinned_providers
			FROM api_keys
			ORDER BY created_at DESC
		`);
		return rows.map(toApiKey);
	}

	/**
	 * Find only active API keys
	 */
	async findActive(): Promise<ApiKey[]> {
		const rows = await this.query<ApiKeyRow>(`
			SELECT
				id, name, hashed_key, prefix_last_8, created_at,
				last_used, usage_count, is_active,
				pinned_account_id, pinned_providers
			FROM api_keys
			WHERE is_active = 1
			ORDER BY created_at DESC
		`);
		return rows.map(toApiKey);
	}

	/**
	 * Find API key by ID
	 */
	async findById(id: string): Promise<ApiKey | null> {
		const row = await this.get<ApiKeyRow>(
			`
			SELECT
				id, name, hashed_key, prefix_last_8, created_at,
				last_used, usage_count, is_active,
				pinned_account_id, pinned_providers
			FROM api_keys
			WHERE id = ?
		`,
			[id],
		);

		return row ? toApiKey(row) : null;
	}

	/**
	 * Find API key by hashed key (for authentication)
	 */
	async findByHashedKey(hashedKey: string): Promise<ApiKey | null> {
		const row = await this.get<ApiKeyRow>(
			`
			SELECT
				id, name, hashed_key, prefix_last_8, created_at,
				last_used, usage_count, is_active,
				pinned_account_id, pinned_providers
			FROM api_keys
			WHERE hashed_key = ? AND is_active = 1
		`,
			[hashedKey],
		);

		return row ? toApiKey(row) : null;
	}

	/**
	 * Read the RAW routing-pin columns for a key (no domain parsing). Lets the
	 * routing layer tell "no pin" apart from "pin stored but unparseable" so it
	 * can fail closed on a corrupt/tampered pinned_providers value.
	 */
	async findRawPinById(id: string): Promise<{
		pinnedAccountId: string | null;
		pinnedProvidersRaw: string | null;
	} | null> {
		const row = await this.get<{
			pinned_account_id: string | null;
			pinned_providers: string | null;
		}>(
			`
			SELECT pinned_account_id, pinned_providers
			FROM api_keys
			WHERE id = ?
		`,
			[id],
		);

		return row
			? {
					pinnedAccountId: row.pinned_account_id ?? null,
					pinnedProvidersRaw: row.pinned_providers ?? null,
				}
			: null;
	}

	/**
	 * Find API key by name
	 */
	async findByName(name: string): Promise<ApiKey | null> {
		const row = await this.get<ApiKeyRow>(
			`
			SELECT
				id, name, hashed_key, prefix_last_8, created_at,
				last_used, usage_count, is_active,
				pinned_account_id, pinned_providers
			FROM api_keys
			WHERE name = ?
		`,
			[name],
		);

		return row ? toApiKey(row) : null;
	}

	/**
	 * Check if an API key name already exists
	 */
	async nameExists(name: string): Promise<boolean> {
		const row = await this.get<{ count: number }>(
			`
			SELECT COUNT(*) as count
			FROM api_keys
			WHERE name = ?
		`,
			[name],
		);

		return row ? row.count > 0 : false;
	}

	/**
	 * Create a new API key. New keys start unpinned — the pin columns
	 * (pinned_account_id, pinned_providers) default to NULL and are set later
	 * via updatePin — so they're excluded from the create contract.
	 */
	async create(
		apiKey: Omit<
			ApiKeyRow,
			"usage_count" | "pinned_account_id" | "pinned_providers"
		>,
	): Promise<void> {
		await this.run(
			`
			INSERT INTO api_keys (
				id, name, hashed_key, prefix_last_8, created_at,
				last_used, is_active
			) VALUES (?, ?, ?, ?, ?, ?, ?)
		`,
			[
				apiKey.id,
				apiKey.name,
				apiKey.hashed_key,
				apiKey.prefix_last_8,
				apiKey.created_at,
				apiKey.last_used,
				apiKey.is_active,
			],
		);
	}

	/**
	 * Update the last used timestamp and increment usage count
	 */
	async updateUsage(id: string, timestamp: number): Promise<void> {
		await this.run(
			`
			UPDATE api_keys
			SET last_used = ?,
				usage_count = usage_count + 1
			WHERE id = ?
		`,
			[timestamp, id],
		);
	}

	/**
	 * Set (or clear) the routing pin for an API key. `pinnedAccountId` pins the
	 * key to one backend account; `pinnedProviders` is the already-serialized
	 * JSON array string of allowed providers (or null). Serialization happens in
	 * the dbOps facade. Returns false when no row matched the id.
	 */
	async updatePin(
		id: string,
		pinnedAccountId: string | null,
		pinnedProviders: string | null,
	): Promise<boolean> {
		const changes = await this.runWithChanges(
			`
			UPDATE api_keys
			SET pinned_account_id = ?,
				pinned_providers = ?
			WHERE id = ?
		`,
			[pinnedAccountId, pinnedProviders, id],
		);

		return changes > 0;
	}

	/**
	 * Disable (soft delete) an API key
	 */
	async disable(id: string): Promise<boolean> {
		const changes = await this.runWithChanges(
			`
			UPDATE api_keys
			SET is_active = 0
			WHERE id = ?
		`,
			[id],
		);

		return changes > 0;
	}

	/**
	 * Enable (reactivate) a disabled API key
	 */
	async enable(id: string): Promise<boolean> {
		const changes = await this.runWithChanges(
			`
			UPDATE api_keys
			SET is_active = 1
			WHERE id = ?
		`,
			[id],
		);

		return changes > 0;
	}

	/** Rename an API key (change its label). Secret, stats, pin, and active state
	 *  are preserved. Returns false when no row matched the id (e.g. a TOCTOU delete). */
	async rename(id: string, newName: string): Promise<boolean> {
		const changes = await this.runWithChanges(
			`UPDATE api_keys SET name = ? WHERE id = ?`,
			[newName, id],
		);
		return changes > 0;
	}

	/**
	 * Replace the stored secret for an API key, preserving every other column
	 * (name, created_at, usage_count, last_used, is_active).
	 *
	 * `expectedHashedKey` is an optimistic-concurrency guard: the row is only
	 * rewritten if its current hash still matches. Returns false on a miss so
	 * the caller can report a 409 instead of returning a silently-invalid
	 * plaintext to a racing client.
	 *
	 * The `is_active = 1` predicate is defense in depth: callers already check
	 * isActive in app code, but a key can be disabled between that check and
	 * this write (TOCTOU). Refusing to rotate a disabled row keeps the SQL
	 * write consistent with the stated precondition.
	 */
	async rotateSecret(
		id: string,
		expectedHashedKey: string,
		newHashedKey: string,
		newPrefixLast8: string,
	): Promise<boolean> {
		const changes = await this.runWithChanges(
			`
			UPDATE api_keys
			SET hashed_key = ?,
				prefix_last_8 = ?
			WHERE id = ? AND hashed_key = ? AND is_active = 1
		`,
			[newHashedKey, newPrefixLast8, id, expectedHashedKey],
		);

		return changes > 0;
	}

	/**
	 * Permanently delete an API key
	 */
	async delete(id: string): Promise<boolean> {
		const changes = await this.runWithChanges(
			`
			DELETE FROM api_keys
			WHERE id = ?
		`,
			[id],
		);

		return changes > 0;
	}

	/**
	 * Count the number of active API keys
	 */
	async countActive(): Promise<number> {
		const row = await this.get<{ count: number }>(`
			SELECT COUNT(*) as count
			FROM api_keys
			WHERE is_active = 1
		`);

		return row?.count || 0;
	}

	/**
	 * Count the total number of API keys (active and inactive)
	 */
	async countAll(): Promise<number> {
		const row = await this.get<{ count: number }>(`
			SELECT COUNT(*) as count
			FROM api_keys
		`);

		return row?.count || 0;
	}

	/**
	 * Clear all API keys (for testing purposes)
	 */
	async clearAll(): Promise<void> {
		await this.run("DELETE FROM api_keys");
	}
}
