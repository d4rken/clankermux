import { expect, it } from "bun:test";
import { BaseAnthropicCompatibleProvider } from "./base-anthropic-compatible";

class TestProvider extends BaseAnthropicCompatibleProvider {
	getEndpoint() {
		return "https://example.com";
	}
}

it.each([
	"__proto__",
	"constructor",
])("preserves a literal target despite obsolete static mapping key %s", async (model) => {
	// The mapping config this used to vary is gone from the type and from
	// `transformRequestBody`, which now returns the request untouched. What is
	// still worth asserting is that a model NAMED after a prototype key survives
	// the round trip.
	const provider = new TestProvider({});
	const request = new Request("https://example.com/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model, messages: [] }),
	});
	const transformed = await provider.transformRequestBody(request);
	expect((await transformed.json()).model).toBe(model);
});
