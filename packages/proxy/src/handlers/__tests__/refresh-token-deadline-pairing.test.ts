/**
 * Tests for `refreshTokenDeadlineFor` — the rule that decides WHICH deadline a
 * persist attaches to the refresh token it is about to install.
 *
 * Both refresh paths choose that token from up to three sources (this refresh's
 * result, a pending rotation, the row's own token). Picking the deadline by
 * source instead of by token identity is wrong whenever two sources name the
 * same token and only one carries its deadline: the write then asserts "no
 * deadline" and the repository clears a date we knew. The pending-rotation
 * registry makes that reachable, because an entry survives precisely when its
 * own DB write failed, and a later refresh can hand back the same token.
 */
import { describe, expect, it } from "bun:test";
import {
	type PendingRotation,
	refreshTokenDeadlineFor,
} from "../pending-rotation-registry";

const DEADLINE = 1_800_000_000_000;
const OTHER_DEADLINE = 1_900_000_000_000;

function pending(overrides: Partial<PendingRotation> = {}): PendingRotation {
	return {
		accessToken: "at-pending",
		expiresAt: 1_000,
		refreshToken: "rt-pending",
		refreshTokenExpiresAt: DEADLINE,
		identity: null,
		attemptedRefreshToken: "rt-anchor",
		recordedAt: 0,
		...overrides,
	};
}

describe("refreshTokenDeadlineFor", () => {
	it("takes the result's deadline when the result minted the token", () => {
		expect(
			refreshTokenDeadlineFor(
				"rt-new",
				{ refreshToken: "rt-new", refreshTokenExpiresAt: OTHER_DEADLINE },
				undefined,
			),
		).toBe(OTHER_DEADLINE);
	});

	it("falls back to the pending entry when the result minted no token", () => {
		// The refresh produced nothing, so the token being written is the pending
		// rotation's — and so is its deadline.
		expect(
			refreshTokenDeadlineFor(
				"rt-pending",
				{ refreshToken: null, refreshTokenExpiresAt: null },
				pending(),
			),
		).toBe(DEADLINE);
	});

	it("keeps the pending deadline when the result echoes the pending token without one", () => {
		// The regression this helper exists for. Our own flush had already landed
		// "rt-pending", so this refresh read it back and returned it unchanged with
		// no deadline of its own. Sourcing by position would assert null and clear
		// a date sitting in the registry.
		expect(
			refreshTokenDeadlineFor(
				"rt-pending",
				{ refreshToken: "rt-pending", refreshTokenExpiresAt: null },
				pending(),
			),
		).toBe(DEADLINE);
	});

	it("prefers the result's own deadline over the pending one for the same token", () => {
		// Both describe the same credential; the fresher report wins.
		expect(
			refreshTokenDeadlineFor(
				"rt-pending",
				{ refreshToken: "rt-pending", refreshTokenExpiresAt: OTHER_DEADLINE },
				pending(),
			),
		).toBe(OTHER_DEADLINE);
	});

	it("reports unknown for a genuinely different token", () => {
		// Neither source describes "rt-row" (the proactive path's third fallback),
		// so nothing may be asserted. The repository then keeps the stored date
		// because the token did not actually change.
		expect(
			refreshTokenDeadlineFor(
				"rt-row",
				{ refreshToken: null, refreshTokenExpiresAt: null },
				pending(),
			),
		).toBeNull();
	});

	it("never borrows a deadline across a rotation", () => {
		// A new token with no reported deadline must NOT inherit the previous
		// token's date — that credential is dead upstream.
		expect(
			refreshTokenDeadlineFor(
				"rt-new",
				{ refreshToken: "rt-new", refreshTokenExpiresAt: null },
				pending(),
			),
		).toBeNull();
	});

	it("reports unknown when no token is being written at all", () => {
		// The access-token-only persist path, which never touches the column.
		expect(
			refreshTokenDeadlineFor(
				undefined,
				{ refreshToken: null, refreshTokenExpiresAt: null },
				pending(),
			),
		).toBeNull();
	});

	it("does not match a pending entry that carries no token", () => {
		// An entry holding only an anchor describes no credential of its own.
		expect(
			refreshTokenDeadlineFor(
				"rt-row",
				{ refreshToken: null, refreshTokenExpiresAt: null },
				pending({ refreshToken: undefined, refreshTokenExpiresAt: DEADLINE }),
			),
		).toBeNull();
	});
});
