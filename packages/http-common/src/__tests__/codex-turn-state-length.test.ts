/**
 * `x-codex-turn-state` is an opaque continuity token. Only its LENGTH is ever
 * recorded — the value itself is a per-turn credential and is stripped from
 * every archive by `sanitizeRequestHeaders`.
 */

import { describe, expect, it } from "bun:test";
import { CODEX_TURN_STATE_HEADER, codexTurnStateLength } from "../headers";

describe("codexTurnStateLength", () => {
	it("returns the character count of the header value", () => {
		const headers = new Headers({ [CODEX_TURN_STATE_HEADER]: "a".repeat(292) });
		expect(codexTurnStateLength(headers)).toBe(292);
	});

	it("returns null when the header is absent", () => {
		expect(codexTurnStateLength(new Headers())).toBeNull();
	});

	it("returns 0, not null, for a present-but-empty header", () => {
		// "sent an empty token" and "sent no token" are different observations;
		// collapsing them would hide a client that stopped populating the field.
		const headers = new Headers({ [CODEX_TURN_STATE_HEADER]: "" });
		expect(codexTurnStateLength(headers)).toBe(0);
	});

	it("keeps the constant and the storage strip entry on one spelling", () => {
		expect(CODEX_TURN_STATE_HEADER).toBe("x-codex-turn-state");
	});
});
