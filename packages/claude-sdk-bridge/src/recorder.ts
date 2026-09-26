import type {
	SdkBridgeLegFinish,
	SdkBridgeLegKind,
	SdkBridgeTurnCounterDelta,
	SdkBridgeTurnFinish,
	SdkBridgeTurnInsert,
} from "@clankermux/types";
import type { BridgeLog, SdkBridgeTurnRepo } from "./types";
import { processStartTime } from "./work-dirs";

/** This process, as turn rows name their owner. */
const OWNER = { pid: process.pid, startTime: processStartTime(process.pid) };

/**
 * Turn and leg rows. Writes are chained per turn so a finish never overtakes
 * its insert, and a failed write is logged, never thrown: accounting must not
 * break a reply that is already streaming.
 */
export class TurnRecorder {
	private chain: Promise<void> = Promise.resolve();
	private readonly finishedLegs = new Set<string>();
	private turnFinished = false;

	constructor(
		private readonly repo: SdkBridgeTurnRepo,
		private readonly log: BridgeLog,
		readonly turnId: string,
		/**
		 * The park lease token, for a turn a released park owns: every write,
		 * queued ones included, applies only while it holds the lease.
		 */
		private fence?: string,
	) {}

	/**
	 * Fence this turn's writes from now on: the turn is becoming a park's.
	 * Each write reads the token when it runs, so writes already queued are
	 * fenced too.
	 */
	setFence(token: string): void {
		this.fence = token;
	}

	private enqueue(what: string, write: () => Promise<void>): Promise<void> {
		this.chain = this.chain.then(write).catch((error) => {
			this.log.warn(`SDK bridge turn ${this.turnId}: ${what} failed`, error);
		});
		return this.chain;
	}

	/** The row names this process as the turn's owner (pid and start time). */
	insertTurn(turn: Omit<SdkBridgeTurnInsert, "id">): Promise<void> {
		return this.enqueue("insertTurn", () =>
			this.repo.insertTurn({
				...turn,
				id: this.turnId,
				ownerPid: OWNER.pid,
				ownerStartTime: OWNER.startTime,
			}),
		);
	}

	insertLeg(
		id: string,
		kind: SdkBridgeLegKind,
		startedAt: number,
	): Promise<void> {
		return this.enqueue("insertLeg", () =>
			this.repo.insertLeg(
				{ id, turnId: this.turnId, kind, startedAt },
				this.fence,
			),
		);
	}

	/** Each leg is finished exactly once, whichever exit path gets there first. */
	finishLeg(id: string, finish: SdkBridgeLegFinish): Promise<void> {
		if (this.finishedLegs.has(id)) return this.chain;
		this.finishedLegs.add(id);
		return this.enqueue("finishLeg", () =>
			this.repo.finishLeg(id, finish, this.fence),
		);
	}

	finishTurn(finish: SdkBridgeTurnFinish): Promise<void> {
		if (this.turnFinished) return this.chain;
		this.turnFinished = true;
		return this.enqueue("finishTurn", () =>
			this.repo.finishTurn(this.turnId, finish, this.fence),
		);
	}

	bump(delta: SdkBridgeTurnCounterDelta): Promise<void> {
		return this.enqueue("bumpTurnCounters", () =>
			this.repo.bumpTurnCounters(this.turnId, delta, this.fence),
		);
	}

	/** Resolves once every write queued so far has landed (or failed). */
	flushed(): Promise<void> {
		return this.chain;
	}
}
