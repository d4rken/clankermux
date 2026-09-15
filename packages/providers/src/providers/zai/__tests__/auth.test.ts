import { describe, expect, it } from "bun:test";
import {
	createZaiLogin,
	exchangeZaiLogin,
	type ZaiFetch,
	type ZaiLogin,
} from "../auth";

const TOKEN_URL = "https://zcode.z.ai/api/v1/oauth/token";
const LOGIN_URL = "https://api.z.ai/api/auth/z/login";
const CUSTOMER_URL = "https://api.z.ai/api/biz/customer/getCustomerInfo";
const KEYS_URL =
	"https://api.z.ai/api/biz/v1/organization/org-1/projects/proj-1/api_keys";
const COPY_URL = `${KEYS_URL}/copy/key-1`;

interface Call {
	url: string;
	method: string;
	auth: string | null;
	body: unknown;
}

interface WalkResponses {
	token?: unknown;
	login?: unknown;
	customer?: unknown;
	keys?: unknown;
	create?: unknown;
	copy?: unknown;
}

const DEFAULTS: Required<WalkResponses> = {
	token: {
		code: 0,
		data: {
			zai: { access_token: "oauth-access-token" },
			user: { email: "person@example.test", id: 4242 },
		},
	},
	login: { code: 200, data: { access_token: "biz-token" } },
	customer: {
		code: 200,
		data: {
			organizations: [
				{ organizationId: "other-org", isDefault: false, projects: [] },
				{
					organizationId: "org-1",
					isDefault: true,
					projects: [
						{ projectId: "other-project", isDefault: false },
						{ projectId: "proj-1", isDefault: true },
					],
				},
			],
		},
	},
	keys: {
		code: 200,
		data: { list: [{ name: "clankermux", apiKey: "key-1" }] },
	},
	create: { code: 200, data: { name: "clankermux", apiKey: "key-1" } },
	copy: { code: 200, data: { secretKey: "secret-1" } },
};

/** Stub the whole mint walk; `responses` replaces one leg at a time. */
function walk(responses: WalkResponses = {}) {
	const calls: Call[] = [];
	const merged = { ...DEFAULTS, ...responses };
	const answer = (value: unknown) =>
		value instanceof Response ? value : Response.json(value);
	const fetcher: ZaiFetch = async (input, init) => {
		const request = new Request(input, init);
		const body =
			request.method === "POST"
				? ((await request.clone().json()) as unknown)
				: undefined;
		calls.push({
			url: request.url,
			method: request.method,
			auth: request.headers.get("authorization"),
			body,
		});
		if (request.url === TOKEN_URL) return answer(merged.token);
		if (request.url === LOGIN_URL) return answer(merged.login);
		if (request.url === CUSTOMER_URL) return answer(merged.customer);
		if (request.url === COPY_URL) return answer(merged.copy);
		if (request.url === KEYS_URL)
			return answer(request.method === "POST" ? merged.create : merged.keys);
		throw new Error(`unexpected request: ${request.method} ${request.url}`);
	};
	return { calls, fetcher };
}

const redirect = (login: ZaiLogin, code = "auth-code") =>
	`http://localhost:54548/callback?code=${code}&state=${login.state}`;

const rejection = async (work: Promise<unknown>): Promise<Error> =>
	work.then(
		() => new Error("exchange unexpectedly succeeded"),
		(failure: unknown) => failure as Error,
	);

describe("Z.AI browser login", () => {
	it("authorizes against chat.z.ai with a per-login state and the loopback redirect", () => {
		const login = createZaiLogin();
		const url = new URL(login.url);
		expect(url.origin + url.pathname).toBe(
			"https://chat.z.ai/api/oauth/authorize",
		);
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("client_id")).toBe(
			"client_P8X5CMWmlaRO9gyO-KSqtg",
		);
		expect(url.searchParams.get("redirect_uri")).toBe(
			"http://localhost:54548/callback",
		);
		expect(url.searchParams.get("state")).toBe(login.state);
		expect(login.state.length).toBeGreaterThan(8);
		expect(login.expiresAt - Date.now()).toBeGreaterThan(9 * 60_000);
		expect(login.expiresAt - Date.now()).toBeLessThanOrEqual(10 * 60_000);
		expect(createZaiLogin().state).not.toBe(login.state);
	});

	it("redeems only an unexpired callback that carries this session's state", async () => {
		const login = createZaiLogin();
		const { fetcher, calls } = walk();
		await expect(
			exchangeZaiLogin({ ...login, expiresAt: 0 }, redirect(login), fetcher),
		).rejects.toThrow("expired");
		await expect(
			exchangeZaiLogin(
				login,
				"http://localhost:54548/callback?code=auth-code&state=someone-else",
				fetcher,
			),
		).rejects.toThrow("state mismatch");
		await expect(
			exchangeZaiLogin(
				login,
				"http://localhost:54548/callback?code=auth-code",
				fetcher,
			),
		).rejects.toThrow("state mismatch");
		await expect(exchangeZaiLogin(login, "auth-code", fetcher)).rejects.toThrow(
			"state mismatch",
		);
		await expect(
			exchangeZaiLogin(
				login,
				`http://localhost:54548/callback?state=${login.state}`,
				fetcher,
			),
		).rejects.toThrow("authorization code");
		await expect(
			exchangeZaiLogin(login, redirect(login, "a".repeat(16_385)), fetcher),
		).rejects.toThrow("authorization code");
		expect(calls).toEqual([]);
		const credential = await exchangeZaiLogin(
			login,
			`auth-code#${login.state}`,
			fetcher,
		);
		expect(credential.apiKey).toBe("key-1.secret-1");
	});

	it("reuses the existing key and returns the durable credential with its identity", async () => {
		const login = createZaiLogin();
		const { fetcher, calls } = walk();
		const credential = await exchangeZaiLogin(login, redirect(login), fetcher);
		expect(credential).toEqual({
			apiKey: "key-1.secret-1",
			email: "person@example.test",
			accountId: "4242",
		});
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			`POST ${TOKEN_URL}`,
			`POST ${LOGIN_URL}`,
			`GET ${CUSTOMER_URL}`,
			`GET ${KEYS_URL}`,
			`GET ${COPY_URL}`,
		]);
		expect(calls[0]?.body).toEqual({
			provider: "zai",
			code: "auth-code",
			redirect_uri: "http://localhost:54548/callback",
			state: login.state,
		});
		expect(calls[1]?.body).toEqual({ token: "oauth-access-token" });
		for (const call of calls.slice(2))
			expect(call.auth).toBe("Bearer biz-token");
	});

	it("creates the key when the project has none of its own", async () => {
		const login = createZaiLogin();
		const { fetcher, calls } = walk({
			keys: { code: 200, data: { list: [] } },
		});
		const credential = await exchangeZaiLogin(login, redirect(login), fetcher);
		expect(credential.apiKey).toBe("key-1.secret-1");
		expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			`POST ${TOKEN_URL}`,
			`POST ${LOGIN_URL}`,
			`GET ${CUSTOMER_URL}`,
			`GET ${KEYS_URL}`,
			`POST ${KEYS_URL}`,
			`GET ${COPY_URL}`,
		]);
		expect(calls[4]?.body).toEqual({ name: "clankermux" });
		expect(calls[4]?.auth).toBe("Bearer biz-token");
	});

	it("leaves a key belonging to another client alone", async () => {
		const login = createZaiLogin();
		const { fetcher, calls } = walk({
			keys: { code: 200, data: { list: [{ name: "zcode", apiKey: "other" }] } },
		});
		await exchangeZaiLogin(login, redirect(login), fetcher);
		expect(
			calls.some((call) => call.method === "POST" && call.url === KEYS_URL),
		).toBe(true);
		expect(calls.some((call) => call.url.includes("copy/other"))).toBe(false);
	});

	it.each([
		["a bare array", [{ name: "clankermux", apiKey: "key-1" }]],
		["list", { list: [{ name: "clankermux", apiKey: "key-1" }] }],
		["keys", { keys: [{ name: "clankermux", apiKey: "key-1" }] }],
		["apiKeys", { apiKeys: [{ name: "clankermux", apiKey: "key-1" }] }],
		["records", { records: [{ name: "clankermux", apiKey: "key-1" }] }],
	])("reads an api-key listing wrapped as %s", async (_shape, data) => {
		const login = createZaiLogin();
		const { fetcher, calls } = walk({ keys: { code: 200, data } });
		expect(
			(await exchangeZaiLogin(login, redirect(login), fetcher)).apiKey,
		).toBe("key-1.secret-1");
		expect(
			calls.some((call) => call.method === "POST" && call.url === KEYS_URL),
		).toBe(false);
	});

	it("never repeats an upstream message or response body back to the caller", async () => {
		const login = createZaiLogin();
		const leaky = "invalid token sk-SECRET";
		const cases: WalkResponses[] = [
			{ token: { code: 400, msg: leaky } },
			{ login: { success: false, msg: leaky } },
			{ copy: new Response(leaky, { status: 500 }) },
		];
		for (const responses of cases) {
			const { fetcher } = walk(responses);
			const error = await rejection(
				exchangeZaiLogin(login, redirect(login), fetcher),
			);
			expect(error.message).not.toContain("sk-SECRET");
			expect(error.message).not.toContain(leaky);
			expect(error.message.startsWith("Z.AI")).toBe(true);
		}
	});

	it.each([
		[
			"an OAuth token response with no access token",
			{ token: { code: 0, data: { user: { id: 1 } } } },
			"access token",
		],
		[
			"a business login with no biz token",
			{ login: { code: 200, data: {} } },
			"business login",
		],
		[
			"an account with no organization",
			{ customer: { code: 200, data: { organizations: [] } } },
			"no organization/project",
		],
		[
			"an account whose default organization has no project",
			{
				customer: {
					code: 200,
					data: { organizations: [{ organizationId: "org-1", projects: [] }] },
				},
			},
			"no organization/project",
		],
		[
			"a key record with no apiKey",
			{
				keys: { code: 200, data: { list: [] } },
				create: { code: 200, data: {} },
			},
			"apiKey",
		],
		[
			"a copy response with no secretKey",
			{ copy: { code: 200, data: {} } },
			"secretKey",
		],
	] satisfies Array<
		[string, WalkResponses, string]
	>)("reports %s without echoing credentials", async (_case, responses, expected) => {
		const login = createZaiLogin();
		const { fetcher } = walk(responses);
		const error = await rejection(
			exchangeZaiLogin(login, redirect(login), fetcher),
		);
		expect(error.message).toContain(expected);
		expect(error.message).not.toContain("oauth-access-token");
		expect(error.message).not.toContain("biz-token");
		expect(error.message).not.toContain("secret-1");
	});

	it("does not start the walk when the caller has already gone away", async () => {
		const login = createZaiLogin();
		const { fetcher, calls } = walk();
		await expect(
			exchangeZaiLogin(login, redirect(login), fetcher, AbortSignal.abort()),
		).rejects.toThrow();
		expect(calls).toEqual([]);
	});
});
