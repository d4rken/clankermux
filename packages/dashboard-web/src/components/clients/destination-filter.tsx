import { providerDisplayName } from "@clankermux/core";
import type { ClientModel, ClientSuggestions } from "@clankermux/types";
import { ProviderMarkIcon } from "../accounts/provider-marks";
import { Button } from "../ui/button";
import type { DestinationAccount } from "./ClientWizard";

/** Empty lists restrict nothing. */
export interface DestinationFilter {
	providers: string[];
	accounts: string[];
}
export const NO_DESTINATION_FILTER: DestinationFilter = {
	providers: [],
	accounts: [],
};
/** The provider bucket of a model no known account serves. */
export const UNKNOWN_PROVIDER = "";

const providerLabel = (provider: string) =>
	provider === UNKNOWN_PROVIDER
		? "Unknown provider"
		: providerDisplayName(provider);

/**
 * A pinned entry's own accounts, otherwise the accounts discovery found its
 * upstream model on. An ID no listed account carries keeps its raw ID as a
 * name and lands in the unknown bucket.
 */
export function servingAccounts(
	model: ClientModel,
	suggestions: ClientSuggestions | null,
	accounts: DestinationAccount[],
): DestinationAccount[] {
	const ids =
		model.accountIds ??
		suggestions?.models.find((m) => m.id === model.targetModel)?.accountIds ??
		[];
	return ids.map(
		(id) =>
			accounts.find((a) => a.id === id) ?? {
				id,
				name: id,
				provider: UNKNOWN_PROVIDER,
			},
	);
}

/** `accounts` are the ones serving one model; none puts it in the unknown bucket. */
export function matchesDestinationFilter(
	accounts: DestinationAccount[],
	filter: DestinationFilter,
): boolean {
	if (filter.providers.length) {
		const providers = accounts.length
			? accounts.map((a) => a.provider)
			: [UNKNOWN_PROVIDER];
		if (!providers.some((p) => filter.providers.includes(p))) return false;
	}
	return (
		!filter.accounts.length ||
		accounts.some((a) => filter.accounts.includes(a.id))
	);
}

const CHIP =
	"inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground hover:bg-muted aria-pressed:hover:bg-primary/90";

function Chip({
	label,
	count,
	pressed,
	onToggle,
	provider,
}: {
	label: string;
	count: number;
	pressed: boolean;
	onToggle: () => void;
	provider?: string;
}) {
	return (
		<button
			type="button"
			className={CHIP}
			aria-pressed={pressed}
			aria-label={`Show ${label} models, ${count} ${count === 1 ? "model" : "models"}`}
			onClick={onToggle}
		>
			{provider !== undefined && (
				<ProviderMarkIcon provider={provider} className="h-3.5 w-3.5" />
			)}
			{label}
			<span className="tabular-nums opacity-70">{count}</span>
		</button>
	);
}

/**
 * Provider and account chips over one list of models. `rows` holds the
 * accounts serving each model, one entry per model, so the counts are models.
 */
export function DestinationFilterBar({
	rows,
	filter,
	onChange,
}: {
	rows: DestinationAccount[][];
	filter: DestinationFilter;
	onChange: (filter: DestinationFilter) => void;
}) {
	const providerCounts = new Map<string, number>();
	const accountCounts = new Map<
		string,
		{ account: DestinationAccount; count: number }
	>();
	for (const accounts of rows) {
		const providers = new Set(
			accounts.length ? accounts.map((a) => a.provider) : [UNKNOWN_PROVIDER],
		);
		for (const provider of providers)
			providerCounts.set(provider, (providerCounts.get(provider) ?? 0) + 1);
		for (const account of new Map(accounts.map((a) => [a.id, a])).values()) {
			const entry = accountCounts.get(account.id);
			if (entry) entry.count += 1;
			else accountCounts.set(account.id, { account, count: 1 });
		}
	}
	const providers = [...providerCounts.keys()].sort((a, b) =>
		a === UNKNOWN_PROVIDER
			? 1
			: b === UNKNOWN_PROVIDER
				? -1
				: providerLabel(a).localeCompare(providerLabel(b)),
	);
	const scopedAccounts = [...accountCounts.values()]
		.filter(
			({ account }) =>
				!filter.providers.length || filter.providers.includes(account.provider),
		)
		.sort((a, b) => a.account.name.localeCompare(b.account.name));
	const active = filter.providers.length > 0 || filter.accounts.length > 0;
	if (providers.length < 2 && scopedAccounts.length < 2 && !active) return null;
	const toggleProvider = (provider: string) => {
		const next = filter.providers.includes(provider)
			? filter.providers.filter((p) => p !== provider)
			: [...filter.providers, provider];
		// A chosen account whose provider just left the scope would hide every
		// row while no longer being offered as a chip to undo it.
		const offered = new Set(
			[...accountCounts.values()]
				.filter(
					({ account }) => !next.length || next.includes(account.provider),
				)
				.map(({ account }) => account.id),
		);
		onChange({
			providers: next,
			accounts: filter.accounts.filter((id) => offered.has(id)),
		});
	};
	const toggleAccount = (id: string) =>
		onChange({
			...filter,
			accounts: filter.accounts.includes(id)
				? filter.accounts.filter((a) => a !== id)
				: [...filter.accounts, id],
		});
	return (
		<div className="grid gap-2">
			{providers.length > 1 && (
				<fieldset className="flex flex-wrap items-center gap-2">
					<legend className="float-left w-16 text-xs text-muted-foreground">
						Providers
					</legend>
					{providers.map((provider) => (
						<Chip
							key={provider}
							provider={provider}
							label={providerLabel(provider)}
							count={providerCounts.get(provider) ?? 0}
							pressed={filter.providers.includes(provider)}
							onToggle={() => toggleProvider(provider)}
						/>
					))}
				</fieldset>
			)}
			{scopedAccounts.length > 1 && (
				<fieldset className="flex flex-wrap items-center gap-2">
					<legend className="float-left w-16 text-xs text-muted-foreground">
						Accounts
					</legend>
					{scopedAccounts.map(({ account, count }) => (
						<Chip
							key={account.id}
							label={account.name}
							count={count}
							pressed={filter.accounts.includes(account.id)}
							onToggle={() => toggleAccount(account.id)}
						/>
					))}
				</fieldset>
			)}
			{active && (
				<Button
					variant="ghost"
					size="sm"
					className="w-fit"
					onClick={() => onChange(NO_DESTINATION_FILTER)}
				>
					Clear filters
				</Button>
			)}
		</div>
	);
}
