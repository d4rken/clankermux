import type { ReactNode } from "react";
import { useAuthStatus } from "../hooks/useAuthStatus";
import { LoginScreen } from "./LoginScreen";
import { SetupScreen } from "./SetupScreen";

/**
 * Decides whether the app runs at all.
 *
 * MUST sit OUTSIDE `RequestEventProvider`. That provider opens
 * `/api/requests/stream` and fires a protected backfill query the moment it
 * mounts, so a gate rendered inside it would already have made those calls
 * before deciding the browser is signed out — an `EventSource` retry loop
 * against a 401 behind a login form.
 *
 * Three states, and the app runs in only one of them:
 *
 *  - `configured: false` — no password exists yet. The setup screen, INSTEAD
 *    of the app, with no way to skip it: the operator claims the first
 *    password with the one-time code the server printed, and is signed in.
 *  - `configured: true, authenticated: false` — the login screen, INSTEAD of
 *    the app.
 *  - `configured: true, authenticated: true` — the app.
 *
 * While the probe is in flight nothing is rendered. Rendering the app
 * optimistically would open the stream before the answer arrives, which is the
 * exact failure this component exists to prevent; rendering the login screen
 * optimistically would flash it at every operator on every reload.
 */
export function AuthGate({ children }: { children: ReactNode }) {
	const { data, isPending, isError } = useAuthStatus();

	if (isPending) {
		return <div className="min-h-screen bg-background" aria-busy="true" />;
	}

	// The probe itself failed — the server is down or unreachable, which is not
	// the same as being signed out. Render the app: its own panels report the
	// outage in the places an operator is already looking, and a login screen
	// here would blame the operator for a server problem.
	if (isError || !data) {
		return <>{children}</>;
	}

	if (!data.configured) {
		return <SetupScreen />;
	}

	if (!data.authenticated) {
		return <LoginScreen />;
	}

	return <>{children}</>;
}
