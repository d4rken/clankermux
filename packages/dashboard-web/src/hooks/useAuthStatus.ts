import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { type AuthStatus, api, onUnauthorized } from "../api";
import { queryKeys } from "../lib/query-keys";

/**
 * How often the gate re-checks its own state.
 *
 * Not a security control — the server rejects a dead session on every request
 * regardless. This exists so an operator who runs the password CLI in a
 * terminal sees the dashboard react within a minute instead of on their next
 * click, and so the "unprotected" banner disappears once they have protected it.
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

/** Sign in, then let every query re-run against the new session. */
export function useLogin() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (password: string) => api.login(password),
		onSuccess: async () => {
			await queryClient.invalidateQueries();
		},
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
