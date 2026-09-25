import type { ProxyContext } from "./handlers/proxy-types";

// Unlike Anthropic's usageHeaderEpoch, this fence does not require a poller.
// Only a redemption that restored windows advances it; ordinary observations
// keep their existing ordering rules. Capture before issuing each attempt.
const epochs = new Map<string, number>();

export function getCodexObservationEpoch(accountId: string): number {
	return epochs.get(accountId) ?? 0;
}

export function invalidateCodexObservations(accountId: string): void {
	epochs.set(accountId, getCodexObservationEpoch(accountId) + 1);
}

export function isCodexObservationCurrent(
	accountId: string,
	epoch: number,
): boolean {
	return getCodexObservationEpoch(accountId) === epoch;
}

/** Fence queued quota writes too: observing before the reset does not mean the
 * async writer will flush before it. Request accounting uses the original ctx. */
export function fenceCodexObservationWrites<
	T extends Pick<ProxyContext, "asyncWriter" | "dbOps">,
>(ctx: T, accountId: string, epoch: number): T {
	const asyncWriter = Object.create(
		ctx.asyncWriter,
	) as ProxyContext["asyncWriter"];
	asyncWriter.enqueue = (job) =>
		ctx.asyncWriter.enqueue(() => {
			if (isCodexObservationCurrent(accountId, epoch)) return job();
		});
	return { ...ctx, asyncWriter };
}
