import type {
	SdkBridgeLegFinish,
	SdkBridgeLegKind,
	SdkBridgeTurnCounterDelta,
	SdkBridgeTurnFinish,
	SdkBridgeTurnInsert,
} from "@clankermux/types";
import type { BridgeLog, SdkBridgeTurnRepo } from "./types";

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
	) {}

	private enqueue(what: string, write: () => Promise<void>): Promise<void> {
		this.chain = this.chain.then(write).catch((error) => {
			this.log.warn(`SDK bridge turn ${this.turnId}: ${what} failed`, error);
		});
		return this.chain;
	}

	insertTurn(turn: Omit<SdkBridgeTurnInsert, "id">): Promise<void> {
		return this.enqueue("insertTurn", () =>
			this.repo.insertTurn({ ...turn, id: this.turnId }),
		);
	}

	insertLeg(
		id: string,
		kind: SdkBridgeLegKind,
		startedAt: number,
	): Promise<void> {
		return this.enqueue("insertLeg", () =>
			this.repo.insertLeg({ id, turnId: this.turnId, kind, startedAt }),
		);
	}

	/** Each leg is finished exactly once, whichever exit path gets there first. */
	finishLeg(id: string, finish: SdkBridgeLegFinish): Promise<void> {
		if (this.finishedLegs.has(id)) return this.chain;
		this.finishedLegs.add(id);
		return this.enqueue("finishLeg", () => this.repo.finishLeg(id, finish));
	}

	finishTurn(finish: SdkBridgeTurnFinish): Promise<void> {
		if (this.turnFinished) return this.chain;
		this.turnFinished = true;
		return this.enqueue("finishTurn", () =>
			this.repo.finishTurn(this.turnId, finish),
		);
	}

	bump(delta: SdkBridgeTurnCounterDelta): Promise<void> {
		return this.enqueue("bumpTurnCounters", () =>
			this.repo.bumpTurnCounters(this.turnId, delta),
		);
	}

	/** Resolves once every write queued so far has landed (or failed). */
	flushed(): Promise<void> {
		return this.chain;
	}
}
