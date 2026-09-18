import { useEffect, useState } from "react";
import type { Account } from "../../api";
import { useApiError } from "../../hooks/useApiError";
import type { RenewalCadence } from "../../lib/renewal";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";

interface AccountRenewalDialogProps {
	account: Account | null;
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
	onUpdateRenewal: (
		accountId: string,
		anchor: string | null,
		cadence: RenewalCadence,
		priceUsd: number | null,
	) => Promise<void>;
	/** Withdraws the operator's date so the server estimates one again. */
	onUseAutomaticRenewal: (accountId: string) => Promise<void>;
}

export function SubscriptionStatusSummary({ account }: { account: Account }) {
	if (account.provider !== "anthropic") return null;
	const fetchedAt = account.identityProfileFetchedAt;
	const checkedAt = account.identitySubscriptionCheckedAt;
	const checkUnconfirmed =
		checkedAt != null && (fetchedAt == null || checkedAt > fetchedAt);
	return (
		<div className="mt-tight text-xs text-muted-foreground space-y-tight">
			<p>
				{account.identitySubscriptionStatus
					? `Last known subscription status: ${account.identitySubscriptionStatus}.`
					: "Subscription status: unknown. The provider has not reported a subscription status."}
			</p>
			{fetchedAt != null && (
				<p>
					Last successful check:{" "}
					<time dateTime={new Date(fetchedAt).toISOString()}>
						{new Date(fetchedAt).toLocaleString()}
					</time>
				</p>
			)}
			{checkUnconfirmed && (
				<p>
					Latest subscription check has not completed successfully. The current
					subscription state is unverified.
				</p>
			)}
		</div>
	);
}

export function AccountRenewalDialog({
	account,
	isOpen,
	onOpenChange,
	onUpdateRenewal,
	onUseAutomaticRenewal,
}: AccountRenewalDialogProps) {
	const [anchor, setAnchor] = useState(account?.renewalAnchor ?? "");
	const [cadence, setCadence] = useState<RenewalCadence>(
		account?.renewalCadence ?? "monthly",
	);
	const [price, setPrice] = useState(
		account?.renewalPriceUsd != null ? String(account.renewalPriceUsd) : "",
	);
	const [isUpdating, setIsUpdating] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const { formatError } = useApiError();

	// Reset fields when the account changes or the dialog opens.
	useEffect(() => {
		if (account) {
			setAnchor(account.renewalAnchor ?? "");
			setCadence(account.renewalCadence ?? "monthly");
			setPrice(
				account.renewalPriceUsd != null ? String(account.renewalPriceUsd) : "",
			);
			setSaveError(null);
		}
	}, [account]);

	const hasAnchorSet = !!account?.renewalAnchor;
	const anchorSource = account?.renewalAnchorSource ?? null;

	// Three states, and two of them show an empty date field: a date you set, an
	// estimate, or nothing at all. A cleared account and a never-configured one
	// are told apart by the source alone, so this line is the only thing that
	// says which one you are looking at. Null for a provider-reported anchor,
	// whose note below already states it in more detail.
	let trackingNote: string | null;
	if (anchorSource === "provider") {
		trackingNote = null;
	} else if (anchorSource === "derived") {
		trackingNote =
			"Tracking an automatic estimate from the subscription start.";
	} else if (hasAnchorSet) {
		trackingNote = "Tracking a date you set. It stays until you change it.";
	} else if (anchorSource === null) {
		trackingNote =
			"Tracking is automatic. An estimate appears once the provider reports a subscription start.";
	} else {
		trackingNote =
			"Renewal tracking is off. You cleared the date, so nothing is estimated.";
	}

	// Only an account that is genuinely on automatic — no anchor and no source —
	// has nothing to hand back. An anchor with no source is a date saved before
	// the provenance column existed, and it still overrides any estimate.
	const canUseAutomatic = anchorSource !== null || hasAnchorSet;

	// Two different things a provider can report, and they say different amounts.
	// A subscription START is not a renewal date, so a date derived from it is an
	// estimate until the operator saves. A period END is an observation, re-synced
	// on every capture — saving replaces it with a fixed date that stops moving.
	const localDate = (ms: number | null | undefined) =>
		ms != null ? new Date(ms).toLocaleDateString("en-CA") : null;
	const subscriptionStart = localDate(account?.identitySubscriptionStartedAt);
	const periodEnd = localDate(account?.identitySubscriptionEndsAt);

	let subscriptionNote: string | null = null;
	if (account?.renewalAnchorSource === "provider" && periodEnd) {
		subscriptionNote =
			`The provider reports the current period ends ${periodEnd}` +
			(account.identitySubscriptionWillRenew === false
				? " and that it will not renew."
				: ".") +
			" It follows the billing cycle until you save, which replaces it with a fixed date of your own.";
	} else if (subscriptionStart) {
		subscriptionNote =
			anchorSource === "derived"
				? `Subscription started ${subscriptionStart}. Saving confirms the estimate as a date of your own.`
				: `Subscription started ${subscriptionStart}${
						account?.provider !== "anthropic" &&
						account?.identitySubscriptionStatus
							? ` · ${account.identitySubscriptionStatus}`
							: ""
					}.`;
	}
	// One-time dates aren't auto-recorded, so a price would be inert — the
	// input is disabled and the save sends null.
	const priceDisabled = cadence === "none";

	const parsedPrice = Number.parseFloat(price);
	const priceValid =
		priceDisabled ||
		price.trim() === "" ||
		(Number.isFinite(parsedPrice) && parsedPrice > 0);

	const handleSave = async () => {
		if (!account) return;
		const anchorOrNull = anchor.trim() === "" ? null : anchor;
		const priceOrNull =
			priceDisabled || price.trim() === "" ? null : parsedPrice;
		setIsUpdating(true);
		setSaveError(null);
		try {
			await onUpdateRenewal(account.id, anchorOrNull, cadence, priceOrNull);
			onOpenChange(false);
		} catch (error) {
			// In-dialog, not the parent's `actionError`: that renders behind this
			// dialog's overlay and is only visible once the dialog is dismissed.
			setSaveError(formatError(error));
		} finally {
			setIsUpdating(false);
		}
	};

	const handleUseAutomatic = async () => {
		if (!account) return;
		setIsUpdating(true);
		setSaveError(null);
		try {
			await onUseAutomaticRenewal(account.id);
			onOpenChange(false);
		} catch (error) {
			setSaveError(formatError(error));
		} finally {
			setIsUpdating(false);
		}
	};

	const handleClear = async () => {
		if (!account) return;
		setIsUpdating(true);
		setSaveError(null);
		try {
			await onUpdateRenewal(account.id, null, "none", null);
			onOpenChange(false);
		} catch (error) {
			setSaveError(formatError(error));
		} finally {
			setIsUpdating(false);
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[425px]">
				<DialogHeader>
					<DialogTitle>Set Renewal Date</DialogTitle>
					<DialogDescription>
						Set the subscription renewal date for {account?.name}. The Accounts
						page shows a chip that turns amber as renewal approaches and red
						when it is imminent.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-group py-group">
					<div className="grid grid-cols-4 items-center gap-group">
						<Label htmlFor="renewal-anchor" className="text-right">
							Date
						</Label>
						<div className="col-span-3">
							<Input
								id="renewal-anchor"
								type="date"
								value={anchor}
								onChange={(e) => setAnchor(e.target.value)}
							/>
							{trackingNote && (
								<p className="mt-tight text-xs text-muted-foreground">
									{trackingNote}
								</p>
							)}
							{subscriptionNote && (
								<p className="mt-tight text-xs text-muted-foreground">
									{subscriptionNote}
								</p>
							)}
							{account && <SubscriptionStatusSummary account={account} />}
							{canUseAutomatic && (
								<Button
									type="button"
									variant="link"
									size="sm"
									className="mt-tight h-auto px-0"
									onClick={handleUseAutomatic}
									disabled={isUpdating}
								>
									Use the automatic estimate
								</Button>
							)}
						</div>
					</div>
					<div className="grid grid-cols-4 items-center gap-group">
						<Label htmlFor="renewal-cadence" className="text-right">
							Repeats
						</Label>
						<Select
							value={cadence}
							onValueChange={(value) => setCadence(value as RenewalCadence)}
						>
							<SelectTrigger id="renewal-cadence" className="col-span-3">
								<SelectValue placeholder="Select cadence" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="monthly">Monthly</SelectItem>
								<SelectItem value="yearly">Yearly</SelectItem>
								<SelectItem value="none">One-time</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<div className="grid grid-cols-4 items-center gap-group">
						<Label htmlFor="renewal-price" className="text-right">
							Price USD
						</Label>
						<div className="col-span-3">
							<Input
								id="renewal-price"
								type="number"
								min={0}
								step={0.01}
								placeholder="Price per renewal (empty = no price)"
								value={price}
								onChange={(e) => setPrice(e.target.value)}
								disabled={priceDisabled}
							/>
							{priceDisabled && (
								<p className="mt-tight text-xs text-muted-foreground">
									One-time dates aren't auto-recorded — use Record Payment.
								</p>
							)}
						</div>
					</div>
				</div>
				{saveError && (
					<p role="alert" className="text-sm text-destructive-strong">
						{saveError}
					</p>
				)}
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						type="button"
						variant="outline"
						onClick={handleClear}
						disabled={isUpdating || !hasAnchorSet}
					>
						Clear
					</Button>
					<Button
						type="button"
						onClick={handleSave}
						disabled={isUpdating || !priceValid}
					>
						{isUpdating ? "Saving..." : "Save"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
