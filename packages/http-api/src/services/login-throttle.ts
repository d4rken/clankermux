/**
 * Load control for the login endpoint.
 *
 * `POST /api/auth/login` is unauthenticated and each attempt costs a scrypt
 * derivation. That cost lands on the SERVER, not the attacker: enough parallel
 * logins saturate Bun's crypto threadpool and degrade proxy traffic sharing the
 * process. Two independent limiters, because they answer different questions:
 *
 *  - the semaphore bounds how many derivations run AT ONCE (peak CPU),
 *  - the token bucket bounds how many run OVER TIME (sustained CPU).
 *
 * Deliberately NO account lockout. On a single-user box a lockout is a
 * self-DoS: anyone who can reach the port can lock the operator out of their
 * own dashboard by guessing wrong a few times. Do not add one.
 */

/** Concurrent password derivations. Above this, callers are refused, not queued. */
export const LOGIN_MAX_CONCURRENT = 2;

/** Burst of attempts admitted before the refill rate binds. */
export const LOGIN_BUCKET_CAPACITY = 10;

/** Sustained rate once the burst is spent: one attempt per this interval. */
export const LOGIN_BUCKET_REFILL_INTERVAL_MS = 5_000;

/** Largest JSON body the login endpoint reads before giving up. */
export const LOGIN_MAX_BODY_BYTES = 4_096;

/** Why an attempt was refused, and how long the caller should wait. */
export interface LoginThrottleRejection {
	reason: "rate_limited" | "busy";
	retryAfterSeconds: number;
}

/**
 * A token bucket plus a concurrency semaphore, both process-wide.
 *
 * Not per-IP: the deployment sits behind a reverse proxy on a LAN, so a
 * client-supplied address is not a trust boundary, and the resource being
 * protected (this process's CPU) is global anyway.
 */
export class LoginThrottle {
	private tokens: number;
	private lastRefillAt: number;
	private inFlight = 0;

	constructor(
		private readonly capacity = LOGIN_BUCKET_CAPACITY,
		private readonly refillIntervalMs = LOGIN_BUCKET_REFILL_INTERVAL_MS,
		private readonly maxConcurrent = LOGIN_MAX_CONCURRENT,
		private readonly now: () => number = Date.now,
	) {
		this.tokens = capacity;
		this.lastRefillAt = now();
	}

	private refill(): void {
		const at = this.now();
		const elapsed = at - this.lastRefillAt;
		if (elapsed < this.refillIntervalMs) return;
		const earned = Math.floor(elapsed / this.refillIntervalMs);
		this.tokens = Math.min(this.capacity, this.tokens + earned);
		// Advance by whole intervals only, so the fraction that has not yet
		// earned a token is not silently discarded on every call.
		this.lastRefillAt += earned * this.refillIntervalMs;
	}

	/**
	 * Claim the right to run one derivation. Returns a `release` on success and
	 * a rejection otherwise; the caller MUST release in a `finally`.
	 */
	tryAcquire():
		| { ok: true; release: () => void }
		| { ok: false; rejection: LoginThrottleRejection } {
		this.refill();
		if (this.tokens < 1) {
			return {
				ok: false,
				rejection: {
					reason: "rate_limited",
					retryAfterSeconds: Math.max(
						1,
						Math.ceil(
							(this.refillIntervalMs - (this.now() - this.lastRefillAt)) / 1000,
						),
					),
				},
			};
		}
		if (this.inFlight >= this.maxConcurrent) {
			// Not a token spend: the attempt never ran, so charging it would let a
			// burst of concurrent callers exhaust the bucket for a legitimate one.
			return {
				ok: false,
				rejection: { reason: "busy", retryAfterSeconds: 1 },
			};
		}
		this.tokens -= 1;
		this.inFlight += 1;
		let released = false;
		return {
			ok: true,
			release: () => {
				if (released) return;
				released = true;
				this.inFlight -= 1;
			},
		};
	}
}
