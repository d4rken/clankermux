import { CopyButton } from "../CopyButton";

interface AuthorizationHandoffProps {
	/** The authorization URL the user has to open in the browser signed in to the account. */
	url: string;
	/** Device-flow user code to enter on that page; omitted for the Anthropic code flow. */
	userCode?: string;
}

/**
 * Hands an OAuth authorization URL to the user instead of opening it.
 *
 * The link usually has to be carried to a *different* browser — the one signed
 * in to the account being authorized — so nothing is opened automatically. The
 * anchor gives right-click "copy link address" (and a normal click for the case
 * where this browser is the right one), and the button copies it directly.
 */
export function AuthorizationHandoff({
	url,
	userCode,
}: AuthorizationHandoffProps) {
	return (
		<div className="flex min-w-0 flex-col gap-row">
			{userCode && (
				<div className="flex flex-wrap items-center gap-item">
					<span className="text-sm text-muted-foreground">User code:</span>
					<div className="flex min-w-0 items-center gap-item">
						<code className="min-w-0 break-all text-sm font-mono font-medium tracking-wider text-foreground bg-muted px-row py-tight rounded select-all">
							{userCode}
						</code>
						<CopyButton
							variant="outline"
							size="sm"
							value={userCode}
							title="Copy user code"
							className="shrink-0"
						/>
					</div>
				</div>
			)}
			<div className="flex min-w-0 items-center gap-item">
				<a
					href={url}
					target="_blank"
					rel="noopener noreferrer"
					className="min-w-0 text-sm text-primary underline"
				>
					Open authorization page
				</a>
				<CopyButton
					variant="outline"
					size="sm"
					value={url}
					title="Copy authorization link"
					className="shrink-0"
				/>
			</div>
		</div>
	);
}
