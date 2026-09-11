import { describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { createDevinLogin, exchangeDevinLogin } from "../auth";

describe("Devin CLI login", () => {
	it("binds browser login to a PKCE verifier and unpredictable state", () => {
		const login = createDevinLogin();
		const url = new URL(login.url);
		expect(url.origin + url.pathname).toBe(
			"https://app.devin.ai/auth/cli/continue",
		);
		expect(url.searchParams.get("state")).toBe(login.state);
		expect(url.searchParams.get("code_challenge")).toBe(
			createHash("sha256").update(login.verifier).digest("base64url"),
		);
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("redirect_uri")).toBe(
			"http://127.0.0.1:59653/callback",
		);
		expect(createDevinLogin().state).not.toBe(login.state);
	});
	it("exchanges only a matching, unexpired callback and returns the session token", async () => {
		const login = createDevinLogin();
		let request: Request | undefined;
		const fetcher = async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			request = new Request(input, init);
			return Response.json({ token: "private-session-token" });
		};
		const token = await exchangeDevinLogin(
			login,
			`http://127.0.0.1:59653/callback?code=one-use-code&state=${login.state}`,
			fetcher,
		);
		expect(token).toBe("private-session-token");
		expect(request?.url).toBe("https://api.devin.ai/auth/cli/token");
		expect(await request?.json()).toEqual({
			code: "one-use-code",
			code_verifier: login.verifier,
		});
		await expect(
			exchangeDevinLogin(
				login,
				"http://127.0.0.1:59653/callback?code=wrong&state=wrong",
				fetcher,
			),
		).rejects.toThrow("state");
		await expect(
			exchangeDevinLogin(
				{ ...login, expiresAt: 0 },
				`one-use-code#${login.state}`,
				fetcher,
			),
		).rejects.toThrow("expired");
	});
	it("offers a hosted code page without a redirect while retaining per-login PKCE", async () => {
		const login = createDevinLogin("manual");
		const url = new URL(login.url);
		expect(login.flow).toBe("manual");
		expect(url.searchParams.has("redirect_uri")).toBe(false);
		expect(url.searchParams.get("state")).toBe(login.state);
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("code_challenge")).toBe(
			createHash("sha256").update(login.verifier).digest("base64url"),
		);
		expect(createDevinLogin("manual").verifier).not.toBe(login.verifier);
		const fetcher = mock(
			async (_input: string | URL | Request, init?: RequestInit) => {
				expect(JSON.parse(String(init?.body))).toEqual({
					code: "one-use-hosted-code",
					code_verifier: login.verifier,
				});
				return Response.json({ token: "session-token" });
			},
		);
		expect(
			await exchangeDevinLogin(login, "  one-use-hosted-code  ", fetcher),
		).toBe("session-token");
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("rejects expired or empty hosted codes without exchanging and keeps loopback state checks", async () => {
		const fetcher = mock(async () => Response.json({ token: "unexpected" }));
		const login = createDevinLogin("manual");
		for (const code of ["", "   ", "a".repeat(16_385)]) {
			await expect(exchangeDevinLogin(login, code, fetcher)).rejects.toThrow(
				"authorization code",
			);
		}
		await expect(
			exchangeDevinLogin({ ...login, expiresAt: 0 }, "code", fetcher),
		).rejects.toThrow("expired");
		await expect(
			exchangeDevinLogin(createDevinLogin(), "raw-code", fetcher),
		).rejects.toThrow("state");
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("does not expose token endpoint bodies in errors", async () => {
		const login = createDevinLogin();
		await expect(
			exchangeDevinLogin(
				login,
				`code#${login.state}`,
				async () =>
					new Response("private-token echoed by upstream", { status: 403 }),
			),
		).rejects.toThrow("Devin login failed (403)");
		await expect(
			exchangeDevinLogin(login, `code#${login.state}`, async () =>
				Response.json({}),
			),
		).rejects.toThrow("session token");
	});
});
