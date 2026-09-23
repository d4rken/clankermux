import { HttpError } from "@clankermux/http-common";
import {
	type QueryClient,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { type AuthStatus, api, onUnauthorized } from "../api";
import { queryKeys } from "../lib/query-keys";

/**
 * How often the gate re-checks its own state.
 *
 * Not a security control — the server rejects a dead session on every request
 * regardless. This exists so an operator who runs the password CLI in a
 * terminal sees the dashboard react within a minute instead of on their next
 * click: the setup screen gives way to the sign-in screen once a password is
 * set, and the sign-in screen gives way to the setup screen once it is cleared.
 */
const AUTH_STATUS_POLL_MS = 60_000;

/**
 * The management login, as the dashboard sees it.
 *
 * `GET /api/auth/status` is public by policy, so it answers even when nothing
 * else will — which is exactly what makes it usable as the gate's own probe.
 * Any 401 from any other call feeds back in here through {@link onUnauthorized}
 * and forces a re-read, so a session that expires mid-session flips the app to
 * the login screen instead of leaving a page of unrelated error states.
 */
export function useAuthStatus() {
	const queryClient = useQueryClient();

	const query = useQuery<AuthStatus>({
		queryKey: queryKeys.authStatus(),
		queryFn: () => api.getAuthStatus(),
		refetchInterval: AUTH_STATUS_POLL_MS,
		staleTime: 0,
		// A failing status probe must not be retried into a long stall: the gate
		// blocks the whole app on it.
		retry: false,
	});

	useEffect(
		() =>
			onUnauthorized(() => {
				void queryClient.invalidateQueries({
					queryKey: queryKeys.authStatus(),
				});
			}),
		[queryClient],
	);

	return query;
}

/**
 * A 409 from login or setup means the server's password state is not the one
 * the gate last read: a password was set (or cleared) since. Re-reading the
 * status lets the gate swap to the screen that matches.
 */
function rereadStatusOnConflict(queryClient: QueryClient, error: unknown) {
	if (error instanceof HttpError && error.status === 409) {
		void queryClient.invalidateQueries({ queryKey: queryKeys.authStatus() });
	}
}

/** Sign in, then let every query re-run against the new session. */
export function useLogin() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (password: string) => api.login(password),
		onSuccess: async () => {
			await queryClient.invalidateQueries();
		},
		onError: (error) => rereadStatusOnConflict(queryClient, error),
	});
}

/**
 * Claim the first management password with the server's setup code. Success
 * signs the browser in, so every query re-runs exactly as after a login.
 */
export function useSetupPassword() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ code, password }: { code: string; password: string }) =>
			api.setupPassword(code, password),
		onSuccess: async () => {
			await queryClient.invalidateQueries();
		},
		onError: (error) => rereadStatusOnConflict(queryClient, error),
	});
}

/**
 * Sign out.
 *
 * The cache is CLEARED rather than invalidated: invalidating would immediately
 * refetch every management query with no session and paint the login screen
 * behind a wall of 401s.
 */
export function useLogout() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => api.logout(),
		onSettled: async () => {
			queryClient.clear();
			await queryClient.invalidateQueries({
				queryKey: queryKeys.authStatus(),
			});
		},
	});
}
