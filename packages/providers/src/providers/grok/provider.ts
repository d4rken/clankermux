import { BaseAnthropicCompatibleProvider } from "../base-anthropic-compatible";

export class GrokProvider extends BaseAnthropicCompatibleProvider {
	constructor() {
		super({
			name: "grok",
			authHeader: "authorization",
			authType: "bearer",
			supportsStreaming: true,
			defaultModel: "grok-4.6",
		});
	}

	getEndpoint(): string {
		// No /v1 suffix: buildUrl concatenates this with the incoming path, which
		// already carries one.
		return "https://api.x.ai";
	}
}
