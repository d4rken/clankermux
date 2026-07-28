import type { DatabaseOperations } from "@clankermux/database";

/**
 * Remove an account by its PRIMARY KEY.
 *
 * Deliberately id-only, with no name fallback: `DELETE /api/accounts/:id` is the
 * documented contract, and a name-keyed delete would remove the wrong row (or
 * several) whenever two accounts share a name.
 */
export async function removeAccountById(
	dbOps: DatabaseOperations,
	id: string,
	/** Display name, used only for the human-readable message. */
	name?: string,
): Promise<{ success: boolean; message: string }> {
	const adapter = dbOps.getAdapter();
	const changes = await adapter.runWithChanges(
		"DELETE FROM accounts WHERE id = ?",
		[id],
	);

	const label = name ?? id;
	if (changes === 0) {
		return {
			success: false,
			message: `Account '${label}' not found`,
		};
	}

	return {
		success: true,
		message: `Account '${label}' removed successfully`,
	};
}

/**
 * Toggle account pause state (shared logic for pause/resume)
 */
async function toggleAccountPause(
	dbOps: DatabaseOperations,
	name: string,
	shouldPause: boolean,
): Promise<{ success: boolean; message: string }> {
	const adapter = dbOps.getAdapter();

	// Get account ID by name
	const account = await adapter.get<{ id: string; paused: number }>(
		"SELECT id, COALESCE(paused, 0) as paused FROM accounts WHERE name = ?",
		[name],
	);

	if (!account) {
		return {
			success: false,
			message: `Account '${name}' not found`,
		};
	}

	const isPaused = account.paused === 1;
	const actionPast = shouldPause ? "paused" : "resumed";

	if (isPaused === shouldPause) {
		return {
			success: false,
			message: `Account '${name}' is already ${actionPast}`,
		};
	}

	if (shouldPause) {
		await dbOps.pauseAccount(account.id);
	} else {
		await dbOps.resumeAccount(account.id);
	}

	return {
		success: true,
		message: `Account '${name}' ${actionPast} successfully`,
	};
}

/**
 * Pause an account by name
 */
export async function pauseAccount(
	dbOps: DatabaseOperations,
	name: string,
): Promise<{ success: boolean; message: string }> {
	return toggleAccountPause(dbOps, name, true);
}

/**
 * Resume a paused account by name
 */
export async function resumeAccount(
	dbOps: DatabaseOperations,
	name: string,
): Promise<{ success: boolean; message: string }> {
	return toggleAccountPause(dbOps, name, false);
}
