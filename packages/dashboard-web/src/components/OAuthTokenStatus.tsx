import { AlertTriangle, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import {
	fetchAccountTokenStatus,
	OAUTH_TOKEN_STATUS_RETRY_MS,
	resolveTokenChip,
	type TokenStatus,
	tokenStatusTooltip,
} from "../lib/oauth-token-status";
import { StatusChip } from "./accounts/StatusChip";
import { APIErrorBoundary } from "./ErrorBoundary";

interface OAuthTokenStatusProps {
	accountName: string;
	hasRefreshToken: boolean;
	provider?: string; // Optional for backward compatibility
}

export function OAuthTokenStatus({
	accountName,
	hasRefreshToken,
}: Omit<OAuthTokenStatusProps, "provider">) {
	const [status, setStatus] = useState<TokenStatus>("loading");
	const [message, setMessage] = useState("Loading...");

	useEffect(() => {
		if (!hasRefreshToken) {
			// Non-OAuth accounts don't support token-health monitoring.
			setStatus("no-refresh-token");
			setMessage("This account type doesn't support token health monitoring");
			return;
		}

		let cancelled = false;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;

		// Try the per-account endpoint, then the global fallback. On total
		// failure, land on a static "unavailable" indicator and re-check on a
		// bounded interval so the indicator self-heals when the backend recovers
		// — without ever flashing the loading spinner again.
		const attempt = async () => {
			if (cancelled) return;

			const result = await fetchAccountTokenStatus({
				accountName,
				getAccountHealth: (name) => api.getAccountTokenHealth(name),
				getGlobalHealth: () => api.getTokenHealth(),
			});
			if (cancelled) return;

			if (result) {
				setStatus(result.status);
				setMessage(result.message);
			} else {
				setStatus("error");
				setMessage("Token status unavailable — retrying…");
				retryTimer = setTimeout(attempt, OAUTH_TOKEN_STATUS_RETRY_MS);
			}
		};

		void attempt();

		return () => {
			cancelled = true;
			if (retryTimer !== undefined) {
				clearTimeout(retryTimer);
			}
		};
	}, [accountName, hasRefreshToken]);

	// A chip only renders for actionable problems (expiring/expired). Healthy,
	// loading, error, and non-OAuth states resolve to null — the boring default
	// gets no chip at all.
	const chip = resolveTokenChip(status);
	if (!hasRefreshToken || !chip) {
		return null;
	}
	const Icon = chip.icon === "critical" ? XCircle : AlertTriangle;

	return (
		<StatusChip
			className={chip.className}
			title={tokenStatusTooltip(status, accountName, message)}
		>
			<Icon className="h-3.5 w-3.5" />
			{chip.label}
		</StatusChip>
	);
}

/**
 * Wrapped OAuthTokenStatus with error boundary protection
 */
export function OAuthTokenStatusWithBoundary(props: OAuthTokenStatusProps) {
	return (
		<APIErrorBoundary>
			<OAuthTokenStatus {...props} />
		</APIErrorBoundary>
	);
}
