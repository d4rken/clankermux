import { providerDisplayName } from "@clankermux/core";
import { ProviderMarkIcon } from "./provider-marks";

/**
 * One neutral pill for every provider. Provider identity is carried by the
 * brand mark and the label, not by a tint: filled per-provider tints sat right
 * next to the account status chips (rate-limited, paused, error) and read as
 * status themselves, which is exactly what they must not do. This is the same
 * neutral fill unlisted providers already fell back to.
 */
// `px-2 py-0.5` stays numeric: 0.125rem is the pill padding the Substrate
// mockup specifies and it maps to no step on the rhythm scale, so there is
// nothing to convert it TO. Spelling only the horizontal half on the scale
// would mix two scales inside one declaration.
const CHIP_CLASSES =
	"inline-flex items-center gap-item rounded-full border border-border/60 bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground";

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
