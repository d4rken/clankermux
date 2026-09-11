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
	onModelChange,
	onSuccess,
	onError,
}: {
	name: string;
	priority: number;
	token: string;
	onTokenChange: (value: string) => void;
	onModelChange: (value: string) => void;
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
					onModelChange("");
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
					<Label htmlFor="devin-model">Model for Claude requests</Label>
					<select
						id="devin-model"
						className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
						defaultValue=""
						onChange={(event) => onModelChange(event.target.value)}
					>
						<option value="">SWE-2 (account default)</option>
						{catalog.data.models.map((model) => (
							<option key={model.id} value={model.id} disabled={model.disabled}>
								{model.name}
								{model.disabled
									? ` (${model.disabledReason || "unavailable"})`
									: ""}
							</option>
						))}
					</select>
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
