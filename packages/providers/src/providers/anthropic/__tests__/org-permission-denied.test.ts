import { describe, expect, it } from "bun:test";
import { isAnthropicOrgPermissionDenied } from "../org-permission-denied";

const denied = (
	message = "Your organization has disabled Claude subscription access for Claude Code. Use an Anthropic API key instead.",
	code?: unknown,
) => ({
	error: {
		type: "permission_error",
		message,
		...(code === undefined ? {} : { details: { error_code: code } }),
	},
});
const response = (body: unknown, status = 403) =>
	Response.json(body, { status });

describe("Anthropic organization permission denial", () => {
	it("recognizes the machine code whatever the message says", async () => {
		for (const body of [
			denied("changed wording", "oauth_not_allowed_for_organization"),
			denied(
				"OAuth authentication is currently not allowed for this organization.",
				"oauth_not_allowed_for_organization",
			),
		]) {
			const res = response(body);
			expect(await isAnthropicOrgPermissionDenied(res)).toBe(true);
			expect(await res.json()).toEqual(body);
		}
	});
	it("treats a permission_error with no machine code as organization-wide", async () => {
		// Anthropic owns this copy and has reworded it mid-incident, so the
		// message is not consulted — only the absence of a scoping code.
		for (const body of [
			denied(),
			denied(
				"OAuth authentication is currently not allowed for this organization.",
			),
			denied("wording nobody has seen yet"),
			denied("Permission denied"),
		]) {
			const res = response(body);
			expect(await isAnthropicOrgPermissionDenied(res)).toBe(true);
			expect(await res.json()).toEqual(body);
		}
	});
	it("leaves scoped, malformed and unrelated errors alone", async () => {
		for (const body of [
			denied(undefined, "model_not_allowed"),
			denied(undefined, null),
			{},
			null,
		]) {
			expect(await isAnthropicOrgPermissionDenied(response(body))).toBe(false);
		}
		expect(await isAnthropicOrgPermissionDenied(response(denied(), 400))).toBe(
			false,
		);
		expect(
			await isAnthropicOrgPermissionDenied(
				new Response("<html>forbidden</html>", { status: 403 }),
			),
		).toBe(false);
		expect(
			await isAnthropicOrgPermissionDenied(
				new Response("{broken", {
					status: 403,
					headers: { "content-type": "application/json" },
				}),
			),
		).toBe(false);
	});
	it("bounds bytes even when a valid denial is followed by a huge message", async () => {
		const res = response({ ...denied(), padding: "x".repeat(20_000) });
		expect(await isAnthropicOrgPermissionDenied(res)).toBe(false);
		expect((await res.text()).length).toBeGreaterThan(20_000);
	});
	it("times out without consuming or waiting for the original stream", async () => {
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const res = new Response(
			new ReadableStream({
				start(c) {
					controller = c;
				},
			}),
			{ status: 403, headers: { "content-type": "application/json" } },
		);
		expect(await isAnthropicOrgPermissionDenied(res, undefined, 10)).toBe(
			false,
		);
		controller.enqueue(new TextEncoder().encode(JSON.stringify(denied())));
		controller.close();
		expect(await res.json()).toEqual(denied());
	});
	it("honors abort while reading a stalled body", async () => {
		const abort = new AbortController();
		const res = new Response(new ReadableStream({}), {
			status: 403,
			headers: { "content-type": "application/json" },
		});
		const result = isAnthropicOrgPermissionDenied(res, abort.signal);
		abort.abort();
		await expect(result).rejects.toThrow();
		void res.body?.cancel();
	});
});
