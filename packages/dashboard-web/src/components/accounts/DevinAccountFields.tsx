import { useRef, useState } from "react";
import { api } from "../../api";
import { runGuarded } from "../../lib/submit-guard";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { AccountSetupSection } from "./AccountSetupSection";
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
	const [code, setCode] = useState("");
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
		<div className="flex flex-col gap-group">
			<AccountSetupSection title="Connect to Devin">
				<p>Sign in on Devin, then paste your login code here to connect.</p>
				<p>
					Use the models available to your Devin account. Claude requests
					default to SWE-2. If your plan doesn’t include it, select an available
					model on the Routing page.
				</p>
			</AccountSetupSection>
			<div className="flex flex-col items-start gap-group">
				<Button
					type="button"
					variant="outline"
					disabled={busy}
					onClick={() =>
						run(async () => {
							if (!name.trim()) throw new Error("Enter an account name first");
							setLogin(await api.startDevinLogin({ name, priority }));
							setCode("");
						})
					}
				>
					Sign in with Devin
				</Button>
				{login && (
					<div className="flex w-full min-w-0 flex-col gap-row rounded-lg border bg-muted/30 p-group">
						<AuthorizationHandoff url={login.authUrl} />
						<p
							id="devin-code-help"
							className="text-sm leading-relaxed text-muted-foreground"
						>
							After signing in, Devin shows “Copy your login code”. Copy that
							code and paste it here. The code expires after 5 minutes. Finish
							this sign-in within 10 minutes of generating the link.
						</p>
						<div className="flex flex-col gap-item">
							<Label htmlFor="devin-code">Login code</Label>
							<Input
								id="devin-code"
								type="password"
								autoComplete="off"
								autoCorrect="off"
								autoCapitalize="none"
								spellCheck={false}
								disabled={busy}
								aria-describedby="devin-code-help"
								value={code}
								onChange={(event) => setCode(event.target.value)}
							/>
						</div>
						<Button
							className="self-start"
							type="button"
							disabled={busy || !code.trim()}
							onClick={() =>
								run(async () => {
									const pending = login;
									setLogin(null);
									setCode("");
									await api.completeDevinLogin({
										sessionId: pending.sessionId,
										code: code.trim(),
									});
									onSuccess();
								})
							}
						>
							Complete Devin sign-in
						</Button>
					</div>
				)}
			</div>
			<div className="flex items-center gap-row" aria-hidden="true">
				<div className="h-px flex-1 bg-border" />
				<span className="text-xs text-muted-foreground">or import a token</span>
				<div className="h-px flex-1 bg-border" />
			</div>
			<div className="flex flex-col items-start gap-row">
				<div className="flex w-full flex-col gap-item">
					<Label htmlFor="devin-token">Devin session token</Label>
					<Input
						id="devin-token"
						aria-describedby="devin-token-help"
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
					<p
						id="devin-token-help"
						className="text-xs leading-relaxed text-muted-foreground"
					>
						Use a Devin CLI session token, not a cloud API key. Continue
						verifies the token and adds your account.
					</p>
				</div>
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
			</div>
			{catalog?.token === token && (
				<div
					className="flex flex-col gap-row rounded-lg border bg-muted/30 p-group"
					role="status"
				>
					<p className="text-sm">
						Plan: {catalog.data.usage.planName || "Unknown"}
						{catalog.data.usage.canUseCli === false
							? " (CLI access unavailable)"
							: ""}
					</p>
					<p className="text-sm leading-relaxed text-muted-foreground">
						After adding the account, use the Routing page to choose which model
						requests use. Its Permitted Models menu manages model access.
					</p>
					<ul
						className="max-h-48 divide-y overflow-auto text-sm"
						aria-label="Discovered Devin models"
					>
						{catalog.data.models.map((model) => (
							<li
								key={model.id}
								className="flex min-w-0 flex-col gap-1 py-item first:pt-0 last:pb-0"
							>
								<span className="font-medium">{model.name}</span>
								<code className="break-all text-xs text-muted-foreground">
									{model.id}
								</code>
								{model.disabled && (
									<span className="text-xs text-muted-foreground">
										{model.disabledReason || "Unavailable"}
									</span>
								)}
							</li>
						))}
					</ul>
				</div>
			)}
			<div className="flex flex-col gap-item rounded-lg border bg-muted/30 p-group">
				<p className="text-sm font-medium">Included quota protection is on</p>
				<p className="text-sm leading-relaxed text-muted-foreground">
					Requests pause when included usage is exhausted or unknown. Daily and
					weekly allowances are shared with Devin CLI, Desktop, and cloud.
				</p>
				<details className="text-xs leading-relaxed text-muted-foreground">
					<summary className="w-fit cursor-pointer rounded-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
						Quota and prepaid credits
					</summary>
					<p className="mt-item">
						The account menu offers “Allow requests beyond verified included
						quota” to override this protection. This may consume prepaid
						credits. Keep prepaid overage disabled in Devin to avoid spending
						beyond your subscription.
					</p>
				</details>
			</div>
		</div>
	);
}
