import { describe, expect, it } from "bun:test";
import {
	ChatGptCloudflareCookieJar,
	isAllowedChatGptHost,
	MAX_COOKIE_VALUE_LEN,
	MAX_COOKIES_PER_HOST,
	MAX_HOSTS,
} from "../chatgpt-cloudflare-cookies";

function makeSetCookieResponse(setCookies: string[]): Response {
	return new Response(null, {
		headers: setCookies.map(
			(value) => ["set-cookie", value] as [string, string],
		),
	});
}

function cookieParts(headers: Headers): string[] {
	const cookie = headers.get("Cookie");
	if (!cookie) return [];
	return cookie.split("; ").sort();
}

describe("ChatGptCloudflareCookieJar", () => {
	it("stores and replays only allowlisted Cloudflare cookie names for chatgpt.com", () => {
		const jar = new ChatGptCloudflareCookieJar();
		const response = makeSetCookieResponse([
			"__cflb=west; Path=/; Secure; HttpOnly",
			"_cfuvid=visitor; Path=/; Secure; HttpOnly",
			"cf_clearance=clearance; Path=/; Secure; HttpOnly",
		]);

		jar.captureFromResponse(
			"https://chatgpt.com/backend-api/codex/responses",
			response,
		);

		const headers = new Headers();
		jar.applyCookieHeader(
			"https://chatgpt.com/backend-api/codex/responses",
			headers,
		);

		expect(cookieParts(headers)).toEqual(
			["__cflb=west", "_cfuvid=visitor", "cf_clearance=clearance"].sort(),
		);
	});

	it("ignores cookies set for non-chatgpt hosts", () => {
		const jar = new ChatGptCloudflareCookieJar();
		const response = makeSetCookieResponse([
			"_cfuvid=visitor; Path=/; Secure; HttpOnly",
		]);

		jar.captureFromResponse("https://api.openai.com/v1/responses", response);

		const headers = new Headers();
		jar.applyCookieHeader("https://api.openai.com/v1/responses", headers);

		expect(headers.get("Cookie")).toBeNull();
	});

	it("ignores non-cloudflare cookies for chatgpt.com hosts", () => {
		const jar = new ChatGptCloudflareCookieJar();
		const response = makeSetCookieResponse([
			"__Secure-next-auth.session-token=secret; Path=/; Secure; HttpOnly",
		]);

		jar.captureFromResponse(
			"https://chatgpt.com/backend-api/codex/responses",
			response,
		);

		const headers = new Headers();
		jar.applyCookieHeader(
			"https://chatgpt.com/backend-api/codex/responses",
			headers,
		);

		expect(headers.get("Cookie")).toBeNull();
	});

	it("ignores mixed cloudflare and non-cloudflare cookies, keeping only cloudflare ones", () => {
		const jar = new ChatGptCloudflareCookieJar();
		const response = makeSetCookieResponse([
			"_cfuvid=visitor; Path=/; Secure; HttpOnly",
			"chatgpt_session=secret; Path=/; Secure; HttpOnly",
		]);

		jar.captureFromResponse(
			"https://chatgpt.com/backend-api/codex/responses",
			response,
		);

		const headers = new Headers();
		jar.applyCookieHeader(
			"https://chatgpt.com/backend-api/codex/responses",
			headers,
		);

		expect(headers.get("Cookie")).toBe("_cfuvid=visitor");
	});

	it("never leaks chatgpt.com cookies to a different host", () => {
		const jar = new ChatGptCloudflareCookieJar();
		const response = makeSetCookieResponse([
			"_cfuvid=visitor; Path=/; Secure; HttpOnly",
		]);

		jar.captureFromResponse(
			"https://chatgpt.com/backend-api/codex/responses",
			response,
		);

		const headers = new Headers();
		jar.applyCookieHeader("https://api.openai.com/v1/responses", headers);

		expect(headers.get("Cookie")).toBeNull();
	});

	it("rejects plain http chatgpt.com urls", () => {
		const jar = new ChatGptCloudflareCookieJar();
		const response = makeSetCookieResponse([
			"_cfuvid=visitor; Path=/; Secure; HttpOnly",
		]);

		jar.captureFromResponse(
			"http://chatgpt.com/backend-api/codex/responses",
			response,
		);

		const httpHeaders = new Headers();
		jar.applyCookieHeader(
			"http://chatgpt.com/backend-api/codex/responses",
			httpHeaders,
		);
		expect(httpHeaders.get("Cookie")).toBeNull();

		const httpsHeaders = new Headers();
		jar.applyCookieHeader(
			"https://chatgpt.com/backend-api/codex/responses",
			httpsHeaders,
		);
		expect(httpsHeaders.get("Cookie")).toBeNull();
	});

	it("removes a stored cookie when Cloudflare sends a Max-Age=0 revocation", () => {
		const jar = new ChatGptCloudflareCookieJar();

		jar.captureFromResponse(
			"https://chatgpt.com/backend-api/codex/responses",
			makeSetCookieResponse(["cf_clearance=clearance; Path=/; Secure"]),
		);
		jar.captureFromResponse(
			"https://chatgpt.com/backend-api/codex/responses",
			makeSetCookieResponse(["cf_clearance=; Path=/; Secure; Max-Age=0"]),
		);

		const headers = new Headers();
		jar.applyCookieHeader(
			"https://chatgpt.com/backend-api/codex/responses",
			headers,
		);

		expect(headers.get("Cookie")).toBeNull();
	});

	it("removes a stored cookie when Cloudflare sends an expired Expires attribute", () => {
		const jar = new ChatGptCloudflareCookieJar();

		jar.captureFromResponse(
			"https://chatgpt.com/backend-api/codex/responses",
			makeSetCookieResponse(["__cflb=west; Path=/; Secure"]),
		);
		jar.captureFromResponse(
			"https://chatgpt.com/backend-api/codex/responses",
			makeSetCookieResponse([
				"__cflb=; Path=/; Secure; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
			]),
		);

		const headers = new Headers();
		jar.applyCookieHeader(
			"https://chatgpt.com/backend-api/codex/responses",
			headers,
		);

		expect(headers.get("Cookie")).toBeNull();
	});

	it("replaces __cflb value on load-balancer affinity switch", () => {
		const jar = new ChatGptCloudflareCookieJar();

		jar.captureFromResponse(
			"https://chatgpt.com/backend-api/codex/responses",
			makeSetCookieResponse(["__cflb=west; Path=/; Secure; HttpOnly"]),
		);
		jar.captureFromResponse(
			"https://chatgpt.com/backend-api/codex/responses",
			makeSetCookieResponse(["__cflb=central; Path=/; Secure; HttpOnly"]),
		);

		const headers = new Headers();
		jar.applyCookieHeader(
			"https://chatgpt.com/backend-api/codex/responses",
			headers,
		);

		expect(headers.get("Cookie")).toBe("__cflb=central");
	});

	// ── Guardrails (beyond upstream) ─────────────────────────────────────────

	it("skips storing a cookie whose value exceeds MAX_COOKIE_VALUE_LEN", () => {
		const jar = new ChatGptCloudflareCookieJar();
		const oversized = "x".repeat(MAX_COOKIE_VALUE_LEN + 1);

		jar.captureFromResponse(
			"https://chatgpt.com/backend-api/codex/responses",
			makeSetCookieResponse([`cf_clearance=${oversized}; Path=/; Secure`]),
		);

		const headers = new Headers();
		jar.applyCookieHeader(
			"https://chatgpt.com/backend-api/codex/responses",
			headers,
		);

		expect(headers.get("Cookie")).toBeNull();
	});

	it("stores a cookie whose value is exactly MAX_COOKIE_VALUE_LEN", () => {
		const jar = new ChatGptCloudflareCookieJar();
		const atLimit = "x".repeat(MAX_COOKIE_VALUE_LEN);

		jar.captureFromResponse(
			"https://chatgpt.com/backend-api/codex/responses",
			makeSetCookieResponse([`cf_clearance=${atLimit}; Path=/; Secure`]),
		);

		const headers = new Headers();
		jar.applyCookieHeader(
			"https://chatgpt.com/backend-api/codex/responses",
			headers,
		);

		expect(headers.get("Cookie")).toBe(`cf_clearance=${atLimit}`);
	});

	it("caps the number of stored cookies per host at MAX_COOKIES_PER_HOST", () => {
		const jar = new ChatGptCloudflareCookieJar();
		// All names are allowlisted via the cf_chl_ prefix. Emit more distinct
		// names than the cap; only the first MAX_COOKIES_PER_HOST are retained.
		const setCookies: string[] = [];
		for (let i = 0; i < MAX_COOKIES_PER_HOST + 10; i++) {
			setCookies.push(`cf_chl_${i}=v${i}; Path=/; Secure`);
		}

		jar.captureFromResponse(
			"https://chatgpt.com/backend-api/codex/responses",
			makeSetCookieResponse(setCookies),
		);

		const headers = new Headers();
		jar.applyCookieHeader(
			"https://chatgpt.com/backend-api/codex/responses",
			headers,
		);

		expect(cookieParts(headers).length).toBe(MAX_COOKIES_PER_HOST);
	});

	it("still updates an already-stored cookie once the per-host cap is reached", () => {
		const jar = new ChatGptCloudflareCookieJar();
		const setCookies: string[] = [];
		for (let i = 0; i < MAX_COOKIES_PER_HOST; i++) {
			setCookies.push(`cf_chl_${i}=v${i}; Path=/; Secure`);
		}
		jar.captureFromResponse(
			"https://chatgpt.com/backend-api/codex/responses",
			makeSetCookieResponse(setCookies),
		);

		// Cap reached. Updating an EXISTING name must still work; a NEW name is
		// dropped.
		jar.captureFromResponse(
			"https://chatgpt.com/backend-api/codex/responses",
			makeSetCookieResponse([
				"cf_chl_0=updated; Path=/; Secure",
				"cf_chl_new=nope; Path=/; Secure",
			]),
		);

		const headers = new Headers();
		jar.applyCookieHeader(
			"https://chatgpt.com/backend-api/codex/responses",
			headers,
		);
		const parts = cookieParts(headers);
		expect(parts).toContain("cf_chl_0=updated");
		expect(parts.some((p) => p.startsWith("cf_chl_new="))).toBe(false);
		expect(parts.length).toBe(MAX_COOKIES_PER_HOST);
	});

	it("caps the number of distinct tracked hosts at MAX_HOSTS", () => {
		const jar = new ChatGptCloudflareCookieJar();
		// Each capture uses a distinct allowed subdomain host. Only the first
		// MAX_HOSTS get a stored entry; hosts past the cap are dropped.
		for (let i = 0; i < MAX_HOSTS + 5; i++) {
			jar.captureFromResponse(
				`https://sub${i}.chatgpt.com/backend-api/codex/responses`,
				makeSetCookieResponse([`cf_clearance=c${i}; Path=/; Secure`]),
			);
		}
		// A host beyond the cap has nothing stored.
		const overflow = new Headers();
		jar.applyCookieHeader(
			`https://sub${MAX_HOSTS + 4}.chatgpt.com/backend-api/codex/responses`,
			overflow,
		);
		expect(overflow.get("Cookie")).toBeNull();
		// A host within the cap still replays.
		const kept = new Headers();
		jar.applyCookieHeader(
			"https://sub0.chatgpt.com/backend-api/codex/responses",
			kept,
		);
		expect(kept.get("Cookie")).toBe("cf_clearance=c0");
	});
});

describe("isAllowedChatGptHost", () => {
	it("allows chatgpt.com and its recognized subdomains/aliases", () => {
		for (const host of [
			"chatgpt.com",
			"foo.chatgpt.com",
			"staging.chatgpt.com",
			"chat.openai.com",
			"chatgpt-staging.com",
			"api.chatgpt-staging.com",
		]) {
			expect(isAllowedChatGptHost(host)).toBe(true);
		}
	});

	it("rejects lookalike and unrelated hosts", () => {
		for (const host of [
			"evilchatgpt.com",
			"chatgpt.com.evil.example",
			"api.openai.com",
			"foo.chat.openai.com",
		]) {
			expect(isAllowedChatGptHost(host)).toBe(false);
		}
	});
});
