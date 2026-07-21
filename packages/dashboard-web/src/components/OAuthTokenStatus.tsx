import { AlertTriangle, CheckCircle, RefreshCw, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import {
	fetchAccountTokenStatus,
	OAUTH_TOKEN_STATUS_RETRY_MS,
	resolveTokenStatusDisplay,
	type TokenStatus,
	tokenStatusTooltip,
} from "../lib/oauth-token-status";
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

	// Don't show anything for non-OAuth accounts.
	if (!hasRefreshToken) {
		return null;
	}

	const display = resolveTokenStatusDisplay(status);
	const tone = {
		green: "text-green-600",
		yellow: "text-yellow-600",
		red: "text-red-600",
		muted: "text-gray-400",
	}[display.tone];
	const className = `h-4 w-4 ${tone}${display.spin ? " animate-spin" : ""}`;

	const icon = (() => {
		switch (display.icon) {
			case "healthy":
				return <CheckCircle className={className} />;
			case "warning":
				return <AlertTriangle className={className} />;
			case "critical":
				return <XCircle className={className} />;
			case "loading":
				return <RefreshCw className={className} />;
			default:
				// "unavailable": static muted triangle, never a spinner.
				return <AlertTriangle className={className} />;
		}
	})();

	return (
		<span
			className="inline-flex items-center ml-2"
			title={tokenStatusTooltip(status, accountName, message)}
		>
			{icon}
		</span>
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
