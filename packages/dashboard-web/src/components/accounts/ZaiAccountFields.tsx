import { useRef, useState } from "react";
import { api } from "../../api";
import { runGuarded } from "../../lib/submit-guard";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { AccountSetupSection } from "./AccountSetupSection";
import { AuthorizationHandoff } from "./AuthorizationHandoff";

export function ZaiAccountFields({
	name,
	priority,
	apiKey,
	onApiKeyChange,
	onSuccess,
	onError,
}: {
	name: string;
	priority: number;
	apiKey: string;
	onApiKeyChange: (value: string) => void;
	onSuccess: () => void;
	onError: (message: string) => void;
}) {
	const [login, setLogin] = useState<{
		sessionId: string;
		authUrl: string;
	} | null>(null);
	const [redirectUrl, setRedirectUrl] = useState("");
	const latch = useRef(false);
	const [busy, setBusy] = useState(false);
	const run = (fn: () => Promise<void>) =>
		runGuarded(latch, setBusy, async () => {
			try {
				await fn();
			} catch (error) {
				onError(
					error instanceof Error ? error.message : "Z.AI account setup failed",
				);
			}
		});
	return (
		<div className="flex flex-col gap-group">
			<AccountSetupSection title="Connect to z.ai">
				<p>
					Sign in on z.ai with your subscription, then paste the redirect URL
					here. A dedicated API key is created on your account and used for
					every request.
				</p>
			</AccountSetupSection>
			<div className="flex flex-col items-start gap-group">
				<Button
					type="button"
					variant="outline"
					disabled={busy || !name.trim()}
					onClick={() =>
						run(async () => {
							setLogin(await api.startZaiLogin({ name, priority }));
							setRedirectUrl("");
						})
					}
				>
					Sign in with Z.AI
				</Button>
				{login && (
					<div className="flex w-full min-w-0 flex-col gap-row rounded-lg border bg-muted/30 p-group">
						<AuthorizationHandoff url={login.authUrl} />
						<p
							id="zai-redirect-help"
							className="text-sm leading-relaxed text-muted-foreground"
						>
							After signing in, the browser is sent to a localhost:54548 address
							it cannot load. That failed page is the result: copy its whole URL
							out of the address bar and paste it below. The whole URL is
							needed, not just the code. Finish this sign-in within 10 minutes
							of generating the link.
						</p>
						<div className="flex flex-col gap-item">
							<Label htmlFor="zai-redirect">Redirect URL</Label>
							<Input
								id="zai-redirect"
								type="password"
								autoComplete="off"
								autoCorrect="off"
								autoCapitalize="none"
								spellCheck={false}
								disabled={busy}
								aria-describedby="zai-redirect-help"
								value={redirectUrl}
								onChange={(event) => setRedirectUrl(event.target.value)}
							/>
						</div>
						<Button
							className="self-start"
							type="button"
							disabled={busy || !redirectUrl.trim()}
							onClick={() =>
								run(async () => {
									const pending = login;
									const code = redirectUrl.trim();
									// Single use: a failed exchange needs a new sign-in.
									setLogin(null);
									setRedirectUrl("");
									await api.completeZaiLogin({
										sessionId: pending.sessionId,
										code,
									});
									onSuccess();
								})
							}
						>
							Complete Z.AI sign-in
						</Button>
					</div>
				)}
			</div>
			<div className="flex items-center gap-row" aria-hidden="true">
				<div className="h-px flex-1 bg-border" />
				<span className="text-xs text-muted-foreground">
					or paste an API key
				</span>
				<div className="h-px flex-1 bg-border" />
			</div>
			<div className="flex flex-col gap-item">
				<Label htmlFor="apiKey">z.ai API Key</Label>
				<Input
					id="apiKey"
					type="password"
					value={apiKey}
					onChange={(event) => onApiKeyChange(event.target.value)}
					placeholder="Enter your z.ai API key"
				/>
			</div>
		</div>
	);
}
