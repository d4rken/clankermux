import { Logger } from "@clankermux/logger";
import type { DatabaseRetryConfig } from "./database-operations";

const logger = new Logger("db-retry");

/**
 * Error codes that indicate database lock contention or transient errors and should trigger retries
 */
const RETRYABLE_SQLITE_ERRORS = [
	"SQLITE_BUSY",
	"SQLITE_LOCKED",
	"database is locked",
	"database table is locked",
];

/**
 * Check if an error is retryable (indicates database lock contention)
 */
function isRetryableError(error: unknown): boolean {
	if (!error) return false;

	const errorMessage = error instanceof Error ? error.message : String(error);
	const errorCode =
		typeof error === "object" && error !== null && "code" in error
			? error.code
			: undefined;

	return RETRYABLE_SQLITE_ERRORS.some(
		(retryableError) =>
			errorMessage.includes(retryableError) || errorCode === retryableError,
	);
}

/**
 * Calculate delay for exponential backoff with jitter
 */
function calculateDelay(
	attempt: number,
	config: Required<DatabaseRetryConfig>,
): number {
	const baseDelay = config.delayMs * config.backoff ** attempt;
	const jitter = Math.random() * 0.1 * baseDelay; // Add 10% jitter
	const delayWithJitter = baseDelay + jitter;

	return Math.min(delayWithJitter, config.maxDelayMs);
}

/**
 * Sleep for the specified number of milliseconds
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Async retry logic - uses iterative approach to avoid recursive Promise chains
 */
async function executeWithRetryAsync<T>(
	operation: () => T | Promise<T>,
	config: Required<DatabaseRetryConfig>,
	operationName: string,
): Promise<T> {
	let lastError: unknown;

	for (let attempt = 0; attempt < config.attempts; attempt++) {
		try {
			const result = await operation();

			// Log successful retry if this wasn't the first attempt
			if (attempt > 0) {
				logger.info(`${operationName} succeeded after ${attempt + 1} attempts`);
			}

			return result;
		} catch (error) {
			lastError = error;

			// Check if this is a retryable error
			if (!isRetryableError(error)) {
				logger.debug(
					`${operationName} failed with non-retryable error:`,
					error,
				);
				throw error;
			}

			// If this was the last attempt, throw the error
			if (attempt === config.attempts - 1) {
				logger.error(
					`${operationName} failed after ${config.attempts} attempts:`,
					error,
				);
				throw error;
			}

			// Calculate delay and wait before retry
			const delay = calculateDelay(attempt, config);
			logger.warn(
				`${operationName} failed (attempt ${attempt + 1}/${config.attempts}), retrying in ${delay.toFixed(0)}ms:`,
				error instanceof Error ? error.message : String(error),
			);

			await sleep(delay);
		}
	}

	// This should never be reached, but TypeScript requires it
	throw lastError;
}

/**
 * Retry wrapper for database operations with exponential backoff
 */
export async function withDatabaseRetry<T>(
	operation: () => T | Promise<T>,
	config: DatabaseRetryConfig = {},
	operationName = "database operation",
): Promise<T> {
	const retryConfig: Required<DatabaseRetryConfig> = {
		attempts: 3,
		delayMs: 100,
		backoff: 2,
		maxDelayMs: 5000,
		...config,
	};

	return executeWithRetryAsync(operation, retryConfig, operationName);
}

/**
 * Wrap a repository so that every method call made *through the returned
 * object* runs inside {@link withDatabaseRetry}.
 *
 * This exists so retry is a property of the repository rather than something
 * each delegating method on `DatabaseOperations` has to remember to opt into.
 * Before this, a new repository method reached callers unprotected until
 * someone hand-wrote the `withDatabaseRetry(...)` wrapper around it, and a
 * `SQLITE_BUSY` under write contention surfaced as a hard failure.
 *
 * Two details make this safe:
 *
 * - Methods are invoked with `this` bound to the **raw** target, not the proxy.
 *   A repository method that calls a sibling (or the `BaseRepository.query`
 *   helpers) therefore stays inside the single retry envelope opened by the
 *   outbound call, instead of opening a nested one per internal statement.
 * - `getConfig` is a thunk, read once per call. `DatabaseOperations.
 *   setRuntimeConfig()` replaces `retryConfig` after construction, so capturing
 *   the object here would pin every repository to the pre-runtime defaults.
 *
 * Every repository method is `async`, so wrapping cannot change a synchronous
 * return into a promise.
 *
 * CONTRACT FOR REPOSITORY METHODS: a method must be safe to re-run in full.
 * Retry replays the whole method, not the individual statement that failed, so
 * a method that issues several writes can re-apply earlier ones. The dangerous
 * shape is generating an id inside the method and then reading the row back in
 * a second statement — a retryable failure on the read re-runs the insert under
 * a fresh id and leaves a duplicate. Use a single `INSERT ... RETURNING`
 * instead (see `ComboRepository.create`). Absolute-value `UPDATE`s and
 * single-statement methods are already safe.
 */
export function withRetryingMethods<T extends object>(
	target: T,
	getConfig: () => DatabaseRetryConfig,
	label: string,
): T {
	// Wrapped functions are memoized so repeated property access returns a
	// stable identity (`repo.foo === repo.foo`), which spies and equality
	// checks in tests rely on. The underlying function is stored alongside so a
	// method replaced after its first read (a spy, a stub) is re-wrapped instead
	// of being shadowed by a wrapper still bound to the original.
	const wrapped = new Map<PropertyKey, { fn: unknown; retrying: unknown }>();

	return new Proxy(target, {
		get(obj, prop) {
			const value = Reflect.get(obj, prop) as unknown;
			if (typeof value !== "function") return value;

			// Only repository methods get an envelope. Object.prototype members
			// (`toString`, `valueOf`, `constructor`, …) are returned untouched:
			// wrapping them would make `String(repo)` a promise and break
			// `repo.constructor`. Symbol-keyed members are protocol hooks
			// (Symbol.iterator, Symbol.toPrimitive) and are left alone too.
			if (typeof prop === "symbol" || prop in Object.prototype) return value;

			const memoized = wrapped.get(prop);
			if (memoized && memoized.fn === value) return memoized.retrying;

			const fn = value as (...args: unknown[]) => unknown;
			const retrying = (...args: unknown[]) =>
				withDatabaseRetry(
					() => fn.apply(obj, args),
					getConfig(),
					`${label}.${String(prop)}`,
				);

			wrapped.set(prop, { fn: value, retrying });
			return retrying;
		},
	});
}
