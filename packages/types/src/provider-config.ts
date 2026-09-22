/**
 * Provider names - duplicated here to avoid circular dependencies
 */
export const PROVIDER_NAMES = {
	ANTHROPIC: "anthropic", // Claude OAuth accounts
	CLAUDE_CONSOLE_API: "claude-console-api", // Claude API console accounts
	ZAI: "zai",
	MINIMAX: "minimax",
	ANTHROPIC_COMPATIBLE: "anthropic-compatible",
	OPENAI_COMPATIBLE: "openai-compatible",
	KILO: "kilo",
	OPENROUTER: "openrouter",
	ALIBABA_CODING_PLAN: "alibaba-coding-plan",
	CODEX: "codex",
	DEVIN: "devin",
	QWEN: "qwen",
	OLLAMA: "ollama",
	OLLAMA_CLOUD: "ollama-cloud",
	GROK: "grok",
	MIMO: "mimo",
	GROK_SUBSCRIPTION: "grok-subscription",
} as const;

export type ProviderName = (typeof PROVIDER_NAMES)[keyof typeof PROVIDER_NAMES];

/**
 * Type guard to check if a provider string is a known ProviderName
 */
export function isKnownProvider(provider: string): provider is ProviderName {
	return (Object.values(PROVIDER_NAMES) as string[]).includes(provider);
}

/**
 * Detailed provider configuration interface
 */
export interface ProviderConfig {
	/** Whether the provider requires session duration tracking (usage windows like Anthropic's 5-hour windows) */
	requiresSessionTracking: boolean;
	/** Whether the provider supports usage tracking via OAuth usage endpoint */
	supportsUsageTracking: boolean;
	/**
	 * Whether this integration can start usage polling through the account
	 * LIFECYCLE — creation, manual refresh, and the server's polling restarter —
	 * not merely whether a usage fetcher exists for the provider.
	 *
	 * This is deliberately narrower than `supportsUsageTracking`, and the two
	 * disagree in both directions:
	 *
	 *   - `qwen` tracks usage from the RESPONSE BODY and has no branch in
	 *     `UsageFetcher.fetchAndCache`. Polling it would fall through to the
	 *     Anthropic `/oauth/usage` default and send a Qwen token to
	 *     api.anthropic.com, so it must never be started.
	 *   - `codex` is polled by the CodexSpendCoordinator, not this path.
	 *
	 * Every surface that STARTS polling gates on this, so a provider that reaches
	 * the fetcher without a branch cannot be reached by adding an account.
	 */
	supportsUsagePolling: boolean;
	/** Whether the provider supports OAuth authentication */
	supportsOAuth: boolean;
	/**
	 * Whether this provider's `buildUrl` actually reads `account.custom_endpoint`.
	 *
	 * False means the endpoint is fixed in the provider and an operator's value
	 * would be stored, echoed back by the API, badged in the dashboard, and then
	 * ignored on every request. Every surface that can SET one gates on this, so
	 * no NEW operator override reaches a provider that would ignore it.
	 *
	 * It does not promise the column is empty for those providers: values stored
	 * before the gate are left alone rather than rewritten on upgrade, and the
	 * ollama-cloud add spec writes its own fixed host. Both are inert.
	 *
	 * `provider-custom-endpoint.test.ts` in `@clankermux/providers` probes each
	 * registered provider's real `buildUrl` and fails if a flag here disagrees
	 * with it, so this cannot drift when a provider changes how it resolves URLs.
	 */
	honoursCustomEndpoint: boolean;
	/** Default API endpoint for the provider */
	defaultEndpoint?: string;
}

/**
 * Provider-specific configuration mapping
 */
export const PROVIDER_CONFIG: Record<ProviderName, ProviderConfig> = {
	[PROVIDER_NAMES.DEVIN]: {
		requiresSessionTracking: false,
		supportsUsageTracking: true,
		supportsUsagePolling: true,
		supportsOAuth: false,
		honoursCustomEndpoint: true,
		defaultEndpoint: "https://server.codeium.com",
	},
	[PROVIDER_NAMES.ANTHROPIC]: {
		requiresSessionTracking: true, // Anthropic OAuth has 5-hour usage windows
		supportsUsageTracking: true, // Anthropic OAuth supports usage tracking
		supportsUsagePolling: true,
		supportsOAuth: true, // Anthropic OAuth uses OAuth authentication
		honoursCustomEndpoint: true,
		defaultEndpoint: "https://api.anthropic.com",
	},
	[PROVIDER_NAMES.CLAUDE_CONSOLE_API]: {
		requiresSessionTracking: false, // Claude console API is pay-as-you-go
		supportsUsageTracking: false, // Claude console API doesn't support usage tracking
		supportsUsagePolling: false,
		supportsOAuth: false, // Claude console API uses API key authentication
		honoursCustomEndpoint: true,
		defaultEndpoint: "https://api.anthropic.com",
	},
	[PROVIDER_NAMES.ZAI]: {
		requiresSessionTracking: true, // Zai has 5-hour session windows
		supportsUsageTracking: true, // Zai supports usage tracking via monitoring API
		supportsUsagePolling: true,
		supportsOAuth: false, // Zai uses API key authentication
		honoursCustomEndpoint: false,
		defaultEndpoint: "https://api.z.ai/api/anthropic",
	},
	[PROVIDER_NAMES.MINIMAX]: {
		requiresSessionTracking: false, // Minimax is pay-as-you-go
		// Minimax exposes Token Plan remains via /v1/token_plan/remains. Polling
		// only — request forwarding still goes through the generic
		// anthropic-compatible path.
		supportsUsageTracking: true,
		// False despite the working fetcher branch: NOTHING starts a Minimax
		// poller — not the boot sweep, not the lifecycle. Flipping this to true
		// without adding that wiring would prime on account creation, admit the
		// refresh endpoint, and show a refresh button that can never succeed.
		supportsUsagePolling: false,
		supportsOAuth: false, // Minimax uses API key authentication
		honoursCustomEndpoint: false,
		defaultEndpoint: "https://api.minimax.io/anthropic",
	},
	[PROVIDER_NAMES.ANTHROPIC_COMPATIBLE]: {
		requiresSessionTracking: false, // Anthropic-compatible is pay-as-you-go
		supportsUsageTracking: false, // Anthropic-compatible providers typically don't support usage tracking
		supportsUsagePolling: false,
		supportsOAuth: false, // Anthropic-compatible uses API key authentication
		honoursCustomEndpoint: true,
		defaultEndpoint: "https://api.anthropic.com", // Default, can be overridden via custom endpoint
	},
	[PROVIDER_NAMES.OPENAI_COMPATIBLE]: {
		requiresSessionTracking: false, // OpenAI-compatible is typically pay-as-you-go
		supportsUsageTracking: false, // OpenAI-compatible providers typically don't support usage tracking
		supportsUsagePolling: false,
		supportsOAuth: false, // OpenAI-compatible uses API key authentication
		honoursCustomEndpoint: true,
		defaultEndpoint: "https://api.anthropic.com", // Default, can be overridden via custom endpoint
	},
	[PROVIDER_NAMES.KILO]: {
		requiresSessionTracking: false, // Kilo is credit-based, no session windows
		supportsUsageTracking: true, // Kilo supports credit balance via /api/user
		supportsUsagePolling: true,
		supportsOAuth: false, // Kilo uses API key authentication
		honoursCustomEndpoint: true,
		defaultEndpoint: "https://api.kilo.ai/api/gateway",
	},
	[PROVIDER_NAMES.OPENROUTER]: {
		requiresSessionTracking: false, // OpenRouter is pay-as-you-go
		supportsUsageTracking: false, // Credits endpoint requires a separate management key
		// Refreshed through its own account-metadata branch, not the usage poller.
		supportsUsagePolling: false,
		supportsOAuth: false, // OpenRouter uses API key authentication
		honoursCustomEndpoint: true,
		defaultEndpoint: "https://openrouter.ai/api/v1",
	},
	[PROVIDER_NAMES.ALIBABA_CODING_PLAN]: {
		requiresSessionTracking: false, // Alibaba Coding Plan uses quota windows, not session stickiness
		supportsUsageTracking: false, // Usage endpoint requires session cookies, not API key
		supportsUsagePolling: false,
		supportsOAuth: false, // Uses API key authentication
		honoursCustomEndpoint: true,
		defaultEndpoint:
			"https://coding-intl.dashscope.aliyuncs.com/apps/anthropic",
	},
	[PROVIDER_NAMES.CODEX]: {
		requiresSessionTracking: true, // Codex has a weekly usage window (the 5h one was retired 2026-07-12)
		supportsUsageTracking: false, // Usage tracked via response headers, not a polling API
		// Warmed by the CodexSpendCoordinator; the refresh endpoint keeps its own
		// Codex branch rather than routing through the usage poller.
		supportsUsagePolling: false,
		supportsOAuth: true, // Codex uses OpenAI OAuth with PKCE
		honoursCustomEndpoint: true,
		defaultEndpoint: "https://chatgpt.com/backend-api/codex/responses",
	},
	[PROVIDER_NAMES.QWEN]: {
		requiresSessionTracking: false, // Qwen OAuth is quota-based, no session stickiness
		supportsUsageTracking: true, // Usage tracked via response body (OpenAI-compatible)
		// MUST stay false: UsageFetcher has no qwen branch, so a started poller
		// falls through to the Anthropic /oauth/usage default and would send a
		// Qwen token to api.anthropic.com.
		supportsUsagePolling: false,
		supportsOAuth: true, // Qwen uses OAuth 2.0 device code flow
		honoursCustomEndpoint: true,
		defaultEndpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
	},
	[PROVIDER_NAMES.OLLAMA]: {
		requiresSessionTracking: false,
		supportsUsageTracking: false,
		supportsUsagePolling: false,
		supportsOAuth: false,
		honoursCustomEndpoint: true,
		defaultEndpoint: "http://localhost:11434",
	},
	[PROVIDER_NAMES.OLLAMA_CLOUD]: {
		requiresSessionTracking: false,
		supportsUsageTracking: false,
		supportsUsagePolling: false,
		supportsOAuth: false,
		honoursCustomEndpoint: false,
		defaultEndpoint: "https://ollama.com",
	},
	[PROVIDER_NAMES.GROK]: {
		requiresSessionTracking: false, // xAI is pay-as-you-go; no session windows
		supportsUsageTracking: false, // balance lives behind management-api.x.ai and needs a Management Key
		supportsUsagePolling: false,
		supportsOAuth: false,
		honoursCustomEndpoint: false,
		defaultEndpoint: "https://api.x.ai",
	},
	[PROVIDER_NAMES.MIMO]: {
		requiresSessionTracking: false, // Token Plan meters tokens, not session windows
		supportsUsageTracking: false, // MiMo publishes no usage endpoint
		supportsUsagePolling: false, // nothing to poll
		supportsOAuth: false, // Token Plan uses a tp- API key
		honoursCustomEndpoint: true, // the region is stored per account in custom_endpoint
		defaultEndpoint: "https://token-plan-sgp.xiaomimimo.com/anthropic",
	},
	[PROVIDER_NAMES.GROK_SUBSCRIPTION]: {
		requiresSessionTracking: false, // a SuperGrok plan draws on a weekly pool, not a 5h window
		supportsUsageTracking: true,
		supportsUsagePolling: true, // GET /v1/billing?format=credits, weekly pool
		supportsOAuth: true, // xAI OAuth device flow
		honoursCustomEndpoint: false,
		defaultEndpoint: "https://cli-chat-proxy.grok.com",
	},
} as const satisfies Record<ProviderName, ProviderConfig>;

/**
 * Check if a provider should have session duration tracking
 * Currently only Anthropic providers have usage windows that benefit from session tracking
 * This can be extended for other providers with similar usage window systems (OpenAI-compatible, Anthropic-compatible, etc.)
 *
 * @param provider - The provider name to check
 * @returns boolean - True if the provider requires session duration tracking, false otherwise
 *                    Unknown providers default to false (security through default denial)
 */
export function requiresSessionDurationTracking(provider: string): boolean {
	if (!isKnownProvider(provider)) {
		// Log warning for unknown providers - defaults to no session tracking (security through default denial)
		console.warn(
			`Unknown provider: ${provider}. Defaulting to no session tracking (security through default denial).`,
		);
		return false;
	}

	if (provider in PROVIDER_CONFIG) {
		return PROVIDER_CONFIG[provider].requiresSessionTracking;
	}

	// Default to false for any provider not explicitly configured (security through default denial)
	return false;
}

/**
 * Check if a provider supports usage tracking
 *
 * @param provider - The provider name to check
 * @returns boolean - True if the provider supports usage tracking, false otherwise
 *                    Unknown providers default to false (security through default denial)
 */
export function supportsUsageTracking(provider: string): boolean {
	if (!isKnownProvider(provider)) {
		// Log warning for unknown providers - defaults to no usage tracking (security through default denial)
		console.warn(
			`Unknown provider: ${provider}. Defaulting to no usage tracking (security through default denial).`,
		);
		return false;
	}

	if (provider in PROVIDER_CONFIG) {
		return PROVIDER_CONFIG[provider].supportsUsageTracking;
	}

	// Default to false for any provider not explicitly configured (security through default denial)
	return false;
}

/**
 * Check whether usage polling can be STARTED for this provider through the
 * account lifecycle: creation priming, the manual refresh endpoint, and the
 * server's polling restarter all gate on this.
 *
 * Narrower than {@link supportsUsageTracking}, which describes only whether
 * usage is observable at all. See `supportsUsagePolling` on ProviderConfig for
 * why the two disagree for `qwen`, `codex` and `minimax`.
 *
 * @param provider - The provider name to check
 * @returns boolean - True if a poller may be started for this provider
 *                    Unknown providers default to false (security through default denial)
 */
export function supportsUsagePolling(provider: string): boolean {
	if (!isKnownProvider(provider)) return false;
	return PROVIDER_CONFIG[provider].supportsUsagePolling;
}

/**
 * Check whether a custom endpoint set on an account of this provider would
 * actually be used.
 *
 * Gate every surface that lets an operator SET one on this: the dashboard menu
 * item, the HTTP update handler, and the account-add specs. Storing a value the
 * provider's `buildUrl` never reads produces a setting that looks applied — it
 * is echoed back by the API and badged in the UI — while every request still
 * goes to the fixed endpoint, with no log line and no error.
 *
 * @param provider - The provider name to check
 * @returns boolean - True if the provider's buildUrl reads account.custom_endpoint
 *                    Unknown providers default to false (security through default denial)
 */
export function supportsCustomEndpoint(provider: string): boolean {
	if (!isKnownProvider(provider)) return false;
	return PROVIDER_CONFIG[provider].honoursCustomEndpoint;
}

/**
 * Check if a provider supports OAuth authentication
 *
 * @param provider - The provider name to check
 * @returns boolean - True if the provider supports OAuth, false otherwise
 *                    Unknown providers default to false (security through default denial)
 */
export function supportsOAuth(provider: string): boolean {
	if (!isKnownProvider(provider)) {
		// Log warning for unknown providers - defaults to no OAuth support (security through default denial)
		console.warn(
			`Unknown provider: ${provider}. Defaulting to no OAuth support (security through default denial).`,
		);
		return false;
	}

	if (provider in PROVIDER_CONFIG) {
		return PROVIDER_CONFIG[provider].supportsOAuth;
	}

	// Default to false for any provider not explicitly configured (security through default denial)
	return false;
}

/**
 * Get the default endpoint for a provider
 *
 * @param provider - The provider name to check
 * @returns string - The default endpoint for the provider, or a fallback if unknown
 */
export function getDefaultEndpoint(provider: string): string {
	if (!isKnownProvider(provider)) {
		// Log warning for unknown providers - return a default fallback
		console.warn(`Unknown provider: ${provider}. Using fallback endpoint.`);
		return "https://api.anthropic.com";
	}

	if (provider in PROVIDER_CONFIG) {
		return (
			PROVIDER_CONFIG[provider].defaultEndpoint || "https://api.anthropic.com"
		);
	}

	// Default to Anthropic API endpoint for any provider not explicitly configured
	return "https://api.anthropic.com";
}
