/**
 * One caller's turn: `sent()` just before each request goes out, `release()`
 * when done, sent or not. Only `release()` frees the gate; it is idempotent.
 */
export interface ReadTurn {
	sent(): void;
	release(): void;
}

export interface ReadGate {
	/** Rejects with {@link ReadGateStoppedError} once the gate is stopped. */
	acquire(accountId: string, options?: { urgent?: boolean }): Promise<ReadTurn>;
	stop(): void;
}

export class ReadGateStoppedError extends Error {
	constructor() {
		super("Read gate stopped");
		this.name = "ReadGateStoppedError";
	}
}

interface SpacedReadGateOptions {
	spacingMs: number;
	/** Fraction of `spacingMs` added to each gap; defaults to 0..0.5. */
	jitter?: () => number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

interface Waiter {
	accountId: string;
	urgent: boolean;
	resolve: (turn: ReadTurn) => void;
	reject: (error: Error) => void;
}

/**
 * Hands out one turn at a time and keeps requests for different accounts at
 * least `spacingMs` apart, measured from the last `sent()`. A request for the
 * account sent last goes at once, a turn released unsent leaves the timeline
 * alone, and urgent callers go ahead of the others.
 */
export class SpacedReadGate implements ReadGate {
	private readonly spacingMs: number;
	private readonly jitter: () => number;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly waiters: Waiter[] = [];
	private last: { accountId: string; at: number } | null = null;
	private busy = false;
	private stopped = false;

	constructor(options: SpacedReadGateOptions) {
		this.spacingMs = options.spacingMs;
		this.jitter = options.jitter ?? (() => Math.random() * 0.5);
		this.now = options.now ?? Date.now;
		this.sleep =
			options.sleep ??
			((ms) =>
				new Promise<void>((resolve) => {
					setTimeout(resolve, ms).unref?.();
				}));
	}

	acquire(
		accountId: string,
		options: { urgent?: boolean } = {},
	): Promise<ReadTurn> {
		if (this.stopped) return Promise.reject(new ReadGateStoppedError());
		return new Promise<ReadTurn>((resolve, reject) => {
			const waiter = {
				accountId,
				urgent: options.urgent === true,
				resolve,
				reject,
			};
			const firstNormal = waiter.urgent
				? this.waiters.findIndex((w) => !w.urgent)
				: -1;
			if (firstNormal === -1) this.waiters.push(waiter);
			else this.waiters.splice(firstNormal, 0, waiter);
			void this.next();
		});
	}

	stop(): void {
		this.stopped = true;
		for (const waiter of this.waiters.splice(0))
			waiter.reject(new ReadGateStoppedError());
	}

	private async next(): Promise<void> {
		if (this.busy) return;
		const waiter = this.waiters.shift();
		if (!waiter) return;
		this.busy = true;
		try {
			const last = this.last;
			if (last && last.accountId !== waiter.accountId) {
				const gap = this.spacingMs * (1 + this.jitter());
				// Capped at one gap, so a clock stepped backwards cannot stall the queue.
				const wait = Math.min(last.at + gap - this.now(), gap);
				if (wait > 0) await this.sleep(wait);
			}
			if (this.stopped) throw new ReadGateStoppedError();
		} catch (error) {
			waiter.reject(error instanceof Error ? error : new Error(String(error)));
			this.busy = false;
			void this.next();
			return;
		}
		let released = false;
		waiter.resolve({
			sent: () => {
				if (!released)
					this.last = { accountId: waiter.accountId, at: this.now() };
			},
			release: () => {
				if (released) return;
				released = true;
				this.busy = false;
				void this.next();
			},
		});
	}
}
