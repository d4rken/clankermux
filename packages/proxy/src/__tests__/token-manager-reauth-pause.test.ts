import { describe, expect, it, mock } from "bun:test";
import {
	OAuthRefreshTokenError,
	PAUSE_REASON_NEEDS_REAUTH,
} from "@clankermux/core";
import { pauseAccountForReauthIfInvalidGrant } from "../handlers/token-manager";

const account = {
	id: "acct-1",
	name: "Main-me",
	refresh_token: "rt-current",
};

function makePauser(result = true) {
	return {
		pauseAccountIfActive: mock(async () => result),
	};
}

describe("pauseAccountForReauthIfInvalidGrant", () => {
	it("pauses with oauth_invalid_grant for a typed OAuthRefreshTokenError", async () => {
		const dbOps = makePauser();
		const paused = await pauseAccountForReauthIfInvalidGrant(
			new OAuthRefreshTokenError("acct-1", "refresh rejected"),
			account,
			dbOps,
		);
		expect(paused).toBe(true);
		expect(dbOps.pauseAccountIfActive).toHaveBeenCalledTimes(1);
		const [id, reason, token] = dbOps.pauseAccountIfActive.mock.calls[0];
		expect(id).toBe("acct-1");
		expect(reason).toBe(PAUSE_REASON_NEEDS_REAUTH);
		// Guarded on the refresh token that failed, so a reauth can't be clobbered.
		expect(token).toBe("rt-current");
	});

	it("pauses when a plain Error message contains invalid_grant (non-Anthropic)", async () => {
		const dbOps = makePauser();
		const paused = await pauseAccountForReauthIfInvalidGrant(
			new Error("Failed to refresh: invalid_grant"),
			account,
			dbOps,
		);
		expect(paused).toBe(true);
		expect(dbOps.pauseAccountIfActive).toHaveBeenCalledTimes(1);
	});

	it("does NOT pause for a transient/non-auth failure", async () => {
		const dbOps = makePauser();
		const paused = await pauseAccountForReauthIfInvalidGrant(
			new Error("503 Service Unavailable"),
			account,
			dbOps,
		);
		expect(paused).toBe(false);
		expect(dbOps.pauseAccountIfActive).not.toHaveBeenCalled();
	});

	it("returns false (not throw) when the pause itself fails", async () => {
		const dbOps = {
			pauseAccountIfActive: mock(async () => {
				throw new Error("db locked");
			}),
		};
		const paused = await pauseAccountForReauthIfInvalidGrant(
			new OAuthRefreshTokenError("acct-1"),
			account,
			dbOps,
		);
		expect(paused).toBe(false);
	});
});
