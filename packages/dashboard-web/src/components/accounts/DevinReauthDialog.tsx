import { useEffect, useRef, useState } from "react";
import { type Account, api } from "../../api";
import { runGuarded } from "../../lib/submit-guard";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { AccountIdentityPanel } from "./AccountIdentity";
import { AuthorizationHandoff } from "./AuthorizationHandoff";

interface DevinReauthDialogProps {
	account: Account | null;
	isOpen: boolean;
	onClose: () => void;
	onSuccess: () => void;
}

export function DevinReauthDialog({
	account,
	isOpen,
	...callbacks
}: DevinReauthDialogProps) {
	// Each opening/account gets its own state and pending-request lifetime.
	return isOpen && account ? (
		<DevinReauthSession key={account.id} account={account} {...callbacks} />
	) : null;
}

function DevinReauthSession({
	account,
	onClose,
	onSuccess,
}: Omit<DevinReauthDialogProps, "isOpen" | "account"> & { account: Account }) {
	const [login, setLogin] = useState<Awaited<
		ReturnType<typeof api.startDevinReauth>
	> | null>(null);
	const [code, setCode] = useState("");
	const [token, setToken] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const latch = useRef(false);
	const active = useRef(true);
	useEffect(() => {
		active.current = true;
		return () => {
			active.current = false;
		};
	}, []);
	const clear = () => {
		setLogin(null);
		setCode("");
		setToken("");
		setError("");
	};
	const close = () => {
		active.current = false;
		clear();
		onClose();
	};
	const success = () => {
		if (!active.current) return;
		clear();
		active.current = false;
		onSuccess();
		onClose();
	};
	const run = (work: () => Promise<void>) => {
		if (!active.current) return;
		return runGuarded(
			latch,
			(value) => {
				if (active.current) setBusy(value);
			},
			async () => {
				setError("");
				try {
					await work();
				} catch (failure) {
					if (active.current)
						setError(
							failure instanceof Error
								? failure.message
								: "Devin reconnect failed",
						);
				}
			},
		);
	};
	const complete = () => {
		if (!login || !code.trim()) return;
		return run(async () => {
			const data = { sessionId: login.sessionId, code: code.trim() };
			// A login code is single use; failures require a new browser sign-in.
			setLogin(null);
			setCode("");
			setToken("");
			await api.completeDevinReauth(data);
			success();
		});
	};
	const expiresAt = account.tokenExpiresAt
		? Date.parse(account.tokenExpiresAt)
		: Number.NaN;
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) close();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Reconnect Devin Account</DialogTitle>
					<DialogDescription asChild>
						<div className="space-y-item">
							<AccountIdentityPanel account={account} />
							<span className="block">
								Sign in to the same Devin account, then paste your login code
								here. Usage history, priority, and settings will be preserved.
							</span>
							{Number.isFinite(expiresAt) && (
								<span className="block">
									{expiresAt <= Date.now()
										? "Session expired"
										: "Session expires"}
									: {new Date(expiresAt).toLocaleString()}
								</span>
							)}
						</div>
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-group py-group">
					<Button
						type="button"
						variant="outline"
						disabled={busy}
						onClick={() =>
							run(async () => {
								setLogin(null);
								setCode("");
								setToken("");
								const result = await api.startDevinReauth({
									accountId: account.id,
								});
								if (active.current) setLogin(result);
							})
						}
					>
						{login ? "Generate a new sign-in link" : "Sign in with Devin"}
					</Button>
					{login && (
						<div className="space-y-item">
							<AuthorizationHandoff url={login.authUrl} />
							<p
								id="devin-reauth-code-help"
								className="text-sm text-muted-foreground"
							>
								Open the link in a browser signed in to this account. Devin
								shows “Copy your login code”. Copy that code and paste it here.
								The code expires after 5 minutes.
							</p>
							<p className="text-sm text-muted-foreground">
								Finish this sign-in by:{" "}
								{new Date(login.expiresAt).toLocaleString()}
							</p>
							<Label htmlFor="devin-reauth-code">Login code</Label>
							<Input
								id="devin-reauth-code"
								aria-describedby="devin-reauth-code-help"
								type="password"
								autoComplete="off"
								autoCorrect="off"
								autoCapitalize="none"
								spellCheck={false}
								disabled={busy}
								value={code}
								onChange={(event) => setCode(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										event.preventDefault();
										void complete();
									}
								}}
							/>
							<Button
								type="button"
								disabled={busy || !code.trim()}
								onClick={complete}
							>
								Complete Devin sign-in
							</Button>
						</div>
					)}
					<div className="space-y-item">
						<Label htmlFor="devin-reauth-token">
							Or import a Devin session token
						</Label>
						<Input
							id="devin-reauth-token"
							type="password"
							autoComplete="off"
							autoCorrect="off"
							autoCapitalize="none"
							spellCheck={false}
							disabled={busy}
							value={token}
							onChange={(event) => setToken(event.target.value)}
						/>
						<p className="text-sm text-muted-foreground">
							Use a CLI session token for this account, not a Devin cloud API
							key.
						</p>
						<Button
							type="button"
							variant="outline"
							disabled={busy || !token.trim()}
							onClick={() =>
								run(async () => {
									const data = { accountId: account.id, apiKey: token.trim() };
									setToken("");
									setCode("");
									setLogin(null);
									await api.reconnectDevinToken(data);
									success();
								})
							}
						>
							Reconnect with session token
						</Button>
					</div>
					{busy && (
						<p role="status" className="text-sm text-muted-foreground">
							Connecting to Devin...
						</p>
					)}
					{error && (
						<p role="alert" className="text-sm text-destructive-strong">
							{error}
						</p>
					)}
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={close}>
						Cancel
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
