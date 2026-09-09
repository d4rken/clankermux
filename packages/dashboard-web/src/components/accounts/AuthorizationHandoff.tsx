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
		<div className="space-y-item">
			{userCode && (
				<div className="flex items-center gap-item">
					<span className="text-sm text-muted-foreground">User code:</span>
					<code className="text-base font-mono font-bold tracking-widest bg-muted px-row py-tight rounded select-all">
						{userCode}
					</code>
					<CopyButton
						variant="outline"
						size="sm"
						value={userCode}
						title="Copy user code"
					/>
				</div>
			)}
			<div className="flex items-center gap-item">
				<a
					href={url}
					target="_blank"
					rel="noopener noreferrer"
					className="text-sm text-primary underline"
				>
					Open authorization page
				</a>
				<CopyButton
					variant="outline"
					size="sm"
					value={url}
					title="Copy authorization link"
				/>
			</div>
		</div>
	);
}
