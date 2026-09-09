import { useCallback, useEffect, useRef, useState } from "react";
import type { Account } from "../../api";
import { api } from "../../api";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { AccountIdentityPanel } from "./AccountIdentity";
import { AuthorizationHandoff } from "./AuthorizationHandoff";

interface QwenReauthDialogProps {
	account: Account | null;
	isOpen: boolean;
	onClose: () => void;
	onSuccess: () => void;
}

type Step = "idle" | "pending" | "complete" | "error";

export function QwenReauthDialog({
	account,
	isOpen,
	onClose,
	onSuccess,
}: QwenReauthDialogProps) {
	const [step, setStep] = useState<Step>("idle");
	const [authUrl, setAuthUrl] = useState("");
	const [userCode, setUserCode] = useState("");
	const [error, setError] = useState("");
	const sessionIdRef = useRef<string>("");
	const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const stopPolling = useCallback(() => {
		if (pollIntervalRef.current !== null) {
			clearInterval(pollIntervalRef.current);
			pollIntervalRef.current = null;
		}
	}, []);

	// Clean up on unmount or close
	useEffect(() => {
		if (!isOpen) {
			stopPolling();
		}
		return () => stopPolling();
	}, [isOpen, stopPolling]);

	const handleStart = async () => {
		if (!account) return;
		setStep("pending");
		setError("");
		// The pending step is entered before the init call resolves, so clear the
		// previous session's link and code: a retry must not show stale ones while
		// the new init is in flight.
		setAuthUrl("");
		setUserCode("");

		try {
			const result = await api.initQwenReauth({ accountId: account.id });
			sessionIdRef.current = result.sessionId;
			setAuthUrl(result.authUrl);
			setUserCode(result.userCode);

			pollIntervalRef.current = setInterval(async () => {
				try {
					const status = await api.getQwenAuthStatus(sessionIdRef.current);
					if (status.status === "complete") {
						stopPolling();
						setStep("complete");
						setTimeout(() => {
							onSuccess();
							handleClose();
						}, 1500);
					} else if (status.status === "error") {
						stopPolling();
						setStep("error");
						setError(status.error || "Authentication failed");
					}
				} catch {
					// transient poll error — keep trying
				}
			}, 3000);
		} catch (err) {
			setStep("error");
			setError(
				err instanceof Error ? err.message : "Failed to start authentication",
			);
		}
	};

	const handleClose = () => {
		stopPolling();
		setStep("idle");
		setAuthUrl("");
		setUserCode("");
		setError("");
		onClose();
	};

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Re-authenticate Qwen Account</DialogTitle>
					{/* `asChild`: the identity block must live INSIDE the description so
					    Radix's `aria-describedby` announces it when the dialog opens, and
					    a description rendered as the default `<p>` cannot contain it. */}
					<DialogDescription asChild>
						<div className="space-y-item">
							<AccountIdentityPanel account={account} />
							<span className="block">
								All account metadata (usage stats, priority, settings) will be
								preserved.
							</span>
						</div>
					</DialogDescription>
				</DialogHeader>

				<div className="py-group">
					{step === "idle" && (
						<p className="text-sm text-muted-foreground">
							Click the button below to start the Qwen device flow. You will get
							an authorization link and a user code to enter in the browser that
							is signed in to this account.
						</p>
					)}

					{step === "pending" && (
						<div className="space-y-row">
							<p className="text-sm text-muted-foreground">
								Waiting for authorization. Enter the user code on the
								authorization page.
							</p>
							{authUrl && (
								<AuthorizationHandoff url={authUrl} userCode={userCode} />
							)}
						</div>
					)}

					{step === "complete" && (
						<p className="text-sm text-success-strong">
							Re-authentication successful! Tokens updated.
						</p>
					)}

					{step === "error" && (
						<div className="space-y-item">
							<p className="text-sm text-destructive-strong">{error}</p>
						</div>
					)}
				</div>

				<DialogFooter>
					{(step === "idle" || step === "error") && (
						<Button onClick={handleStart}>Start Re-authentication</Button>
					)}
					<Button variant="outline" onClick={handleClose}>
						{step === "complete" ? "Close" : "Cancel"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
