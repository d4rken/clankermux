import { describe, expect, it, mock } from "bun:test";
import type { DatabaseOperations } from "@clankermux/database";
import {
	createGrokSubscriptionDeviceFlowInitHandler,
	createGrokSubscriptionDeviceFlowStatusHandler,
	createGrokSubscriptionReauthHandler,
	type GrokSubscriptionOAuthDeps,
} from "./oauth";

const DEVICE_FLOW = {
	deviceCode: "dc",
	userCode: "SG8J-NWQ3",
	verificationUri: "https://accounts.x.ai/oauth2/device",
	verificationUriComplete:
		"https://accounts.x.ai/oauth2/device?user_code=SG8J-NWQ3",
	expiresIn: 1800,
	interval: 5,
};

const TOKENS = {
	access_token: "at-new",
	refresh_token: "rt-new",
	expires_in: 21600,
	id_token: "id-new",
};

const IDENTITY = {
	externalAccountId: "user-123",
	email: "person@example.test",
	organizationName: "Example Org",
	planTier: null,
	rateLimitTier: null,
};

const EXISTING = {
	id: "grok-sub-1",
	name: "supergrok",
	provider: "grok-subscription",
};

function setup(
	overrides: {
		account?: Record<string, unknown> | null;
		deps?: Partial<GrokSubscriptionOAuthDeps>;
	} = {},
) {
	const runWithChanges = mock(async () => 1);
	const get = mock(async () =>
		overrides.account === undefined ? EXISTING : overrides.account,
	);
	const db = {
		getAdapter: () => ({ runWithChanges, get }),
		updateAccountTokens: mock(async () => true),
		resumeAccountIfNeedsReauth: mock(async () => true),
		setAccountIdentity: mock(async () => {}),
		setAccountIdentityFromProfile: mock(async () => true),
	};
	const deps: GrokSubscriptionOAuthDeps = {
		initiate: mock(async () => DEVICE_FLOW),
		poll: mock(async () => TOKENS),
		resolveIdentity: mock(async () => ({
			identity: IDENTITY,
			hasIdentity: true,
			fromProfile: true,
		})),
		...overrides.deps,
	} as unknown as GrokSubscriptionOAuthDeps;
	const dbOps = db as unknown as DatabaseOperations;
	return {
		db,
		deps,
		runWithChanges,
		init: createGrokSubscriptionDeviceFlowInitHandler(dbOps, deps),
		reauth: createGrokSubscriptionReauthHandler(dbOps, deps),
		status: createGrokSubscriptionDeviceFlowStatusHandler(),
	};
}

const post = (body: unknown) =>
	new Request("http://localhost/api/oauth/grok-subscription/init", {
		method: "POST",
		body: JSON.stringify(body),
	});

/** The device-flow poll runs detached, so wait for the session to settle. */
async function settled(
	status: (sessionId: string) => Response,
	sessionId: string,
): Promise<{ status: string; error?: string }> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const body = (await status(sessionId).json()) as {
			status: string;
			error?: string;
		};
		if (body.status !== "pending") return body;
		await Bun.sleep(1);
	}
	throw new Error("device flow session never left pending");
}

describe("grok-subscription device flow init", () => {
	it("answers with the user code and the accounts.x.ai verification URL before the user approves", async () => {
		const { init, status } = setup();

		const response = await init(post({ name: "supergrok", priority: 3 }));
		const body = (await response.json()) as {
			success: boolean;
			sessionId: string;
			authUrl: string;
			userCode: string;
		};

		expect(response.status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.userCode).toBe("SG8J-NWQ3");
		expect(body.authUrl).toBe(DEVICE_FLOW.verificationUriComplete);
		expect(new URL(body.authUrl).host).toBe("accounts.x.ai");
		expect(await settled(status, body.sessionId)).toEqual({
			status: "complete",
		});
	});

	it("inserts a grok-subscription account carrying both tokens once the poll completes", async () => {
		const { init, status, runWithChanges, db } = setup();

		const body = (await (
			await init(post({ name: "supergrok", priority: 3 }))
		).json()) as { sessionId: string };
		await settled(status, body.sessionId);

		const [sql, params] = runWithChanges.mock.calls[0] as unknown as [
			string,
			unknown[],
		];
		expect(sql).toContain("INSERT INTO accounts");
		expect(params).toContain("grok-subscription");
		expect(params).toContain("rt-new");
		expect(params).toContain("at-new");
		expect(params).toContain(3);
		// The add path never resumes: nothing was paused.
		expect(db.resumeAccountIfNeedsReauth).not.toHaveBeenCalled();
		// A real /v1/user read is what may stamp identity_profile_fetched_at.
		expect(db.setAccountIdentityFromProfile).toHaveBeenCalledWith(
			expect.any(String),
			IDENTITY,
		);
	});

	it("writes a claims-only capture through the token-agnostic identity writer", async () => {
		const { init, status, db } = setup({
			deps: {
				resolveIdentity: mock(async () => ({
					identity: { ...IDENTITY, organizationName: null },
					hasIdentity: true,
					fromProfile: false,
				})) as unknown as GrokSubscriptionOAuthDeps["resolveIdentity"],
			},
		});

		const body = (await (await init(post({ name: "supergrok" }))).json()) as {
			sessionId: string;
		};
		await settled(status, body.sessionId);

		expect(db.setAccountIdentity).toHaveBeenCalled();
		expect(db.setAccountIdentityFromProfile).not.toHaveBeenCalled();
	});

	it("reports a failed authorization on the status endpoint", async () => {
		const { init, status } = setup({
			deps: {
				poll: mock(async () => {
					throw new Error("The xAI sign-in was denied.");
				}) as unknown as GrokSubscriptionOAuthDeps["poll"],
			},
		});

		const body = (await (await init(post({ name: "supergrok" }))).json()) as {
			sessionId: string;
		};

		expect(await settled(status, body.sessionId)).toEqual({
			status: "error",
			error: "The xAI sign-in was denied.",
		});
	});

	it("rejects an invalid account name before starting a flow", async () => {
		const { init, deps } = setup();
		const response = await init(post({ name: "" }));
		expect(response.status).toBe(400);
		expect(deps.initiate).not.toHaveBeenCalled();
	});

	it("surfaces a device authorization failure as a 500 without opening a session", async () => {
		const { init } = setup({
			deps: {
				initiate: mock(async () => {
					throw new Error("auth.x.ai unreachable");
				}) as unknown as GrokSubscriptionOAuthDeps["initiate"],
			},
		});
		const response = await init(post({ name: "supergrok" }));
		expect(response.status).toBe(500);
	});

	it("returns 404 for an unknown session", async () => {
		const { status } = setup();
		expect(status("no-such-session").status).toBe(404);
	});
});

describe("grok-subscription reauth", () => {
	it("refuses an account belonging to another provider", async () => {
		const { reauth, deps } = setup({
			account: { id: "a", name: "codex acct", provider: "codex" },
		});

		const response = await reauth(post({ accountId: "a" }));

		expect(response.status).toBe(400);
		expect(deps.initiate).not.toHaveBeenCalled();
	});

	it("returns 404 when the account does not exist", async () => {
		const { reauth } = setup({ account: null });
		expect((await reauth(post({ accountId: "gone" }))).status).toBe(404);
	});

	it("writes the rotated credentials, then resumes and clears the pending rotation", async () => {
		const { reauth, status, db } = setup();

		const body = (await (
			await reauth(post({ accountId: EXISTING.id }))
		).json()) as { sessionId: string };
		await settled(status, body.sessionId);

		expect(db.updateAccountTokens).toHaveBeenCalledWith(
			EXISTING.id,
			"at-new",
			expect.any(Number),
			"rt-new",
		);
		expect(db.resumeAccountIfNeedsReauth).toHaveBeenCalledWith(EXISTING.id);
	});

	it("keeps the exchange when identity enrichment blows up afterwards", async () => {
		// The credentials are already durable at that point; letting the
		// enrichment failure escape would strand the account on a refresh token
		// xAI has already replaced.
		const { reauth, status, db } = setup({
			deps: {
				resolveIdentity: mock(async () => {
					throw new Error("426 upgrade required");
				}) as unknown as GrokSubscriptionOAuthDeps["resolveIdentity"],
			},
		});

		const body = (await (
			await reauth(post({ accountId: EXISTING.id }))
		).json()) as { sessionId: string };

		expect(await settled(status, body.sessionId)).toEqual({
			status: "complete",
		});
		expect(db.updateAccountTokens).toHaveBeenCalledWith(
			EXISTING.id,
			"at-new",
			expect.any(Number),
			"rt-new",
		);
	});

	it("completes even when the auto-resume fails", async () => {
		const { reauth, status, db } = setup();
		db.resumeAccountIfNeedsReauth = mock(async () => {
			throw new Error("db busy");
		}) as unknown as typeof db.resumeAccountIfNeedsReauth;

		const body = (await (
			await reauth(post({ accountId: EXISTING.id }))
		).json()) as { sessionId: string };

		expect(await settled(status, body.sessionId)).toEqual({
			status: "complete",
		});
	});
});
