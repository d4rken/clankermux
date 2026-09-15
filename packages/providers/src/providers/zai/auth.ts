import { randomUUID } from "node:crypto";
import { Logger } from "@clankermux/logger";

/**
 * Z.AI subscription sign-in: an authorization-code flow (no PKCE) against
 * chat.z.ai whose short-lived OAuth token is spent on the business API to
 * provision a durable `apiKey.secretKey` credential. That credential is what
 * every request carries, so the OAuth token never reaches the account row.
 */

const log = new Logger("ZaiAuth");

/** ZCode's client; the only one known to serve this flow. */
const CLIENT_ID = "client_P8X5CMWmlaRO9gyO-KSqtg";
const AUTHORIZE_URL = "https://chat.z.ai/api/oauth/authorize";
const TOKEN_URL = "https://zcode.z.ai/api/v1/oauth/token";
const BIZ_BASE = "https://api.z.ai";
/** Exchanges the OAuth access token for the token the business API accepts. */
const BUSINESS_LOGIN_URL = `${BIZ_BASE}/api/auth/z/login`;
const REDIRECT_URI = "https://zcode.z.ai/oauth/callback";
/** Our own key name, so sign-in never mutates ZCode's `zcode-api-key`. */
const KEY_NAME = "clankermux";
const LOGIN_TTL_MS = 10 * 60_000;
/** One budget for the whole mint walk, not per request. */
const EXCHANGE_BUDGET_MS = 20_000;

export interface ZaiLogin {
	url: string;
	state: string;
	expiresAt: number;
}

export interface ZaiCredential {
	apiKey: string;
	email?: string;
	accountId?: string;
}

export type ZaiFetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export function createZaiLogin(): ZaiLogin {
	const state = randomUUID();
	const url = new URL(AUTHORIZE_URL);
	url.search = new URLSearchParams({
		redirect_uri: REDIRECT_URI,
		response_type: "code",
		client_id: CLIENT_ID,
		state,
	}).toString();
	return { url: url.href, state, expiresAt: Date.now() + LOGIN_TTL_MS };
}

/**
 * Z.AI's `{ code, msg, data, success }` envelope. The OAuth token endpoint
 * signals success with `code: 0`, the biz endpoints with `code: 200` /
 * `success: true`. Bodies without a status wrapper pass through unchanged.
 */
function isSuccessCode(code: unknown): boolean {
	if (code == null) return true;
	if (typeof code === "number") return code === 0 || code === 200;
	if (typeof code === "string") return code === "0" || code === "200";
	return false;
}

function unwrapEnvelope(body: unknown, operation: string): unknown {
	if (
		!body ||
		typeof body !== "object" ||
		!("code" in body || "success" in body)
	)
		return body;
	const envelope = body as {
		code?: unknown;
		msg?: unknown;
		data?: unknown;
		success?: unknown;
	};
	if (envelope.success === false || !isSuccessCode(envelope.code)) {
		// `msg` stays server-side: the handler passes `Z.AI …` messages straight
		// to the dashboard, and an upstream message can quote a credential.
		log.debug(
			`Z.AI ${operation} rejected: code=${String(envelope.code)} msg=${String(envelope.msg ?? "")}`,
		);
		throw new Error(`Z.AI ${operation} failed (code ${String(envelope.code)})`);
	}
	return "data" in envelope ? envelope.data : envelope;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

/** Coerce an api_keys listing (bare array or common wrapper shapes) to an array. */
function asKeyArray(value: unknown): Array<Record<string, unknown>> {
	if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
	const record = asRecord(value);
	if (record)
		for (const field of ["list", "keys", "apiKeys", "records"]) {
			const candidate = record[field];
			if (Array.isArray(candidate))
				return candidate as Array<Record<string, unknown>>;
		}
	return [];
}

function trimmedString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

/** Identity fields arrive as either a string or a numeric id. */
function identityString(value: unknown): string | undefined {
	return typeof value === "string" || typeof value === "number"
		? String(value)
		: undefined;
}

async function requestJson(
	url: string,
	init: RequestInit,
	fetcher: ZaiFetch,
	signal: AbortSignal,
): Promise<unknown> {
	signal.throwIfAborted();
	const response = await fetcher(url, { ...init, signal, redirect: "error" });
	if (!response.ok) {
		// The body is dropped rather than reported: it can quote a credential.
		await response.body?.cancel();
		throw new Error(`Z.AI request failed (${response.status})`);
	}
	const body = await response.text();
	if (!body.trim()) return undefined;
	try {
		return JSON.parse(body) as unknown;
	} catch {
		throw new Error("Z.AI returned a malformed response");
	}
}

const getJson = (
	url: string,
	headers: Record<string, string>,
	fetcher: ZaiFetch,
	signal: AbortSignal,
): Promise<unknown> =>
	requestJson(
		url,
		{ method: "GET", headers: { Accept: "application/json", ...headers } },
		fetcher,
		signal,
	);

const postJson = (
	url: string,
	body: Record<string, string>,
	headers: Record<string, string>,
	fetcher: ZaiFetch,
	signal: AbortSignal,
): Promise<unknown> =>
	requestJson(
		url,
		{
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				...headers,
			},
			body: JSON.stringify(body),
		},
		fetcher,
		signal,
	);

/**
 * Provision the durable Z.AI API key from a short-lived OAuth access token:
 * business login, resolve the default org/project, find or create our key,
 * then read its secret.
 */
async function mintZaiApiKey(
	oauthAccessToken: string,
	fetcher: ZaiFetch,
	signal: AbortSignal,
): Promise<string> {
	const session = asRecord(
		unwrapEnvelope(
			await postJson(
				BUSINESS_LOGIN_URL,
				{ token: oauthAccessToken },
				{},
				fetcher,
				signal,
			),
			"business login",
		),
	);
	const bizToken =
		trimmedString(session?.access_token) ?? trimmedString(session?.accessToken);
	if (!bizToken)
		throw new Error("Z.AI business login returned no access token");
	const auth = { Authorization: `Bearer ${bizToken}` };

	const customer = asRecord(
		unwrapEnvelope(
			await getJson(
				`${BIZ_BASE}/api/biz/customer/getCustomerInfo`,
				auth,
				fetcher,
				signal,
			),
			"customer lookup",
		),
	);
	const organizations = Array.isArray(customer?.organizations)
		? (customer.organizations as Array<Record<string, unknown>>)
		: [];
	const organization =
		organizations.find((entry) => entry?.isDefault) ?? organizations[0];
	const projects = Array.isArray(organization?.projects)
		? (organization.projects as Array<Record<string, unknown>>)
		: [];
	const project = projects.find((entry) => entry?.isDefault) ?? projects[0];
	const organizationId = trimmedString(organization?.organizationId);
	const projectId = trimmedString(project?.projectId);
	if (!organizationId || !projectId)
		throw new Error(
			"Z.AI key provisioning failed: no organization/project on account",
		);

	const keysUrl = `${BIZ_BASE}/api/biz/v1/organization/${organizationId}/projects/${projectId}/api_keys`;
	const existing = asKeyArray(
		unwrapEnvelope(
			await getJson(keysUrl, auth, fetcher, signal),
			"api key list",
		),
	).find((key) => key.name === KEY_NAME);
	const keyRecord =
		existing ??
		asRecord(
			unwrapEnvelope(
				await postJson(keysUrl, { name: KEY_NAME }, auth, fetcher, signal),
				"api key create",
			),
		);
	const apiKey = trimmedString(keyRecord?.apiKey);
	if (!apiKey) throw new Error("Z.AI key provisioning returned no apiKey");

	// Always read the secret from the copy endpoint: list entries mask it and
	// the create response's inline secret is not reliable across account states.
	const copied = asRecord(
		unwrapEnvelope(
			await getJson(
				`${keysUrl}/copy/${encodeURIComponent(apiKey)}`,
				auth,
				fetcher,
				signal,
			),
			"api key copy",
		),
	);
	const secretKey = trimmedString(copied?.secretKey);
	if (!secretKey)
		throw new Error("Z.AI key provisioning returned no secretKey");
	return `${apiKey}.${secretKey}`;
}

/**
 * Redeem a browser sign-in for a durable Z.AI credential.
 *
 * `input` is the whole redirect URL the browser was sent to, or `code#state`.
 * The flow has no PKCE, so `state` is the only binding between the session that
 * issued the authorize URL and the code being redeemed: a code arriving without
 * one is refused rather than spent.
 */
export async function exchangeZaiLogin(
	login: ZaiLogin,
	input: string,
	fetcher: ZaiFetch = fetch,
	signal?: AbortSignal,
): Promise<ZaiCredential> {
	if (Date.now() >= login.expiresAt)
		throw new Error("Z.AI login expired; start again");
	let code: string | null;
	let state: string | null;
	if (input.startsWith("http://") || input.startsWith("https://")) {
		const url = new URL(input);
		code = url.searchParams.get("code");
		state = url.searchParams.get("state");
	} else {
		const parts = input.trim().split("#");
		code = parts[0] ?? null;
		state = parts[1] ?? null;
	}
	if (!state || state !== login.state)
		throw new Error(
			"Z.AI login state mismatch; paste the whole redirect URL from the browser address bar",
		);
	if (!code || code.length > 16_384)
		throw new Error("Z.AI login has no valid authorization code");

	const budget = AbortSignal.timeout(EXCHANGE_BUDGET_MS);
	const deadline = signal ? AbortSignal.any([budget, signal]) : budget;
	const data = asRecord(
		unwrapEnvelope(
			await postJson(
				TOKEN_URL,
				{
					provider: "zai",
					code,
					redirect_uri: REDIRECT_URI,
					state: login.state,
				},
				{},
				fetcher,
				deadline,
			),
			"token exchange",
		),
	);
	const oauthAccessToken = trimmedString(asRecord(data?.zai)?.access_token);
	if (!oauthAccessToken)
		throw new Error("Z.AI token response is missing an access token");
	const user = asRecord(data?.user);
	return {
		apiKey: await mintZaiApiKey(oauthAccessToken, fetcher, deadline),
		email: trimmedString(user?.email),
		accountId: identityString(user?.user_id) ?? identityString(user?.id),
	};
}
