import { describe, expect, test } from "bun:test";
import { createModelsPreviewHandler } from "../models-preview";

const apiKey = "secret-preview-key";
const request = (
	body: unknown = { apiKey, endpoint: "https://models.example/api/v1/" },
) =>
	new Request("http://localhost/api/models/preview", {
		method: "POST",
		body: JSON.stringify(body),
	});
const stub = (
	fn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
) => fn as typeof fetch;

describe("model preview", () => {
	test.each([
		"https://models.example/api",
		"https://models.example/api/v1",
		"https://models.example/api/v1/",
	])("normalizes %s, authenticates, and returns distinct usable IDs", async (endpoint) => {
		const handler = createModelsPreviewHandler(
			stub(async (url, init) => {
				expect(String(url)).toBe("https://models.example/api/v1/models");
				expect(new Headers(init?.headers).get("authorization")).toBe(
					`Bearer ${apiKey}`,
				);
				expect(init?.redirect).toBe("error");
				return Response.json({
					data: [
						{ id: "model-b", name: "B" },
						{ id: "model-a" },
						{ id: "model-a" },
						null,
						{ id: " " },
					],
				});
			}),
		);
		const response = await handler(request({ apiKey, endpoint }));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			models: [
				{ id: "model-b", displayName: "B" },
				{ id: "model-a", displayName: "model-a" },
			],
		});
	});
	test.each([
		null,
		[],
		42,
		{},
		{ apiKey: "", endpoint: "https://models.example" },
		{ apiKey, endpoint: "file:///tmp/models" },
		{ apiKey, endpoint: "https://user:password@models.example" },
		{ apiKey, endpoint: "https://models.example?token=secret" },
	])("rejects malformed input without contacting upstream: %j", async (body) => {
		const handler = createModelsPreviewHandler(
			stub(async () => {
				throw new Error("must not fetch");
			}),
		);
		expect((await handler(request(body))).status).toBe(400);
	});
	test("rejects malformed JSON", async () => {
		const response = await createModelsPreviewHandler()(
			new Request("http://localhost", { method: "POST", body: "{" }),
		);
		expect(response.status).toBe(400);
	});
	test.each([
		401, 403, 500,
	])("contains upstream errors without exposing secrets or dashboard 401s: %i", async (status) => {
		const response = await createModelsPreviewHandler(
			stub(async () => new Response(apiKey, { status })),
		)(request());
		expect(response.status).toBe(502);
		expect(await response.text()).not.toContain(apiKey);
	});
	test.each([
		{ data: [] },
		{ data: [{ id: null }] },
		{ unexpected: true },
	])("rejects empty or malformed listings: %j", async (payload) => {
		const response = await createModelsPreviewHandler(
			stub(async () => Response.json(payload)),
		)(request());
		expect(response.status).toBe(502);
	});
	test("bounds a hanging upstream with a timeout", async () => {
		const response = await createModelsPreviewHandler(
			stub(
				async (_url, init) =>
					new Promise((_resolve, reject) => {
						init?.signal?.addEventListener(
							"abort",
							() => reject(new Error(apiKey)),
							{ once: true },
						);
					}),
			),
			10,
		)(request());
		expect(response.status).toBe(502);
		expect(await response.text()).toContain("timed out");
	});
});
