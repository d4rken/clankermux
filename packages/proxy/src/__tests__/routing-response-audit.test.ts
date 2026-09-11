import { describe, expect, it } from "bun:test";
import {
	isDefinitiveModelError,
	observeRoutingResponse,
} from "../routing-response-audit";

describe("raw routing response audit", () => {
	it("captures the raw reported model only after consumption", async () => {
		const results: unknown[] = [];
		const response = observeRoutingResponse(
			Response.json({ model: "upstream-version", choices: [] }),
			async (r) => {
				results.push(r);
			},
		);
		expect(results).toEqual([]);
		await response.text();
		expect(results).toEqual([
			{ reportedModel: "upstream-version", error: null },
		]);
	});
	it("handles split SSE and never invents a reported model", async () => {
		for (const [body, model] of [
			['data: {"response":{"model":"astra"}}\n\ndata: [DONE]\n\n', "astra"],
			['data: {"delta":"hi"}\n\n', null],
		] as const) {
			let result: unknown;
			const bytes = new TextEncoder().encode(body);
			const response = observeRoutingResponse(
				new Response(
					new ReadableStream({
						start(c) {
							for (const b of bytes) c.enqueue(new Uint8Array([b]));
							c.close();
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
				async (r) => {
					result = r;
				},
			);
			expect(await response.text()).toBe(body);
			expect(result).toEqual({ reportedModel: model, error: null });
		}
	});
	it("records cancellation and upstream stream failure", async () => {
		let result: unknown;
		const response = observeRoutingResponse(
			new Response(
				new ReadableStream({
					pull(c) {
						c.error(new Error("broken"));
					},
				}),
			),
			async (r) => {
				result = r;
			},
		);
		await expect(response.text()).rejects.toThrow("broken");
		expect(result).toEqual({
			reportedModel: null,
			error: "Upstream response stream failed",
		});
		const canceled = observeRoutingResponse(
			new Response(new ReadableStream({ pull() {} })),
			async (r) => {
				result = r;
			},
		);
		await canceled.body?.cancel();
		expect(result).toEqual({
			reportedModel: null,
			error: "Response consumption canceled",
		});
	});
	it("does not damage a successful response when completion storage fails", async () => {
		const body = JSON.stringify({ model: "reported", content: "complete" });
		const response = observeRoutingResponse(new Response(body), async () => {
			throw new Error("database unavailable");
		});
		expect(await response.text()).toBe(body);
	});
});

it("does not treat tool data or transient quota failures as model-access evidence", () => {
	expect(
		isDefinitiveModelError(
			{
				content: [
					{
						type: "tool_result",
						content: { error: { code: "model_not_found" } },
					},
				],
			},
			200,
		),
	).toBe(false);
	expect(
		isDefinitiveModelError(
			{ error: { code: "rate_limit_error", message: "model quota exhausted" } },
			429,
		),
	).toBe(false);
	expect(
		isDefinitiveModelError(
			{ error: { code: "not_found", message: "resource not found" } },
			404,
		),
	).toBe(false);
});

it("recognizes the Codex detail refusal envelope without treating ordinary detail as rejection", () => {
	const detail =
		"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.";
	expect(isDefinitiveModelError({ detail }, 400)).toBe(true);
	expect(
		isDefinitiveModelError(
			{ detail: "The gpt-6-astra model is processing the request." },
			200,
		),
	).toBe(false);
	expect(isDefinitiveModelError({ detail }, 429)).toBe(false);
	expect(
		isDefinitiveModelError(
			{ content: [{ type: "tool_result", content: { detail } }] },
			200,
		),
	).toBe(false);
});

it("does not suppress provider routing restrictions even when their prose resembles a model rejection", () => {
	expect(
		isDefinitiveModelError(
			{
				error: {
					type: "not_found_error",
					message: "model not found under this provider policy",
				},
				metadata: { failed_routing_step: "Filter by Allowed Providers" },
			},
			404,
		),
	).toBe(false);
	expect(
		isDefinitiveModelError(
			{ error: { code: "model_not_found", message: "model not found" } },
			404,
		),
	).toBe(true);
});

it("reads a parameter complaint as a parameter complaint, however it mentions the model", () => {
	// The subject is the parameter. Reading it as a model rejection costs the
	// client the one message that says which parameter to drop, and replaces it
	// with a pool-wide refusal of a model every account can serve.
	const message =
		"The parameter 'temperature' is not supported with this model.";
	expect(
		isDefinitiveModelError(
			{ error: { code: "unsupported_parameter", message } },
			400,
		),
	).toBe(false);
	// Same envelope with no code at all: the prose alone must not carry it.
	expect(isDefinitiveModelError({ error: { message } }, 400)).toBe(false);
	expect(
		isDefinitiveModelError(
			{
				error: {
					code: "unsupported_value",
					message:
						"Unsupported value: 'reasoning.effort' does not exist for this model",
				},
			},
			400,
		),
	).toBe(false);
	// An explicit model code still wins: the two sets do not overlap, and a
	// backend that names one is not guessing.
	expect(
		isDefinitiveModelError(
			{ error: { code: "model_not_found", message } },
			400,
		),
	).toBe(true);
});

it("still recognizes the rejections where the model is the subject", () => {
	for (const message of [
		"The model `gpt-5.9` does not exist or you do not have access to it.",
		"model claude-fable-9 not found",
		"This model is not available for your plan.",
		"You do not have access to the model gpt-6-astra.",
	])
		expect(isDefinitiveModelError({ error: { message } }, 404)).toBe(true);
});

describe("protocol completion before transport close", () => {
	const success =
		'data: {"type":"response.completed","response":{"model":"astra","status":"completed"}}\n\n';
	for (const [name, body, expected] of [
		["Responses success", success, null],
		["Messages success", 'data: {"type":"message_stop"}\n\n', null],
		[
			"truncated frame",
			`${success.trimEnd()}\n`,
			"Upstream response stream failed",
		],
		[
			"nonterminal",
			'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
			"Upstream response stream failed",
		],
		[
			"failed response",
			'data: {"type":"response.failed","response":{"status":"failed"}}\n\n',
			"Upstream response failed",
		],
		[
			"incomplete response",
			'data: {"type":"response.incomplete","response":{"status":"incomplete"}}\n\n',
			"Upstream response incomplete",
		],
		[
			"error then stop",
			'data: {"type":"error","error":{"type":"overloaded_error"}}\n\ndata: {"type":"message_stop"}\n\n',
			"Upstream protocol error",
		],
		[
			"completed label with failed status",
			'data: {"type":"response.completed","response":{"status":"failed"}}\n\n',
			"Upstream response stream failed",
		],
		[
			"nested fake completion",
			'data: {"type":"content_block_delta","delta":{"text":"response.completed"}}\n\n',
			"Upstream response stream failed",
		],
	] as const) {
		it(name, async () => {
			let result: { error: string | null } | undefined;
			let sent = false;
			const response = observeRoutingResponse(
				new Response(
					new ReadableStream({
						pull(c) {
							if (!sent) {
								sent = true;
								c.enqueue(new TextEncoder().encode(body));
							} else
								c.error(new DOMException("connection closed", "AbortError"));
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
				async (r) => {
					result = r;
				},
			);
			await expect(response.text()).rejects.toThrow("connection closed");
			expect(result?.error).toBe(expected);
		});
	}
	it("post-terminal cancellation is successful and finish runs once", async () => {
		const results: unknown[] = [];
		const response = observeRoutingResponse(
			new Response(
				new ReadableStream({
					start(c) {
						c.enqueue(new TextEncoder().encode(success));
					},
					pull() {},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			),
			async (r) => {
				results.push(r);
			},
		);
		const reader = response.body?.getReader();
		await reader.read();
		await reader.cancel();
		expect(results).toEqual([{ reportedModel: "astra", error: null }]);
	});
	it("recognizes split CRLF completion after more than a megabyte of bounded events", async () => {
		const results: unknown[] = [];
		const response = observeRoutingResponse(
			new Response(
				new ReadableStream({
					start(c) {
						for (let i = 0; i < 1200; i++)
							c.enqueue(
								new TextEncoder().encode(
									`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "x".repeat(1024) })}\n\n`,
								),
							);
						for (const ch of success.replaceAll("\n", "\r\n"))
							c.enqueue(new TextEncoder().encode(ch));
					},
					pull(c) {
						c.error(new Error("closed"));
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			),
			async (r) => {
				results.push(r);
			},
		);
		await expect(response.text()).rejects.toThrow("closed");
		expect(results).toEqual([{ reportedModel: "astra", error: null }]);
	});
});

it("skips an oversized SSE event and resumes observing later complete events", async () => {
	let result: unknown;
	const response = observeRoutingResponse(
		new Response(
			new ReadableStream({
				start(c) {
					c.enqueue(
						new TextEncoder().encode(
							`data: {"padding":"${"x".repeat(1024 * 1024 + 1)}`,
						),
					);
					c.enqueue(
						new TextEncoder().encode(
							'"}\n\ndata: {"type":"response.completed","response":{"model":"astra","status":"completed"}}\n\n',
						),
					);
				},
				pull(c) {
					c.error(new Error("closed"));
				},
			}),
			{ headers: { "content-type": "text/event-stream" } },
		),
		async (r) => {
			result = r;
		},
	);
	await expect(response.text()).rejects.toThrow("closed");
	expect(result).toEqual({ reportedModel: "astra", error: null });
});
