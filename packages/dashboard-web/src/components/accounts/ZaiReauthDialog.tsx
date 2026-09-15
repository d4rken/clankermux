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

interface ZaiReauthDialogProps {
	account: Account | null;
	isOpen: boolean;
	onClose: () => void;
	onSuccess: () => void;
}

export function ZaiReauthDialog({
	account,
	isOpen,
	...callbacks
}: ZaiReauthDialogProps) {
	// Each opening/account gets its own state and pending-request lifetime.
	return isOpen && account ? (
		<ZaiReauthSession key={account.id} account={account} {...callbacks} />
	) : null;
}

function ZaiReauthSession({
	account,
	onClose,
	onSuccess,
}: Omit<ZaiReauthDialogProps, "isOpen" | "account"> & { account: Account }) {
	const [login, setLogin] = useState<Awaited<
		ReturnType<typeof api.startZaiReauth>
	> | null>(null);
	const [redirectUrl, setRedirectUrl] = useState("");
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
		setRedirectUrl("");
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
								: "Z.AI reconnect failed",
						);
				}
			},
		);
	};
	const complete = () => {
		if (!login || !redirectUrl.trim()) return;
		return run(async () => {
			const data = { sessionId: login.sessionId, code: redirectUrl.trim() };
			// A redirect URL is single use; failures require a new browser sign-in.
			setLogin(null);
			setRedirectUrl("");
			await api.completeZaiReauth(data);
			success();
		});
	};
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) close();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Reconnect z.ai Account</DialogTitle>
					<DialogDescription asChild>
						<div className="space-y-item">
							<AccountIdentityPanel account={account} />
							<span className="block">
								Sign in to the same z.ai account, then paste the redirect URL
								here. Usage history, priority, and settings will be preserved.
							</span>
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
								setRedirectUrl("");
								const result = await api.startZaiReauth({
									accountId: account.id,
								});
								if (active.current) setLogin(result);
							})
						}
					>
						{login ? "Generate a new sign-in link" : "Sign in with Z.AI"}
					</Button>
					{login && (
						<div className="space-y-item">
							<AuthorizationHandoff url={login.authUrl} />
							<p
								id="zai-reauth-redirect-help"
								className="text-sm text-muted-foreground"
							>
								Open the link in a browser signed in to this account. It ends on
								a localhost:54548 address the browser cannot load; copy that
								whole URL out of the address bar and paste it here.
							</p>
							<p className="text-sm text-muted-foreground">
								Finish this sign-in by:{" "}
								{new Date(login.expiresAt).toLocaleString()}
							</p>
							<Label htmlFor="zai-reauth-redirect">Redirect URL</Label>
							<Input
								id="zai-reauth-redirect"
								aria-describedby="zai-reauth-redirect-help"
								type="password"
								autoComplete="off"
								autoCorrect="off"
								autoCapitalize="none"
								spellCheck={false}
								disabled={busy}
								value={redirectUrl}
								onChange={(event) => setRedirectUrl(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										event.preventDefault();
										void complete();
									}
								}}
							/>
							<Button
								type="button"
								disabled={busy || !redirectUrl.trim()}
								onClick={complete}
							>
								Complete Z.AI sign-in
							</Button>
						</div>
					)}
					{busy && (
						<p role="status" className="text-sm text-muted-foreground">
							Connecting to z.ai...
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
