/**
 * Pure helpers behind the per-account OAuth token-health indicator
 * (`OAuthTokenStatus.tsx`). The dashboard test harness renders with
 * `renderToStaticMarkup` and cannot run effects or timers, so all of the
 * decision logic lives here as pure functions that can be unit tested directly.
 */

/** Health states a token indicator can be in. */
export type TokenStatus =
	| "healthy"
	| "warning"
	| "critical"
	| "expired"
	| "no-refresh-token"
	| "loading"
	| "error";

/**
 * How often to re-check a failed/unknown token status in the background so the
 * indicator self-heals once the backend recovers — no page refresh needed.
 */
export const OAUTH_TOKEN_STATUS_RETRY_MS = 30_000;

/** Visual mapping for a token status: which icon, whether it spins, and tone. */
export interface TokenStatusDisplay {
	icon: "healthy" | "warning" | "critical" | "loading" | "unavailable";
	spin: boolean;
	tone: "green" | "yellow" | "red" | "muted";
}

/**
 * Map a token status to its visual representation. Pure.
 *
 * Key invariant (the stuck-spinner fix): `loading` is the ONLY spinning state.
 * A terminal `error` — and any unknown/unexpected status — renders as a STATIC
 * muted "unavailable" icon, never an infinitely spinning refresh icon that
 * masquerades as loading.
 */
export function resolveTokenStatusDisplay(
	status: TokenStatus,
): TokenStatusDisplay {
	switch (status) {
		case "healthy":
			return { icon: "healthy", spin: false, tone: "green" };
		case "warning":
			return { icon: "warning", spin: false, tone: "yellow" };
		case "critical":
		case "expired":
			return { icon: "critical", spin: false, tone: "red" };
		case "loading":
			return { icon: "loading", spin: true, tone: "muted" };
		default:
			// `error`, `no-refresh-token`, and any unexpected value: static,
			// non-spinning, muted "unavailable" icon.
			return { icon: "unavailable", spin: false, tone: "muted" };
	}
}

/**
 * Human-readable tooltip for a token status. Pure. The unavailable/error case
 * reads as "unavailable — retrying…" to honestly convey that the indicator is
 * in a background-retry loop rather than stuck loading.
 */
export function tokenStatusTooltip(
	status: TokenStatus,
	accountName: string,
	message: string,
): string {
	switch (status) {
		case "healthy":
			return "OAuth token available";
		case "warning":
			return `OAuth token expiring soon - ${message}`;
		case "critical":
		case "expired":
			return `OAuth token expired - ${message} - Re-authenticate account "${accountName}" from the dashboard (Accounts tab).`;
		case "loading":
			return "Checking OAuth token status...";
		default:
			return "OAuth token status unavailable — retrying…";
	}
}

/** Visual config for the OAuth token chip, or null when nothing actionable. */
export interface TokenChip {
	label: string;
	/** Tailwind color-pair className for the StatusChip. */
	className: string;
	/** Which lucide icon the chip should show. */
	icon: "warning" | "critical";
}

/**
 * Map a token status to a chip, or null when no chip should render. Healthy,
 * loading, error, and non-OAuth (no-refresh-token) states return null — a
 * working (or merely unknown/transient) token is the boring default and gets
 * no chip. Only an expiring or expired/critical token is surfaced, since those
 * need the user to re-authenticate. Pure.
 */
export function resolveTokenChip(status: TokenStatus): TokenChip | null {
	switch (status) {
		case "warning":
			return {
				label: "Token expiring",
				className:
					"bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
				icon: "warning",
			};
		case "critical":
		case "expired":
			return {
				label: "Token expired",
				className:
					"bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
				icon: "critical",
			};
		default:
			// healthy, loading, error, no-refresh-token, and any unexpected value:
			// no chip.
			return null;
	}
}

/** Shape of the per-account token-health payload (from either endpoint). */
interface AccountHealthEntry {
	accountName: string;
	status: TokenStatus;
	message: string;
}

/** Injected data sources so this orchestration is testable without `api`. */
export interface FetchAccountTokenStatusDeps {
	accountName: string;
	/** Per-account endpoint (`api.getAccountTokenHealth`). */
	getAccountHealth: (
		name: string,
	) => Promise<{ success?: boolean; data?: AccountHealthEntry } | null>;
	/** Global endpoint fallback (`api.getTokenHealth`). */
	getGlobalHealth: () => Promise<{
		success?: boolean;
		data?: { accounts?: AccountHealthEntry[] };
	} | null>;
}

/**
 * Resolve a single account's token status: try the per-account endpoint first,
 * then fall back to the global endpoint. Returns the resolved `{status,message}`
 * or `null` when BOTH sources fail or don't cover this account. Pure with
 * respect to its injected deps — no direct `api` import.
 */
export async function fetchAccountTokenStatus(
	deps: FetchAccountTokenStatusDeps,
): Promise<{ status: TokenStatus; message: string } | null> {
	const { accountName, getAccountHealth, getGlobalHealth } = deps;

	// Primary: per-account endpoint.
	try {
		const response = await getAccountHealth(accountName);
		if (response?.success && response.data) {
			return { status: response.data.status, message: response.data.message };
		}
	} catch {
		// fall through to the global endpoint
	}

	// Fallback: global endpoint, find this account in the list.
	try {
		const globalResponse = await getGlobalHealth();
		if (globalResponse?.success && globalResponse.data?.accounts) {
			const accountData = globalResponse.data.accounts.find(
				(acc) => acc.accountName === accountName,
			);
			if (accountData) {
				return { status: accountData.status, message: accountData.message };
			}
		}
	} catch {
		// both sources failed
	}

	return null;
}
