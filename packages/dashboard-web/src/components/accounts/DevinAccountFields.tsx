import { useRef, useState } from "react";
import { api } from "../../api";
import { runGuarded } from "../../lib/submit-guard";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { AuthorizationHandoff } from "./AuthorizationHandoff";

type Models = Awaited<ReturnType<typeof api.discoverDevinModels>>;
export function DevinAccountFields({
	name,
	priority,
	token,
	onTokenChange,
	onSuccess,
	onError,
}: {
	name: string;
	priority: number;
	token: string;
	onTokenChange: (value: string) => void;
	onSuccess: () => void;
	onError: (message: string) => void;
}) {
	const [login, setLogin] = useState<{
		sessionId: string;
		authUrl: string;
	} | null>(null);
	const [callback, setCallback] = useState("");
	const [catalog, setCatalog] = useState<{
		token: string;
		data: Models;
	} | null>(null);
	const latch = useRef(false);
	const [busy, setBusy] = useState(false);
	const latestToken = useRef(token);
	latestToken.current = token;
	const run = (fn: () => Promise<void>) =>
		runGuarded(latch, setBusy, async () => {
			try {
				await fn();
			} catch (error) {
				onError(
					error instanceof Error ? error.message : "Devin account setup failed",
				);
			}
		});
	return (
		<div className="space-y-item">
			<p className="text-sm text-muted-foreground">
				Connect your Devin account to use SWE-2. Access depends on your plan.
				Daily and weekly allowances are shared with Devin CLI, Desktop, and
				cloud.
			</p>
			<Button
				type="button"
				variant="outline"
				disabled={busy}
				onClick={() =>
					run(async () => {
						if (!name.trim()) throw new Error("Enter an account name first");
						setLogin(await api.startDevinLogin({ name, priority }));
						setCallback("");
					})
				}
			>
				Sign in with Devin
			</Button>
			{login && (
				<div className="space-y-item">
					<AuthorizationHandoff url={login.authUrl} />
					<p className="text-sm text-muted-foreground">
						After signing in, copy the full localhost callback URL from the
						browser address bar and paste it here, even if the page cannot
						connect. The link expires after 10 minutes.
					</p>
					<Label htmlFor="devin-callback">Callback URL</Label>
					<Input
						id="devin-callback"
						type="password"
						autoComplete="off"
						value={callback}
						onChange={(event) => setCallback(event.target.value)}
					/>
					<Button
						type="button"
						disabled={busy || !callback}
						onClick={() =>
							run(async () => {
								const pending = login;
								setLogin(null);
								setCallback("");
								await api.completeDevinLogin({
									sessionId: pending.sessionId,
									callback,
								});
								onSuccess();
							})
						}
					>
						Complete Devin sign-in
					</Button>
				</div>
			)}
			<Label htmlFor="devin-token">Or import a Devin session token</Label>
			<Input
				id="devin-token"
				type="password"
				autoComplete="off"
				spellCheck={false}
				value={token}
				onChange={(event) => {
					setCatalog(null);
					onTokenChange(event.target.value);
				}}
				placeholder="Devin CLI session token"
			/>
			<p className="text-sm text-muted-foreground">
				Use a CLI session token, not a Devin cloud API key. The Continue button
				verifies the token before adding the account.
			</p>
			<Button
				type="button"
				variant="outline"
				disabled={busy || !token.trim()}
				onClick={() =>
					run(async () => {
						const source = token;
						const data = await api.discoverDevinModels(source.trim());
						if (latestToken.current === source)
							setCatalog({ token: source, data });
					})
				}
			>
				Check access and models
			</Button>
			{catalog?.token === token && (
				<div className="space-y-item">
					<p className="text-sm">
						Plan: {catalog.data.usage.planName || "Unknown"}
						{catalog.data.usage.canUseCli === false
							? " — CLI access is unavailable"
							: ""}
					</p>
					<p className="text-sm text-muted-foreground">
						After adding the account, use the Routing page to choose which model
						requests use. Its Permitted Models menu manages model access.
					</p>
					<ul
						className="max-h-40 overflow-auto space-y-tight text-sm"
						aria-label="Discovered Devin models"
					>
						{catalog.data.models.map((model) => (
							<li key={model.id}>
								{model.name}{" "}
								<code className="text-xs text-muted-foreground">
									{model.id}
								</code>
								{model.disabled
									? ` (${model.disabledReason || "unavailable"})`
									: ""}
							</li>
						))}
					</ul>
				</div>
			)}
			<p className="text-sm text-muted-foreground">
				Included quota protection starts enabled. Requests pause when reported
				included usage is exhausted or unknown. After adding the account, its
				menu offers “Allow requests beyond verified included quota” to override
				this protection. That may consume prepaid credits. Keep prepaid overage
				disabled in Devin to avoid spending beyond your subscription.
			</p>
		</div>
	);
}
