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
	for (const configured of [false, true]) {
		const provider = new TestProvider({
			modelMappings: configured ? { [model]: "target" } : { sonnet: "target" },
		});
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model, messages: [] }),
		});
		const transformed = await provider.transformRequestBody(request);
		expect((await transformed.json()).model).toBe(model);
	}
});
