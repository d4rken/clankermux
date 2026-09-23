import { HttpError } from "@clankermux/http-common";
import { MAX_PASSWORD_BYTES, MIN_PASSWORD_LENGTH } from "@clankermux/types";
import { type FormEvent, useState } from "react";
import { useSetupPassword } from "../hooks/useAuthStatus";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

function messageFor(error: unknown): string {
	if (error instanceof HttpError) {
		if (error.status === 403) {
			return "That setup code is not valid. Use the most recent code printed in the server output.";
		}
		if (error.status === 409) {
			return "A password has already been set. Sign in with it.";
		}
		if (error.status === 429) {
			return "Too many attempts. Wait a moment and try again.";
		}
		return error.message;
	}
	return error instanceof Error ? error.message : "Could not set the password.";
}

/**
 * The same limits the server enforces, checked here so an obviously refused
 * password never spends one of the rate-limited setup attempts.
 */
function localProblem(password: string, repeat: string): string | null {
	if (password.length < MIN_PASSWORD_LENGTH) {
		return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
	}
	if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) {
		return `Password must be at most ${MAX_PASSWORD_BYTES} bytes (UTF-8).`;
	}
	if (password !== repeat) {
		return "The two passwords do not match.";
	}
	return null;
}

/**
 * The first-run screen: no management password exists yet.
 *
 * Rendered INSTEAD of the app, never over it, for the same reason as the
 * sign-in screen: the components behind it open an `EventSource` and fire
 * protected queries on mount.
 *
 * Deliberately has no way past it. The setup code is printed only to the
 * server's own output, so entering it proves the caller can read that output —
 * i.e. operates the machine — rather than merely reaching the port first.
 */
export function SetupScreen() {
	const [code, setCode] = useState("");
	const [password, setPassword] = useState("");
	const [repeat, setRepeat] = useState("");
	const [problem, setProblem] = useState<string | null>(null);
	const setup = useSetupPassword();

	const complete = code.length > 0 && password.length > 0 && repeat.length > 0;

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!complete || setup.isPending) return;
		const found = localProblem(password, repeat);
		setProblem(found);
		if (found) return;
		setup.mutate({ code, password });
	};

	const message = problem ?? (setup.isError ? messageFor(setup.error) : null);

	return (
		<div className="min-h-screen bg-background flex items-center justify-center p-6">
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle>Set a management password</CardTitle>
				</CardHeader>
				<CardContent>
					<p className="mb-4 text-sm text-muted-foreground">
						No management password is set yet. Enter the one-time setup code
						printed in the server's output (for example{" "}
						<code className="font-mono">journalctl -u clankermux</code> or{" "}
						<code className="font-mono">docker logs &lt;container&gt;</code>).
						Restarting the server prints a new code.
					</p>

					<form onSubmit={submit} className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="setup-code">Setup code</Label>
							<Input
								id="setup-code"
								type="text"
								autoComplete="one-time-code"
								autoCapitalize="characters"
								spellCheck={false}
								autoFocus
								value={code}
								onChange={(event) => setCode(event.target.value)}
								disabled={setup.isPending}
							/>
						</div>

						<div className="space-y-2">
							<Label htmlFor="setup-password">New password</Label>
							<Input
								id="setup-password"
								type="password"
								autoComplete="new-password"
								value={password}
								onChange={(event) => {
									setPassword(event.target.value);
									setProblem(null);
								}}
								disabled={setup.isPending}
							/>
						</div>

						<div className="space-y-2">
							<Label htmlFor="setup-password-repeat">Repeat password</Label>
							<Input
								id="setup-password-repeat"
								type="password"
								autoComplete="new-password"
								value={repeat}
								onChange={(event) => {
									setRepeat(event.target.value);
									setProblem(null);
								}}
								disabled={setup.isPending}
							/>
						</div>

						{message ? (
							<p role="alert" className="text-sm text-destructive">
								{message}
							</p>
						) : null}

						<Button
							type="submit"
							className="w-full"
							disabled={setup.isPending || !complete}
						>
							{setup.isPending ? "Setting password…" : "Set password"}
						</Button>
					</form>

					<p className="mt-4 text-xs text-muted-foreground">
						Prefer the shell? Run{" "}
						<code className="font-mono">
							clankermux-server auth password --set
						</code>{" "}
						on the server (or{" "}
						<code className="font-mono">bun run auth:password --set</code> from
						a source checkout).
					</p>
				</CardContent>
			</Card>
		</div>
	);
}
