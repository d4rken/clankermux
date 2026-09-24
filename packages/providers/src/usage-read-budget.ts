/**
 * Minimum gap between two Anthropic `/api/oauth/usage` reads of one account,
 * whichever caller sends them: the usage poll, an on-demand refresh, or the
 * banked-reset status read (the same endpoint with `cedar_ember=1`).
 */
export const ANTHROPIC_USAGE_READ_MIN_GAP_MS = 150_000;

/**
 * One caller's right to send a read. `commit()` just before the request goes
 * out starts the account's next gap; `cancel()` gives the slot back unused.
 * Only the first of the two counts.
 */
export interface UsageReadSlot {
	commit(): void;
	cancel(): void;
}

export type UsageReadGrant = { slot: UsageReadSlot } | { waitMs: number };

interface AccountState {
	lastReadAt: number | null;
	/** A slot is out and not yet committed or cancelled. */
	held: boolean;
}

interface UsageReadBudgetOptions {
	gapMs: number;
	now?: () => number;
	/** Called with the send time of every read, admitted or recorded. */
	onRead?: (accountId: string, at: number) => void;
}

/**
 * Per-account admission for reads of one rate-limited endpoint. Deferrable
 * callers ask {@link tryAcquire} and get the time to wait instead of a slot.
 * A caller that must not wait sends at once and reports it through
 * {@link recordRead}, which pushes everyone else's next read back a full gap.
 */
export class UsageReadBudget {
	private readonly gapMs: number;
	private readonly now: () => number;
	private readonly onRead?: (accountId: string, at: number) => void;
	private readonly accounts = new Map<string, AccountState>();

	constructor(options: UsageReadBudgetOptions) {
		this.gapMs = options.gapMs;
		this.now = options.now ?? Date.now;
		this.onRead = options.onRead;
	}

	tryAcquire(accountId: string): UsageReadGrant {
		const state = this.state(accountId);
		if (state.held) return { waitMs: this.gapMs };
		const waitMs = this.waitFor(state);
		if (waitMs > 0) return { waitMs };
		state.held = true;
		let done = false;
		return {
			slot: {
				commit: () => {
					if (done) return;
					done = true;
					state.held = false;
					this.markRead(accountId, state);
				},
				cancel: () => {
					if (done) return;
					done = true;
					state.held = false;
				},
			},
		};
	}

	/** A read sent without admission, just now. */
	recordRead(accountId: string): void {
		this.markRead(accountId, this.state(accountId));
	}

	/**
	 * Start the gap from a read sent before this process; a later one wins, and
	 * one stamped in the future counts as sent now.
	 */
	seed(accountId: string, lastReadAt: number): void {
		const at = Math.min(lastReadAt, this.now());
		const state = this.state(accountId);
		if (state.lastReadAt === null || at > state.lastReadAt)
			state.lastReadAt = at;
	}

	/** How long until the account's next admitted read; 0 when one may go now. */
	waitMs(accountId: string): number {
		const state = this.accounts.get(accountId);
		if (!state) return 0;
		return state.held ? this.gapMs : this.waitFor(state);
	}

	lastReadAt(accountId: string): number | null {
		return this.accounts.get(accountId)?.lastReadAt ?? null;
	}

	clear(): void {
		this.accounts.clear();
	}

	private state(accountId: string): AccountState {
		let state = this.accounts.get(accountId);
		if (!state) {
			state = { lastReadAt: null, held: false };
			this.accounts.set(accountId, state);
		}
		return state;
	}

	private markRead(accountId: string, state: AccountState): void {
		const at = this.now();
		state.lastReadAt = at;
		this.onRead?.(accountId, at);
	}

	private waitFor(state: AccountState): number {
		if (state.lastReadAt === null) return 0;
		const now = this.now();
		// A read stamped after now (the clock stepped backwards) is re-stamped as
		// sent now, so reads resume one gap later instead of when the clock
		// catches up.
		if (state.lastReadAt > now) state.lastReadAt = now;
		return Math.max(0, state.lastReadAt + this.gapMs - now);
	}
}
