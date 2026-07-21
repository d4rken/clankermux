import { providerDisplayName } from "../../utils/provider-utils";

/**
 * Per-provider branded pill colors. Full literal Tailwind class strings (not
 * dynamically composed) so the JIT compiler keeps them. Each entry pairs a
 * light-mode tint with a dark-mode variant, mirroring the status-chip palette
 * in `AccountStatusChips`. Unknown providers fall back to the neutral
 * secondary color below.
 */
const PROVIDER_CHIP_CLASSES: Record<string, string> = {
	anthropic:
		"bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
	"claude-console-api":
		"bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
	"anthropic-compatible":
		"bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
	codex:
		"bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
	"openai-compatible":
		"bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400",
	zai: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400",
	minimax: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
	kilo: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400",
	openrouter:
		"bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400",
	"alibaba-coding-plan":
		"bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400",
	qwen: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
	ollama:
		"bg-slate-100 text-slate-700 dark:bg-slate-800/50 dark:text-slate-300",
	"ollama-cloud":
		"bg-zinc-100 text-zinc-700 dark:bg-zinc-800/50 dark:text-zinc-300",
};

const DEFAULT_CHIP_CLASSES = "bg-secondary text-secondary-foreground";

interface ProviderChipProps {
	provider: string;
	className?: string;
}

/**
 * A small branded pill showing the human-readable provider name (e.g. an
 * account on the `codex` provider renders "OpenAI"). Used behind the account
 * name on the Accounts and Limits pages.
 */
export function ProviderChip({ provider, className }: ProviderChipProps) {
	const color = PROVIDER_CHIP_CLASSES[provider] ?? DEFAULT_CHIP_CLASSES;
	return (
		<span
			className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${color}${
				className ? ` ${className}` : ""
			}`}
		>
			{providerDisplayName(provider)}
		</span>
	);
}
