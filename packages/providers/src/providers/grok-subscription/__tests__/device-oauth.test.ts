import { describe, expect, it } from "bun:test";
import { GROK_CLI_USER_AGENT } from "../client-identity";
import {
	initiateGrokSubscriptionDeviceFlow,
	pollGrokSubscriptionForToken,
	XAI_CLIENT_ID,
	XAI_DEVICE_CODE_ENDPOINT,
	XAI_DEVICE_SCOPE,
	XAI_TOKEN_ENDPOINT,
} from "../device-oauth";

/** The device authorization body the live endpoint returned, verbatim shape. */
const DEVICE_AUTHORIZATION = {
	device_code: "dc-opaque",
	user_code: "SG8J-NWQ3",
	verification_uri: "https://accounts.x.ai/oauth2/device",
	verification_uri_complete:
		"https://accounts.x.ai/oauth2/device?user_code=SG8J-NWQ3",
	expires_in: 1800,
	interval: 5,
};

const TOKENS = {
	access_token: "at-1",
	refresh_token: "rt-1",
	id_token: "id-1",
	expires_in: 21600,
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

interface Recorded {
	url: string;
	body: URLSearchParams;
	userAgent: string | null;
}

/**
 * A poll harness with a virtual clock: `sleep` advances it, so a test can place
 * the device code's deadline anywhere without waiting for it. Each queued step
 * may also advance the clock itself, which is how an in-flight poll that
 * outlives the deadline is expressed.
 */
function harness(
	steps: Array<{ response: Response; elapsedMs?: number }>,
	startMs = 1_000_000,
) {
	let clock = startMs;
	const sleeps: number[] = [];
	const calls: Recorded[] = [];
	let index = 0;
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const step = steps[index++];
		if (!step)
			throw new Error("token endpoint polled more times than expected");
		calls.push({
			url: String(input),
			body: new URLSearchParams(String(init?.body ?? "")),
			userAgent: new Headers(init?.headers).get("user-agent"),
		});
		clock += step.elapsedMs ?? 0;
		return step.response;
	}) as unknown as typeof fetch;
	return {
		sleeps,
		calls,
		options: {
			fetchImpl,
			now: () => clock,
			sleep: async (ms: number) => {
				sleeps.push(ms);
				clock += ms;
			},
		},
	};
}

describe("initiateGrokSubscriptionDeviceFlow", () => {
	it("posts the client id and the granted scope form-encoded", async () => {
		let recorded: Recorded | null = null;
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			recorded = {
				url: String(input),
				body: new URLSearchParams(String(init?.body ?? "")),
				userAgent: new Headers(init?.headers).get("user-agent"),
			};
			return json(DEVICE_AUTHORIZATION);
		}) as unknown as typeof fetch;

		const flow = await initiateGrokSubscriptionDeviceFlow({ fetchImpl });

		expect(recorded).not.toBeNull();
		const call = recorded as unknown as Recorded;
		expect(call.url).toBe(XAI_DEVICE_CODE_ENDPOINT);
		expect(call.body.get("client_id")).toBe(XAI_CLIENT_ID);
		expect(call.body.get("scope")).toBe(XAI_DEVICE_SCOPE);
		expect(call.userAgent).toBe(GROK_CLI_USER_AGENT);
		expect(flow).toEqual({
			deviceCode: "dc-opaque",
			userCode: "SG8J-NWQ3",
			verificationUri: "https://accounts.x.ai/oauth2/device",
			verificationUriComplete:
				"https://accounts.x.ai/oauth2/device?user_code=SG8J-NWQ3",
			expiresIn: 1800,
			interval: 5,
		});
	});

	it("falls back to the RFC 8628 defaults when interval and expires_in are omitted", async () => {
		const fetchImpl = (async () =>
			json({
				device_code: "dc",
				user_code: "AAAA-BBBB",
				verification_uri: "https://accounts.x.ai/oauth2/device",
			})) as unknown as typeof fetch;

		const flow = await initiateGrokSubscriptionDeviceFlow({ fetchImpl });

		expect(flow.interval).toBe(5);
		expect(flow.expiresIn).toBe(600);
		// Without a server-supplied complete URI the plain one is what we show.
		expect(flow.verificationUriComplete).toBe(
			"https://accounts.x.ai/oauth2/device",
		);
	});

	it("rejects a response that carries no device code", async () => {
		const fetchImpl = (async () =>
			json({ user_code: "AAAA-BBBB" })) as unknown as typeof fetch;
		await expect(
			initiateGrokSubscriptionDeviceFlow({ fetchImpl }),
		).rejects.toThrow(/device code/i);
	});

	it("surfaces a non-2xx device authorization as an error", async () => {
		const fetchImpl = (async () =>
			new Response("nope", { status: 503 })) as unknown as typeof fetch;
		await expect(
			initiateGrokSubscriptionDeviceFlow({ fetchImpl }),
		).rejects.toThrow(/503/);
	});
});

describe("pollGrokSubscriptionForToken", () => {
	const flow = { deviceCode: "dc", expiresIn: 1800, interval: 5 };

	it("keeps polling while the authorization is pending", async () => {
		const h = harness([
			{ response: json({ error: "authorization_pending" }, 400) },
			{ response: json({ error: "authorization_pending" }, 400) },
			{ response: json(TOKENS) },
		]);

		const tokens = await pollGrokSubscriptionForToken(flow, h.options);

		expect(tokens.access_token).toBe("at-1");
		expect(tokens.refresh_token).toBe("rt-1");
		expect(tokens.id_token).toBe("id-1");
		expect(h.sleeps).toEqual([5000, 5000, 5000]);
		expect(h.calls[0]?.url).toBe(XAI_TOKEN_ENDPOINT);
		expect(h.calls[0]?.body.get("grant_type")).toBe(
			"urn:ietf:params:oauth:grant-type:device_code",
		);
		expect(h.calls[0]?.body.get("device_code")).toBe("dc");
		expect(h.calls[0]?.body.get("client_id")).toBe(XAI_CLIENT_ID);
		expect(h.calls.map((call) => call.userAgent)).toEqual([
			GROK_CLI_USER_AGENT,
			GROK_CLI_USER_AGENT,
			GROK_CLI_USER_AGENT,
		]);
	});

	it("adds five seconds to the interval on EVERY slow_down, cumulatively", async () => {
		const h = harness([
			{ response: json({ error: "slow_down" }, 400) },
			{ response: json({ error: "slow_down" }, 400) },
			{ response: json({ error: "authorization_pending" }, 400) },
			{ response: json(TOKENS) },
		]);

		await pollGrokSubscriptionForToken(flow, h.options);

		// 5 → 10 → 15, and 15 is kept for every later poll. A multiplicative
		// back-off (RFC-violating) would read 5, 7.5, 11.25 here.
		expect(h.sleeps).toEqual([5000, 10000, 15000, 15000]);
	});

	it("uses the RFC default interval when the device authorization omitted one", async () => {
		const h = harness([{ response: json(TOKENS) }]);

		await pollGrokSubscriptionForToken(
			{ deviceCode: "dc", expiresIn: 1800, interval: 0 },
			h.options,
		);

		expect(h.sleeps).toEqual([5000]);
	});

	it("reports an expired device code as a restartable failure", async () => {
		const h = harness([{ response: json({ error: "expired_token" }, 400) }]);
		await expect(pollGrokSubscriptionForToken(flow, h.options)).rejects.toThrow(
			/expired/i,
		);
	});

	it("reports a denied authorization", async () => {
		const h = harness([{ response: json({ error: "access_denied" }, 400) }]);
		await expect(pollGrokSubscriptionForToken(flow, h.options)).rejects.toThrow(
			/denied/i,
		);
	});

	it("treats any other OAuth error as terminal", async () => {
		const h = harness([
			{ response: json({ error: "invalid_request" }, 400) },
			{ response: json(TOKENS) },
		]);
		await expect(pollGrokSubscriptionForToken(flow, h.options)).rejects.toThrow(
			/invalid_request/,
		);
		expect(h.calls).toHaveLength(1);
	});

	it("stops at the device code's own deadline instead of a fixed attempt count", async () => {
		// expires_in is shorter than one polling interval: the code is already
		// dead before the first poll would go out, so none is sent.
		const h = harness([{ response: json(TOKENS) }]);

		await expect(
			pollGrokSubscriptionForToken(
				{ deviceCode: "dc", expiresIn: 4, interval: 5 },
				h.options,
			),
		).rejects.toThrow(/expired/i);
		expect(h.calls).toHaveLength(0);
	});

	it("stops when the deadline passes while a poll is in flight", async () => {
		const h = harness([
			// The poll goes out inside the window and answers after it closed.
			{
				response: json({ error: "authorization_pending" }, 400),
				elapsedMs: 20_000,
			},
			{ response: json(TOKENS) },
		]);

		await expect(
			pollGrokSubscriptionForToken(
				{ deviceCode: "dc", expiresIn: 12, interval: 5 },
				h.options,
			),
		).rejects.toThrow(/expired/i);
		// It must not sleep another interval and poll a code it knows is dead.
		expect(h.calls).toHaveLength(1);
		expect(h.sleeps).toEqual([5000]);
	});

	it("is cancellable through the caller's signal", async () => {
		const controller = new AbortController();
		controller.abort();
		const h = harness([{ response: json(TOKENS) }]);

		await expect(
			pollGrokSubscriptionForToken(flow, {
				...h.options,
				signal: controller.signal,
			}),
		).rejects.toThrow();
		expect(h.calls).toHaveLength(0);
	});

	it("treats an unparseable error body as terminal rather than as success", async () => {
		const h = harness([
			{ response: new Response("upstream hiccup", { status: 502 }) },
			{ response: json(TOKENS) },
		]);

		await expect(pollGrokSubscriptionForToken(flow, h.options)).rejects.toThrow(
			/502/,
		);
	});

	it("rejects a 200 that carries no access token", async () => {
		const h = harness([{ response: json({ refresh_token: "rt" }) }]);
		await expect(pollGrokSubscriptionForToken(flow, h.options)).rejects.toThrow(
			/access token/i,
		);
	});
});
