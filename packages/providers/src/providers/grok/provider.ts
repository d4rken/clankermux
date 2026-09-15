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
		return "https://api.x.ai";
	}
}
