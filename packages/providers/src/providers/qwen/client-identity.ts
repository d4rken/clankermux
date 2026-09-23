/**
 * The Qwen Code identity on every request ClankerMux sends to Qwen: inference
 * on the DashScope host, the chat.qwen.ai device-OAuth and token endpoints,
 * and the strings the system-prompt rewrite substitutes for Claude Code's.
 * One function per endpoint.
 */

/** The qwen-code TypeScript SDK version the User-Agent names. */
export const QWEN_CODE_SDK_VERSION = "0.1.7";

/** Pinned by hand; not the host ClankerMux runs on. */
export const QWEN_CODE_PLATFORM = "darwin";
export const QWEN_CODE_ARCH = "arm64";

export const QWEN_CODE_USER_AGENT = `QwenCode/sdk-typescript-v${QWEN_CODE_SDK_VERSION} (${QWEN_CODE_PLATFORM}; ${QWEN_CODE_ARCH})`;

/**
 * What the official OpenAI Node SDK (v5.x) adds to every request. portal.qwen.ai
 * validates these to confirm the official client is being used.
 */
export const QWEN_STAINLESS_HEADERS: Readonly<Record<string, string>> =
	Object.freeze({
		"X-Stainless-Lang": "js",
		"X-Stainless-Runtime": "node",
		"X-Stainless-Runtime-Version": "v22.17.0",
		"X-Stainless-Os": "MacOS",
		"X-Stainless-Arch": QWEN_CODE_ARCH,
		"X-Stainless-Package-Version": "5.11.0",
		"X-Stainless-Retry-Count": "0",
	});

export const DASHSCOPE_AUTH_TYPE = "qwen-oauth";
export const DASHSCOPE_CACHE_CONTROL = "enable";

export const QWEN_OAUTH_CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";
export const QWEN_OAUTH_SCOPE = "openid profile email model.completion";

export const QWEN_CODE_PRODUCT_NAME = "Qwen Code";
export const QWEN_CODE_CONTEXT_FILE = "QWEN.md";
export const QWEN_CODE_IDENTITY_PROMPT = `You are ${QWEN_CODE_PRODUCT_NAME}, an interactive CLI agent developed by Alibaba Group, specializing in software engineering tasks.`;
export const QWEN_CODE_FEEDBACK_LINE =
	"To report a bug or provide feedback, please use the /bug command";

/** POST /chat/completions on the account's DashScope host. */
export function qwenInferenceHeaders(
	accessToken?: string,
): Record<string, string> {
	return {
		...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
		"Content-Type": "application/json",
		"User-Agent": QWEN_CODE_USER_AGENT,
		"X-DashScope-CacheControl": DASHSCOPE_CACHE_CONTROL,
		"X-DashScope-UserAgent": QWEN_CODE_USER_AGENT,
		"X-DashScope-AuthType": DASHSCOPE_AUTH_TYPE,
		...QWEN_STAINLESS_HEADERS,
		"Accept-Language": "*",
		"Accept-Encoding": "gzip, deflate",
		"Sec-Fetch-Mode": "cors",
		Connection: "keep-alive",
	};
}

/** POST chat.qwen.ai/api/v1/oauth2/device/code */
export function qwenDeviceAuthorizationHeaders(): Record<string, string> {
	return { "Content-Type": "application/x-www-form-urlencoded" };
}

/** POST chat.qwen.ai/api/v1/oauth2/token, for both the device-code and refresh-token grants. */
export function qwenTokenHeaders(): Record<string, string> {
	return { "Content-Type": "application/x-www-form-urlencoded" };
}
