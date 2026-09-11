import { IMAGE_TOKEN_ESTIMATE, measureBodyForEstimate } from "@clankermux/core";

const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/** Advisory estimate shared by Codex and OpenRouter, not a model-specific tokenizer. */
export async function buildSyntheticCountTokensRequest(
	request: Request,
): Promise<Request> {
	const respond = (body: unknown, status: number) => {
		const headers = new Headers(request.headers);
		headers.delete("content-length");
		headers.set("content-type", "application/json");
		headers.set("x-clankermux-synthetic-response", "true");
		headers.set("x-clankermux-synthetic-status", String(status));
		return new Request(request.url, {
			method: request.method,
			headers,
			body: JSON.stringify(body),
		});
	};
	const reject = (message: string) =>
		respond(
			{ type: "error", error: { type: "invalid_request_error", message } },
			400,
		);
	if (!request.headers.get("content-type")?.includes("application/json"))
		return reject("Content-Type must be application/json for count_tokens");
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return reject("Request body must be valid JSON");
	}
	if (
		!record(body) ||
		typeof body.model !== "string" ||
		!body.model.trim() ||
		!Array.isArray(body.messages)
	)
		return reject("count_tokens requires a model and a messages array");
	if (
		body.messages.some(
			(message: unknown) =>
				!record(message) ||
				!["user", "assistant", "system"].includes(String(message.role)) ||
				!(
					typeof message.content === "string" ||
					(Array.isArray(message.content) &&
						message.content.every(
							(block: unknown) =>
								record(block) &&
								typeof block.type === "string" &&
								block.type.length > 0,
						))
				),
		)
	)
		return reject(
			"messages must contain roles and string or content-block bodies",
		);
	const measured = measureBodyForEstimate(body);
	// Preserve the existing Codex formula. Accuracy varies by language/model;
	// images use a fixed allowance and documents retain their payload estimate.
	const inputTokens = Math.max(
		1,
		Math.ceil((measured.textChars + measured.documentPayloadChars) / 3) +
			measured.imageCount * IMAGE_TOKEN_ESTIMATE,
	);
	return respond({ input_tokens: inputTokens }, 200);
}
