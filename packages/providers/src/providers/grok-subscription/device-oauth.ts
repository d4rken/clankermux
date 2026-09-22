// xAI OAuth 2.0 Device Authorization Grant (RFC 8628), as published by
// https://auth.x.ai/.well-known/openid-configuration.

const XAI_AUTH_BASE = "https://auth.x.ai";
export const XAI_DEVICE_CODE_ENDPOINT = `${XAI_AUTH_BASE}/oauth2/device/code`;
export const XAI_TOKEN_ENDPOINT = `${XAI_AUTH_BASE}/oauth2/token`;

/** The public Grok CLI client. Shared by every account we authorize. */
export const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";

/**
 * Requested and granted as a set. `offline_access` is what yields the refresh
 * token, and `grok-cli:access` is what the chat proxy checks; dropping either
 * leaves an account that cannot survive its first six hours.
 */
export const XAI_DEVICE_SCOPE =
	"openid profile email offline_access grok-cli:access api:access";

const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/** RFC 8628 §3.2: the client polls every 5s when the server names no interval. */
const DEFAULT_INTERVAL_SECONDS = 5;

/**
 * RFC 8628 §3.5: each `slow_down` raises the interval by five seconds, and the
 * raise is cumulative — the new interval applies to every later poll, not just
 * the next one.
 */
const SLOW_DOWN_INCREMENT_SECONDS = 5;

/** Only used when the device authorization omits `expires_in`. */
const DEFAULT_EXPIRES_IN_SECONDS = 600;

/** Per-request bound. The device code's own deadline bounds the whole loop. */
const REQUEST_TIMEOUT_MS = 30_000;

export interface GrokSubscriptionDeviceFlow {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete: string;
	/** Seconds the device code stays valid — the poll loop's own deadline. */
	expiresIn: number;
	interval: number;
}

export interface GrokSubscriptionTokens {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	/** Carries the identity claims; absent on some refreshes. */
	id_token?: string;
}

export interface GrokDeviceFlowOptions {
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
}

export interface GrokDevicePollOptions extends GrokDeviceFlowOptions {
	/** Injected by tests, which drive a virtual clock instead of waiting. */
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

function budgetedSignal(signal?: AbortSignal): AbortSignal {
	const budget = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([budget, signal]) : budget;
}

function postForm(
	url: string,
	form: URLSearchParams,
	options: GrokDeviceFlowOptions,
): Promise<Response> {
	return (options.fetchImpl ?? fetch)(url, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: form.toString(),
		signal: budgetedSignal(options.signal),
	});
}

function positiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: fallback;
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ask xAI for a device code. The user then enters `userCode` at
 * `verificationUri` (or follows `verificationUriComplete`, which carries it).
 */
export async function initiateGrokSubscriptionDeviceFlow(
	options: GrokDeviceFlowOptions = {},
): Promise<GrokSubscriptionDeviceFlow> {
	const response = await postForm(
		XAI_DEVICE_CODE_ENDPOINT,
		new URLSearchParams({
			client_id: XAI_CLIENT_ID,
			scope: XAI_DEVICE_SCOPE,
		}),
		options,
	);

	if (!response.ok) {
		const body = await response.text().catch(() => response.statusText);
		throw new Error(
			`Failed to start the xAI device flow: ${response.status} ${body}`,
		);
	}

	const data = (await response.json().catch(() => null)) as Record<
		string,
		unknown
	> | null;
	const deviceCode = nonEmptyString(data?.device_code);
	const verificationUri = nonEmptyString(data?.verification_uri);
	if (!deviceCode || !verificationUri) {
		throw new Error(
			"The xAI device authorization response carried no device code or verification URI",
		);
	}

	return {
		deviceCode,
		userCode: nonEmptyString(data?.user_code) ?? "",
		verificationUri,
		verificationUriComplete:
			nonEmptyString(data?.verification_uri_complete) ?? verificationUri,
		expiresIn: positiveNumber(data?.expires_in, DEFAULT_EXPIRES_IN_SECONDS),
		interval: positiveNumber(data?.interval, DEFAULT_INTERVAL_SECONDS),
	};
}

/**
 * Poll the token endpoint until the user approves, the device code dies, or the
 * caller cancels.
 *
 * Termination is the device code's OWN deadline (`expires_in`), not an attempt
 * count: a count either outlives a short-lived code — polling something already
 * dead — or expires while a long approval is still valid.
 */
export async function pollGrokSubscriptionForToken(
	flow: Pick<
		GrokSubscriptionDeviceFlow,
		"deviceCode" | "expiresIn" | "interval"
	>,
	options: GrokDevicePollOptions = {},
): Promise<GrokSubscriptionTokens> {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? defaultSleep;
	const deadline =
		now() + positiveNumber(flow.expiresIn, DEFAULT_EXPIRES_IN_SECONDS) * 1000;
	let intervalSeconds = positiveNumber(flow.interval, DEFAULT_INTERVAL_SECONDS);

	const expired = () =>
		new Error(
			"The xAI device code expired before it was approved. Start the sign-in again.",
		);

	for (;;) {
		options.signal?.throwIfAborted();
		// Wait first: the code was minted moments ago and the user has not had
		// time to approve it, so an immediate poll only spends an attempt.
		await sleep(intervalSeconds * 1000);
		options.signal?.throwIfAborted();
		if (now() >= deadline) throw expired();

		const response = await postForm(
			XAI_TOKEN_ENDPOINT,
			new URLSearchParams({
				grant_type: DEVICE_CODE_GRANT_TYPE,
				client_id: XAI_CLIENT_ID,
				device_code: flow.deviceCode,
			}),
			options,
		);

		if (response.ok) {
			const data = (await response.json().catch(() => null)) as Record<
				string,
				unknown
			> | null;
			const accessToken = nonEmptyString(data?.access_token);
			const refreshToken = nonEmptyString(data?.refresh_token);
			if (!accessToken || !refreshToken) {
				throw new Error(
					"The xAI token response carried no access token or refresh token",
				);
			}
			return {
				access_token: accessToken,
				refresh_token: refreshToken,
				// 0 on an omitted lifetime, so the token reads as due rather than as
				// good for however long we guessed. The scheduler then refreshes it on
				// its next tick instead of serving a token of unknown age.
				expires_in: positiveNumber(data?.expires_in, 0),
				id_token: nonEmptyString(data?.id_token) ?? undefined,
			};
		}

		const raw = await response.text().catch(() => "");
		let error: string | null = null;
		let description: string | null = null;
		try {
			const parsed = raw ? JSON.parse(raw) : null;
			error = nonEmptyString(parsed?.error);
			description = nonEmptyString(parsed?.error_description);
		} catch {
			// Not JSON — falls through to the terminal branch with the raw body.
		}

		switch (error) {
			case "authorization_pending":
				break;
			case "slow_down":
				intervalSeconds += SLOW_DOWN_INCREMENT_SECONDS;
				break;
			case "expired_token":
				throw expired();
			case "access_denied":
				throw new Error(
					"The xAI sign-in was denied. Approve the request, or try again with a different account.",
				);
			default:
				throw new Error(
					`xAI device authorization failed: ${response.status} ${
						error ?? raw ?? response.statusText
					}${description ? ` — ${description}` : ""}`,
				);
		}

		// Re-checked here rather than only before the next poll: the request above
		// may itself have outlived the code, and a dead code must not be polled
		// again after another full interval of waiting.
		if (now() >= deadline) throw expired();
	}
}
