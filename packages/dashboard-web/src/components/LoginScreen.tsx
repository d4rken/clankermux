import { HttpError } from "@clankermux/http-common";
import { type FormEvent, useState } from "react";
import { useLogin } from "../hooks/useAuthStatus";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

function messageFor(error: unknown): string {
	if (error instanceof HttpError) {
		if (error.status === 401) return "That password is not correct.";
		if (error.status === 429) {
			return "Too many attempts. Wait a moment and try again.";
		}
		if (error.status === 409) {
			return "No management password is configured on the server.";
		}
		return error.message;
	}
	return error instanceof Error ? error.message : "Could not sign in.";
}

/**
 * The sign-in screen.
 *
 * Rendered INSTEAD of the app, never over it: the components behind it open an
 * `EventSource` and fire protected queries on mount, so overlaying a modal
 * would leave a signed-out browser hammering endpoints that can only answer
 * 401.
 *
 * There is no "forgot password" flow and no reset link on purpose. Recovery is
 * `bun run auth:password --clear` on the machine that owns the database —
 * anything reachable over HTTP would be reachable by whoever the password is
 * keeping out.
 */
export function LoginScreen() {
	const [password, setPassword] = useState("");
	const login = useLogin();

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!password || login.isPending) return;
		login.mutate(password);
	};

	return (
		<div className="min-h-screen bg-background flex items-center justify-center p-6">
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle>Sign in</CardTitle>
				</CardHeader>
				<CardContent>
					<form onSubmit={submit} className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="management-password">Management password</Label>
							<Input
								id="management-password"
								type="password"
								autoComplete="current-password"
								// The operator's cursor should already be here: this screen
								// exists for exactly one input.
								autoFocus
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								disabled={login.isPending}
							/>
						</div>

						{login.isError ? (
							<p role="alert" className="text-sm text-destructive">
								{messageFor(login.error)}
							</p>
						) : null}

						<Button
							type="submit"
							className="w-full"
							disabled={login.isPending || password.length === 0}
						>
							{login.isPending ? "Signing in…" : "Sign in"}
						</Button>
					</form>

					<p className="mt-4 text-xs text-muted-foreground">
						Lost the password? Clear it on the server with{" "}
						<code className="font-mono">bun run auth:password --clear</code>.
					</p>
				</CardContent>
			</Card>
		</div>
	);
}
