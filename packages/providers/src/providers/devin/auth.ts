import { createHash, randomBytes, randomUUID } from "node:crypto";

export type DevinFetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export interface DevinLogin {
	flow: "manual" | "loopback";
	url: string;
	state: string;
	verifier: string;
	expiresAt: number;
}

/** Devin CLI's PKCE flow: omit redirect_uri to show a hosted, single-use code. */
export function createDevinLogin(
	flow: DevinLogin["flow"] = "loopback",
): DevinLogin {
	const verifier = randomBytes(32).toString("base64url");
	const state = randomUUID();
	const url = new URL("https://app.devin.ai/auth/cli/continue");
	url.search = new URLSearchParams({
		...(flow === "loopback"
			? { redirect_uri: "http://127.0.0.1:59653/callback" }
			: {}),
		state,
		code_challenge: createHash("sha256").update(verifier).digest("base64url"),
		code_challenge_method: "S256",
		prompt: "select_account",
	}).toString();
	return {
		flow,
		url: url.href,
		verifier,
		state,
		expiresAt: Date.now() + 10 * 60_000,
	};
}

export async function exchangeDevinLogin(
	login: DevinLogin,
	input: string,
	fetcher: DevinFetch = fetch,
): Promise<string> {
	if (Date.now() >= login.expiresAt)
		throw new Error("Devin login expired; start again");
	let code: string | null;
	if (login.flow === "manual") {
		// The hosted page displays only the code. Its PKCE challenge binds it to
		// this session's server-held verifier; there is no browser callback state.
		code = input.trim();
	} else {
		// Keep the local helper's callback/state validation, including pending
		// sessions saved by older helpers before the flow field was introduced.
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
			throw new Error("Devin login state mismatch");
	}
	if (!code || code.length > 16_384)
		throw new Error("Devin login has no valid authorization code");
	const response = await fetcher("https://api.devin.ai/auth/cli/token", {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({ code, code_verifier: login.verifier }),
		signal: AbortSignal.timeout(30_000),
		redirect: "error",
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`Devin login failed (${response.status})`);
	}
	const body: unknown = await response.json();
	if (
		!body ||
		typeof body !== "object" ||
		!("token" in body) ||
		typeof body.token !== "string" ||
		!body.token.trim()
	) {
		throw new Error("Devin login returned no session token");
	}
	return body.token.trim();
}
