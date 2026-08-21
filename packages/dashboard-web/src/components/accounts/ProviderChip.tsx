import { providerDisplayName } from "../../utils/provider-utils";
import { ProviderMarkIcon } from "./provider-marks";

/**
 * One neutral pill for every provider. Provider identity is carried by the
 * brand mark and the label, not by a tint: filled per-provider tints sat right
 * next to the account status chips (rate-limited, paused, error) and read as
 * status themselves, which is exactly what they must not do.
 */
const CHIP_CLASSES =
	"inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground";

interface ProviderChipProps {
	provider: string;
	className?: string;
}

/**
 * A small pill showing a provider's brand mark and human-readable name (e.g.
 * an account on the `codex` provider renders the OpenAI mark and "OpenAI").
 * Used behind the account name on the Accounts and Limits pages.
 */
export function ProviderChip({ provider, className }: ProviderChipProps) {
	return (
		<span className={`${CHIP_CLASSES}${className ? ` ${className}` : ""}`}>
			<ProviderMarkIcon provider={provider} className="h-3.5 w-3.5" />
			{providerDisplayName(provider)}
		</span>
	);
}
