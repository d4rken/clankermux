import { BaseAnthropicCompatibleProvider } from "../base-anthropic-compatible";

export const GROK_MODELS_ENDPOINT = "https://api.x.ai/v1/models";

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
