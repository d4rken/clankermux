import type { AccountResponse } from "@clankermux/types";
import {
	Banknote,
	CornerUpLeft,
	CreditCard,
	Flame,
	Gauge,
	Hourglass,
	type LucideIcon,
	Sunrise,
} from "lucide-react";
import {
	type AccountPolicyKey,
	deriveAccountPolicies,
} from "../../lib/account-policies";
import { StatusChip } from "./StatusChip";

/**
 * One glyph per flag. Every icon here is absent from the rest of the account
 * row (no `RefreshCw`, `Pause`, `CalendarClock`, …) and from the navigation's
 * theme toggle (`Sun`), so a chip cannot be mistaken for a control that sits a
 * few pixels away. `Banknote` and `CreditCard` read alike at 14px but never
 * co-occur: `extraSpend` is anthropic/codex only, `planBilling` is
 * compatible-provider only. The short label beside each glyph is what actually
 * identifies the flag.
 */
const POLICY_ICONS: Record<AccountPolicyKey, LucideIcon> = {
	autoFallback: CornerUpLeft,
	autoRefresh: Flame,
	extraSpend: Banknote,
	autoApplyExpiry: Hourglass,
	autoApplyWeekly: Gauge,
	peakHoursPause: Sunrise,
	planBilling: CreditCard,
};

/**
 * Polarity is carried by tone: filled when the flag is on, outlined when off.
 * BOTH states declare a border — `StatusChip`'s base classes carry none, so an
 * outline-only off state would render 2px larger than the filled chip beside
 * it. `border-transparent` rather than a ring utility: it is a core Tailwind
 * class, whereas an unregistered theme key would silently emit nothing.
 */
const ON_CLASSES =
	"border border-transparent bg-secondary text-secondary-foreground";
const ON_WARNING_CLASSES =
	"border border-transparent bg-warning/15 text-warning-strong";
const OFF_CLASSES = "border border-border text-muted-foreground";

function toneFor(enabled: boolean, emphasis?: "warning"): string {
	if (!enabled) return OFF_CLASSES;
	return emphasis === "warning" ? ON_WARNING_CLASSES : ON_CLASSES;
}

/**
 * The account's automation-flag inventory, rendered as one chip per flag the
 * provider supports — on or off, so the row states the configuration rather
 * than only its exceptions. Indicators only: toggling still happens in the
 * account's overflow menu, which is the sole place the handlers exist.
 *
 * Returns a fragment on purpose. The chips are direct flex children of
 * `AccountStatusChips`'s `flex flex-wrap` container, so they wrap in among the
 * status pills instead of as one indivisible block.
 *
 * Tone alone puts the state nowhere in the accessible tree, so each chip
 * carries an `On — `/`Off — ` tooltip prefix and an `sr-only` state word, and
 * the glyph is hidden from assistive technology.
 */
export function AccountPolicyChips({ account }: { account: AccountResponse }) {
	const policies = deriveAccountPolicies(account);
	if (policies.length === 0) return null;

	return (
		<>
			{policies.map((policy) => {
				const Icon = POLICY_ICONS[policy.key];
				const state = policy.enabled ? "On" : "Off";
				return (
					<StatusChip
						key={policy.key}
						className={toneFor(policy.enabled, policy.emphasis)}
						title={`${state} — ${policy.description}`}
					>
						<Icon className="h-3.5 w-3.5" aria-hidden="true" />
						{policy.label}
						<span className="sr-only">{state}</span>
					</StatusChip>
				);
			})}
		</>
	);
}
