import type { RuntimeConfig } from "@clankermux/config";
import { registerDisposable, unregisterDisposable } from "@clankermux/core";
import {
	type DatabaseConfig,
	DatabaseOperations,
	type DatabaseRetryConfig,
} from "./database-operations";

let instance: DatabaseOperations | null = null;
let dbPath: string | undefined;
let runtimeConfig: RuntimeConfig | undefined;

/**
 * The `fastMode` parameter is retained for backward compatibility with
 * callers (CLI commands, tests) that still pass it. It is now a no-op:
 * startup no longer runs `PRAGMA integrity_check`, so there's nothing
 * left to skip. Integrity is verified by the background scheduler — see
 * `packages/proxy/src/integrity-scheduler.ts`.
 */
export function initialize(
	dbPathParam?: string,
	runtimeConfigParam?: RuntimeConfig,
	_fastMode = false,
): void {
	dbPath = dbPathParam;
	runtimeConfig = runtimeConfigParam;
}

export function getInstance(_fastMode?: boolean): DatabaseOperations {
	if (!instance) {
		// Extract database configuration from runtime config
		const dbConfig: DatabaseConfig | undefined = runtimeConfig?.database
			? {
					...(runtimeConfig.database.walMode !== undefined && {
						walMode: runtimeConfig.database.walMode,
					}),
					...(runtimeConfig.database.busyTimeoutMs !== undefined && {
						busyTimeoutMs: runtimeConfig.database.busyTimeoutMs,
					}),
					...(runtimeConfig.database.cacheSize !== undefined && {
						cacheSize: runtimeConfig.database.cacheSize,
					}),
					...(runtimeConfig.database.synchronous !== undefined && {
						synchronous: runtimeConfig.database.synchronous,
					}),
					...(runtimeConfig.database.mmapSize !== undefined && {
						mmapSize: runtimeConfig.database.mmapSize,
					}),
					...(runtimeConfig.database.pageSize !== undefined && {
						pageSize: runtimeConfig.database.pageSize,
					}),
				}
			: undefined;

		const retryConfig: DatabaseRetryConfig | undefined =
			runtimeConfig?.database?.retry;

		instance = new DatabaseOperations(dbPath, dbConfig, retryConfig);
		if (runtimeConfig) {
			instance.setRuntimeConfig(runtimeConfig);
		}
		// Register with lifecycle manager
		registerDisposable(instance);
	}
	return instance;
}

/**
 * Get or create the database instance. Retained as an async wrapper around
 * `getInstance()` so existing `await DatabaseFactory.getInstanceAsync()` call
 * sites (e.g. server startup) keep working; there is no async setup left.
 */
export async function getInstanceAsync(
	_fastMode?: boolean,
): Promise<DatabaseOperations> {
	return getInstance();
}

export function closeAll(): void {
	if (instance) {
		unregisterDisposable(instance);
		// Fire-and-forget close (sync-compatible)
		void instance.close();
		instance = null;
	}
}

export function reset(): void {
	closeAll();
}

export const DatabaseFactory = {
	initialize,
	getInstance,
	getInstanceAsync,
	closeAll,
	reset,
};
