import type { Config } from "@clankermux/config";
import type { DatabaseOperations } from "@clankermux/database";
import {
	fetchAnthropicProfile,
	generatePKCE,
	getOAuthProvider,
	type OAuthProviderConfig,
	type OAuthTokens,
	type PKCEChallenge,
} from "@clankermux/providers";

export interface BeginOptions {
	name: string;
	mode: "claude-oauth" | "console";
	skipAccountCheck?: boolean; // Skip account existence check for re-authentication
}

export interface BeginResult {
	sessionId: string;
	authUrl: string;
	pkce: PKCEChallenge;
	oauthConfig: OAuthProviderConfig;
	mode: "claude-oauth" | "console"; // Track mode to handle differently in complete()
}

export interface CompleteOptions {
	sessionId: string;
	code: string;
	name: string; // Required to properly create the account
	id?: string; // Account ID for re-authentication (UPDATE by id instead of name)
	priority?: number;
	customEndpoint?: string; // Custom API endpoint
}

export interface AccountCreated {
	id: string;
	name: string;
	provider: "anthropic" | "claude-console-api";
	authType: "oauth" | "api_key"; // Track authentication type
}

export interface OAuthFlowResult {
	success: boolean;
	message: string;
	data?: AccountCreated;
}

/**
 * Handles the Anthropic OAuth flow for both "claude-oauth" and "console" authentication modes.
 *
 * - "claude-oauth" mode: Standard OAuth with refresh tokens for Claude CLI OAuth accounts
 * - "console" mode: OAuth flow that creates a static API key
 *
 * This class does not persist session data. The caller must handle storage
 * between {@link begin} and {@link complete} calls.
 */
export class OAuthFlow {
	constructor(
		private dbOps: DatabaseOperations,
		private config: Config,
	) {}

	/**
	 * Starts an Anthropic OAuth flow.
	 *
	 * The caller MUST persist the returned `sessionId`, `pkce.verifier`,
	 * `mode`, and `tier` so that {@link complete} can validate the callback.
	 *
	 * @param opts - OAuth flow options
	 * @param opts.name - Unique account name
	 * @param opts.mode - Authentication mode ("claude-oauth" for Claude CLI OAuth, "console" for API key)
	 * @returns OAuth flow data including auth URL and session info
	 * @throws {Error} If account name already exists
	 */
	async begin(opts: BeginOptions): Promise<BeginResult> {
		const { name, mode, skipAccountCheck = false } = opts;

		// Check if account already exists (unless skipAccountCheck is true for re-authentication)
		if (!skipAccountCheck) {
			const existingAccounts = await this.dbOps.getAllAccounts();
			if (existingAccounts.some((a) => a.name === name)) {
				throw new Error(`Account with name '${name}' already exists`);
			}
		}

		// Get OAuth provider
		const oauthProvider = getOAuthProvider("anthropic");
		if (!oauthProvider) {
			throw new Error("Anthropic OAuth provider not found");
		}

		// Generate PKCE challenge
		const pkce = await generatePKCE();

		// Get OAuth config with runtime client ID
		const runtime = this.config.getRuntime();
		const oauthConfig = oauthProvider.getOAuthConfig(mode);
		oauthConfig.clientId = runtime.clientId;

		// Generate auth URL
		const authUrl = oauthProvider.generateAuthUrl(oauthConfig, pkce);

		// Create session ID for this OAuth flow
		const sessionId = crypto.randomUUID();

		// NOTE: OAuthFlow itself does not persist the session.
		//       The caller (HTTP-API oauth-init handler) must
		//       store {sessionId, verifier, mode, tier} – typically
		//       via DatabaseOperations.createOAuthSession().

		return {
			sessionId,
			authUrl,
			pkce,
			oauthConfig,
			mode,
		};
	}

	/**
	 * Completes the Anthropic OAuth flow after user authorization.
	 *
	 * Exchanges the authorization code for tokens and creates the account.
	 * For "console" mode, creates an API key instead of storing OAuth tokens.
	 *
	 * @param opts - Completion options
	 * @param opts.sessionId - Session ID from {@link begin}
	 * @param opts.code - Authorization code from OAuth callback
	 * @param opts.tier - Account tier (1, 5, or 20)
	 * @param opts.name - Account name (must match the one from begin)
	 * @param flowData - Flow data returned from {@link begin}
	 * @returns Created account information
	 * @throws {Error} If OAuth provider not found or token exchange fails
	 */
	async complete(
		opts: CompleteOptions,
		flowData: BeginResult,
	): Promise<AccountCreated> {
		const { code, name, priority = 0, customEndpoint } = opts;

		// Get OAuth provider
		const oauthProvider = getOAuthProvider("anthropic");
		if (!oauthProvider) {
			throw new Error("Anthropic OAuth provider not found");
		}

		// Exchange authorization code for tokens
		const tokens = await oauthProvider.exchangeCode(
			code,
			flowData.pkce.verifier,
			flowData.oauthConfig,
		);

		const accountId = crypto.randomUUID();

		// Handle console mode - create API key
		if (flowData.mode === "console" || !tokens.refreshToken) {
			const apiKey = await this.createAnthropicApiKey(tokens.accessToken);
			return await this.createAccountWithApiKey(
				accountId,
				name,
				apiKey,
				priority,
				customEndpoint,
			);
		}

		// Handle claude-oauth mode - standard OAuth flow
		return await this.createAccountWithOAuth(
			accountId,
			name,
			tokens,
			priority,
			customEndpoint,
		);
	}

	/**
	 * Completes re-authentication for an existing Anthropic account.
	 *
	 * Exchanges the authorization code for tokens and UPDATEs the existing account
	 * in place, preserving all metadata (stats, priority, settings).
	 *
	 * @param opts - Completion options (sessionId, code, name — the existing account name)
	 * @param flowData - Flow data returned from {@link begin}
	 * @throws {Error} If OAuth provider not found or token exchange fails
	 */
	async completeReauth(
		opts: CompleteOptions,
		flowData: BeginResult,
	): Promise<void> {
		const { code, id } = opts;

		if (!id) {
			throw new Error("Account id is required for re-authentication");
		}

		// Get OAuth provider
		const oauthProvider = getOAuthProvider("anthropic");
		if (!oauthProvider) {
			throw new Error("Anthropic OAuth provider not found");
		}

		// Exchange authorization code for tokens
		const tokens = await oauthProvider.exchangeCode(
			code,
			flowData.pkce.verifier,
			flowData.oauthConfig,
		);

		const adapter = this.dbOps.getAdapter();

		// Handle console mode — create new API key and update account
		if (flowData.mode === "console" || !tokens.refreshToken) {
			const apiKey = await this.createAnthropicApiKey(tokens.accessToken);
			await adapter.run(`UPDATE accounts SET api_key = ? WHERE id = ?`, [
				apiKey,
				id,
			]);
			await this.clearNeedsReauthPause(id);
			return;
		}

		// Handle claude-oauth mode — update OAuth tokens in place.
		// Re-enrich identity: merge the envelope identity with a fresh profile
		// fetch (fails open), then COALESCE-merge so a null never erases a
		// previously-captured value. identity_captured_at advances only when this
		// reauth captured something; identity_profile_fetched_at advances only when
		// the profile fetch returned data.
		const identity = await this.resolveAnthropicIdentity(tokens);
		const now = Date.now();
		await adapter.run(
			`UPDATE accounts SET
				refresh_token = ?,
				access_token = ?,
				expires_at = ?,
				refresh_token_issued_at = ?,
				identity_external_id = COALESCE(?, identity_external_id),
				identity_email = COALESCE(?, identity_email),
				identity_organization_name = COALESCE(?, identity_organization_name),
				identity_plan_tier = COALESCE(?, identity_plan_tier),
				identity_captured_at = COALESCE(?, identity_captured_at),
				identity_profile_fetched_at = COALESCE(?, identity_profile_fetched_at)
			WHERE id = ?`,
			[
				tokens.refreshToken,
				tokens.accessToken,
				tokens.expiresAt,
				now,
				identity.externalAccountId,
				identity.email,
				identity.organizationName,
				identity.planTier,
				identity.hasIdentity ? now : null,
				identity.profileFetchedAt,
				id,
			],
		);
		await this.clearNeedsReauthPause(id);
	}

	/**
	 * After a successful reauth, automatically lift an `oauth_invalid_grant`
	 * (needs-reauth) pause so the account returns to rotation without a separate
	 * manual resume. Best-effort: a guarded no-op for accounts paused for any
	 * other reason (or not paused), and a failure here must not fail the reauth —
	 * the tokens were already updated successfully.
	 */
	private async clearNeedsReauthPause(id: string): Promise<void> {
		try {
			await this.dbOps.resumeAccountIfNeedsReauth(id);
		} catch (err) {
			console.error(
				`[OAuthFlow] Failed to auto-resume needs-reauth pause for account ${id}:`,
				err,
			);
		}
	}

	/**
	 * Resolve the account profile identity for an Anthropic OAuth account at
	 * add/reauth time. Merges the envelope identity carried on the OAuth tokens
	 * (derived from exchangeCode's JWT claims) with a live profile-endpoint
	 * fetch — the profile wins for any non-null field, the envelope is the
	 * fallback. Fails open: a profile-fetch error yields a null profile and never
	 * throws (fetchAnthropicProfile already returns null on error, and the extra
	 * `.catch` is belt-and-braces), so account creation/reauth is never broken by
	 * it.
	 *
	 * This flow is anthropic-only — the OAuthFlow class only ever creates/updates
	 * provider="anthropic" OAuth accounts — so the profile fetch is unconditional.
	 *
	 * `hasIdentity` is true when any merged field is non-null (drives whether
	 * `identity_captured_at` advances); `profileFetchedAt` is now-ms only when the
	 * profile fetch actually returned data (drives `identity_profile_fetched_at`).
	 */
	private async resolveAnthropicIdentity(tokens: OAuthTokens): Promise<{
		externalAccountId: string | null;
		email: string | null;
		organizationName: string | null;
		planTier: string | null;
		hasIdentity: boolean;
		profileFetchedAt: number | null;
	}> {
		const profileIdentity = await fetchAnthropicProfile(
			tokens.accessToken,
		).catch(() => null);
		const envelope = tokens.identity ?? null;
		const externalAccountId =
			profileIdentity?.externalAccountId ?? envelope?.externalAccountId ?? null;
		const email = profileIdentity?.email ?? envelope?.email ?? null;
		const organizationName =
			profileIdentity?.organizationName ?? envelope?.organizationName ?? null;
		const planTier = profileIdentity?.planTier ?? envelope?.planTier ?? null;
		const hasIdentity =
			externalAccountId !== null ||
			email !== null ||
			organizationName !== null ||
			planTier !== null;
		return {
			externalAccountId,
			email,
			organizationName,
			planTier,
			hasIdentity,
			profileFetchedAt: profileIdentity ? Date.now() : null,
		};
	}

	/**
	 * Creates an API key using the Anthropic console endpoint.
	 *
	 * This is used for "console" mode accounts where users want a static API key
	 * instead of OAuth tokens that need refreshing.
	 *
	 * @param accessToken - Temporary access token from OAuth flow
	 * @returns The newly created API key
	 * @throws {Error} If API key creation fails
	 */
	private async createAnthropicApiKey(accessToken: string): Promise<string> {
		const response = await fetch(
			"https://api.anthropic.com/api/oauth/claude_cli/create_api_key",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/x-www-form-urlencoded",
					Accept: "application/json, text/plain, */*",
				},
			},
		);

		if (!response.ok) {
			throw new Error(`Failed to create API key: ${response.statusText}`);
		}

		const json = (await response.json()) as { raw_key: string };
		return json.raw_key;
	}

	/**
	 * Creates an account with OAuth tokens (claude-oauth mode).
	 *
	 * Stores refresh token, access token, and expiration for automatic token refresh.
	 *
	 * @param id - Unique account ID
	 * @param name - Account name
	 * @param tokens - OAuth tokens from token exchange
	 * @param priority - Account priority
	 * @param customEndpoint - Custom API endpoint (optional)
	 * @returns Created account information
	 */
	private async createAccountWithOAuth(
		id: string,
		name: string,
		tokens: OAuthTokens,
		priority: number,
		customEndpoint?: string,
	): Promise<AccountCreated> {
		const adapter = this.dbOps.getAdapter();

		// Enrich identity at creation: merge the envelope identity on the OAuth
		// tokens with a live Anthropic profile fetch (fails open). First creation
		// writes the merged values directly (nothing to preserve).
		const identity = await this.resolveAnthropicIdentity(tokens);
		const now = Date.now();

		await adapter.run(
			`
			INSERT INTO accounts (
				id, name, provider, api_key, refresh_token, access_token, expires_at,
				created_at, request_count, total_requests, priority, custom_endpoint,
				refresh_token_issued_at,
				identity_external_id, identity_email, identity_organization_name,
				identity_plan_tier, identity_captured_at, identity_profile_fetched_at,
				auto_pause_on_overage_enabled
			) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
			`,
			[
				id,
				name,
				"anthropic",
				tokens.refreshToken || "",
				tokens.accessToken,
				tokens.expiresAt,
				now,
				priority,
				customEndpoint || null,
				now,
				identity.externalAccountId,
				identity.email,
				identity.organizationName,
				identity.planTier,
				identity.hasIdentity ? now : null,
				identity.profileFetchedAt,
			],
		);

		return {
			id,
			name,
			provider: "anthropic",
			authType: "oauth",
		};
	}

	/**
	 * Creates an account with API key (console mode).
	 *
	 * Stores only the API key, no OAuth tokens. These accounts don't require
	 * token refresh but cannot be refreshed if the API key is revoked.
	 *
	 * @param id - Unique account ID
	 * @param name - Account name
	 * @param apiKey - API key from Anthropic console
	 * @param tier - Account tier (1, 5, or 20)
	 * @param priority - Account priority
	 * @param customEndpoint - Custom API endpoint (optional)
	 * @returns Created account information
	 */
	private async createAccountWithApiKey(
		id: string,
		name: string,
		apiKey: string,
		priority: number,
		customEndpoint?: string,
	): Promise<AccountCreated> {
		const adapter = this.dbOps.getAdapter();

		await adapter.run(
			`
			INSERT INTO accounts (
				id, name, provider, api_key, refresh_token, access_token, expires_at,
				created_at, request_count, total_requests, priority, custom_endpoint,
				auto_pause_on_overage_enabled
			) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, 0, 0, ?, ?, 1)
			`,
			[
				id,
				name,
				"claude-console-api",
				apiKey,
				Date.now(),
				priority,
				customEndpoint || null,
			],
		);

		return {
			id,
			name,
			provider: "claude-console-api",
			authType: "api_key",
		};
	}
}

// Helper function for simpler usage
export async function createOAuthFlow(
	dbOps: DatabaseOperations,
	config: Config,
): Promise<OAuthFlow> {
	return new OAuthFlow(dbOps, config);
}
