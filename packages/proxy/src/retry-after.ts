/**
 * Shared `Retry-After` arithmetic for the proxy's synthesized terminals.
 *
 * Two different meanings share the header. Below the ceiling it is a deadline:
 * the moment the blocker behind the refusal is known to lift, ceiled so a
 * compliant client never wakes before it. Above the ceiling it is a re-check
 * interval instead — an exhausted weekly window resets days out, and handing a
 * client that figure parks it long past the point where another account, a
 * gift reset or an operator unpause has already restored capacity.
 *
 * The real deadline does not disappear when it is clamped; it moves into the
 * error body, where a client reads it as information rather than as an
 * instruction to sleep.
 */

/**
 * Longest deadline still advertised verbatim. Anything further out is replaced
 * by a jittered re-check interval.
 */
export const RETRY_AFTER_RECHECK_CEILING_SECONDS = 60;

/** Inclusive bounds of the jittered re-check interval. */
const RECHECK_MIN_SECONDS = 45;
const RECHECK_MAX_SECONDS = 55;

/**
 * Advice for a refusal whose blocker carries no date at all. Matches the
 * long-standing pool-exhausted / family-weekly fallback.
 */
export const DEFAULT_RECHECK_RETRY_AFTER_SECONDS = 60;

/** Whole seconds until `deadlineMs`, never early and never below 1. */
export function ceilRetryAfterSeconds(deadlineMs: number, now: number): number {
	return Math.max(1, Math.ceil((deadlineMs - now) / 1000));
}

/**
 * Jitter is spread across clients so a clamped fleet does not re-check in
 * lockstep, and is only ever applied ABOVE the ceiling: an honest deadline
 * inside the ceiling is returned untouched, so the clamp can never advise a
 * client to retry earlier than the deadline it would otherwise have been given.
 */
export function clampRetryAfterSeconds(honestSeconds: number): number {
	if (honestSeconds <= RETRY_AFTER_RECHECK_CEILING_SECONDS) {
		return honestSeconds;
	}
	const span = RECHECK_MAX_SECONDS - RECHECK_MIN_SECONDS;
	return RECHECK_MIN_SECONDS + Math.floor(Math.random() * (span + 1));
}

/**
 * Clamped advice derived from the earliest dated blocker among `deadlinesMs`
 * (null/undefined/past entries are undated), falling back to the default
 * re-check interval when nothing in the set carries a date.
 */
export function retryAfterFromDeadlines(
	deadlinesMs: Iterable<number | null | undefined>,
	now: number,
): number {
	let earliest: number | null = null;
	for (const deadline of deadlinesMs) {
		if (deadline == null || !Number.isFinite(deadline) || deadline <= now) {
			continue;
		}
		if (earliest === null || deadline < earliest) earliest = deadline;
	}
	return earliest === null
		? DEFAULT_RECHECK_RETRY_AFTER_SECONDS
		: clampRetryAfterSeconds(ceilRetryAfterSeconds(earliest, now));
}
