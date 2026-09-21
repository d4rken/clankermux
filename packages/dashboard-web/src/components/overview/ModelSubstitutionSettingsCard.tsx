import { useState } from "react";
import type { ServedModelSubstitutionMode } from "../../api";
import {
	useServedModelSubstitutionMode,
	useSetServedModelSubstitutionMode,
} from "../../hooks/queries";
import { SettingListControl, SettingRow } from "../settings/SettingRow";
import { Button } from "../ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";

/**
 * What to do when a provider answers as a model other than the one it was sent.
 *
 * `observe` is the reason this is a mode rather than a switch: substitution has
 * been measured on one provider, so every other wire format's false-positive
 * classes are unknown, and a false positive turns a working response into a
 * client-visible error. The middle setting keeps detection and all three
 * surfaces alive with the failover out of the request path.
 */
const MODE_OPTIONS: ReadonlyArray<{
	value: ServedModelSubstitutionMode;
	label: string;
}> = [
	{ value: "off", label: "Off" },
	{ value: "observe", label: "Observe" },
	{ value: "enforce", label: "Enforce" },
];

const MODE_HELP: Record<
	ServedModelSubstitutionMode,
	{ summary: string; detail?: string }
> = {
	off: {
		summary: "Disabled — a substituted answer is forwarded as if correct.",
		detail:
			"The served model is still recorded against each attempt, so the analytics card keeps filling in; nothing is detected, suppressed or failed over.",
	},
	observe: {
		summary: "Detect and report, but serve the substituted answer anyway.",
		detail:
			"The rollback setting. Accounts still show as Degraded and the history still fills, but no request fails over and no account is held back — so a false-positive class on a provider that has never been measured costs a wrong chip rather than a failed request.",
	},
	enforce: {
		summary:
			"Fail the attempt over to another account and hold that pair back for five minutes.",
		detail:
			"A client that would have received a working answer from a lesser model gets a retryable 503 when EVERY account substitutes. The abandoned attempt has already consumed its upstream quota window, so a substituting account costs a window on each of its own and its sibling's first requests until the suppression settles.",
	},
};

type ExceptionRow = { sent: string; served: string };

const ENTRY_SEPARATOR = ">";

function toEntries(rows: readonly ExceptionRow[]): string[] {
	return rows
		.map((row) => `${row.sent.trim()}${ENTRY_SEPARATOR}${row.served.trim()}`)
		.filter((entry) => entry !== ENTRY_SEPARATOR);
}

function toRows(entries: readonly string[]): ExceptionRow[] {
	return entries.map((entry) => {
		const [sent = "", served = ""] = entry.split(ENTRY_SEPARATOR);
		return { sent, served };
	});
}

export function ModelSubstitutionSettingsCard() {
	const { data, isLoading } = useServedModelSubstitutionMode();
	const setMode = useSetServedModelSubstitutionMode();

	const mode: ServedModelSubstitutionMode =
		data?.servedModelSubstitutionMode ?? "enforce";
	const help = MODE_HELP[mode];

	const serverEntries = data?.servedModelSubstitutionExceptions ?? [];
	const serverKey = JSON.stringify(serverEntries);
	// The draft remembers WHICH server list it was started from, and is thrown
	// away as soon as that list changes — including after this card's own save,
	// when the saved rows come back as the server value.
	//
	// Thrown away, not just hidden: a draft kept aside would come back to life if
	// the server list ever returned to the value it was started from (edit
	// against A, someone else sets B and then A again), and stale rows would read
	// as freshly typed.
	//
	// Reset during render rather than in an effect. An effect would carry
	// `serverKey` as a dependency without referencing it in its body, which is
	// the exact shape biome's unsafe autofix strips.
	const [draft, setDraft] = useState<{
		key: string;
		rows: ExceptionRow[];
	} | null>(null);
	if (draft !== null && draft.key !== serverKey) setDraft(null);
	const rows = draft?.rows ?? toRows(serverEntries);
	const dirty =
		draft !== null && JSON.stringify(toEntries(draft.rows)) !== serverKey;
	// A half-typed pair would be stored as a rule that matches nothing.
	const incomplete = rows.some(
		(row) => row.sent.trim() === "" || row.served.trim() === "",
	);

	return (
		<Card className="card-hover">
			<CardHeader>
				<CardTitle>Model Substitution</CardTitle>
				<CardDescription>
					Some providers answer with a different model than the one they were
					sent, return HTTP 200, and say nothing. This decides what happens when
					they do.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-row">
				<SettingRow
					label="Mode"
					control={
						<Select
							value={mode}
							disabled={isLoading || setMode.isPending}
							onValueChange={(value) =>
								setMode.mutate({
									mode: value as ServedModelSubstitutionMode,
								})
							}
						>
							<SelectTrigger className="w-36">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{MODE_OPTIONS.map((opt) => (
									<SelectItem key={opt.value} value={opt.value}>
										{opt.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					summary={help.summary}
					detail={help.detail}
				/>

				<SettingRow
					label="Accepted swaps"
					control={
						<div className="flex flex-col gap-item">
							<SettingListControl
								name="accepted swap"
								fields={[
									{ key: "sent", placeholder: "gpt-5.6-luna", grow: 1 },
									{ key: "served", placeholder: "gpt-6-luna", grow: 1 },
								]}
								rows={rows}
								addLabel="Add swap"
								emptyLabel="None — every substitution is treated the same way."
								disabled={isLoading || setMode.isPending}
								onChange={(next) =>
									setDraft({
										key: serverKey,
										rows: next.map((row) => ({
											sent: row.sent ?? "",
											served: row.served ?? "",
										})),
									})
								}
							/>
							<div className="flex items-center gap-item">
								<Button
									disabled={!dirty || incomplete || setMode.isPending}
									onClick={() =>
										setMode.mutate({ exceptions: toEntries(rows) })
									}
								>
									Save swaps
								</Button>
								{dirty && incomplete && (
									<span className="text-sm text-muted-foreground">
										Fill in or remove the blank row to save.
									</span>
								)}
							</div>
							{/* The server rejects a rule rather than dropping it, so its
							    reason has to be readable here. Without this a rejected
							    save looks like a save that did nothing: the editor keeps
							    the typed rows and the list never changes. */}
							{setMode.error && (
								<p className="text-sm text-destructive">
									{setMode.error instanceof Error
										? setMode.error.message
										: "Could not save the accepted swaps."}
								</p>
							)}
						</div>
					}
					summary="Substitutions to report but not act on, written as the model sent and the model served."
					detail={
						'A swap is not always a downgrade: a gpt-5.6-luna request answered with gpt-6-luna gets a newer model than it asked for, and failing that over trades a better answer for a retry. Listed pairs are still detected, still recorded and still shown on the analytics card; they just stop failing the attempt over, stop suppressing the account and stop raising the Degraded chip. Matching runs through the same normalisation as detection, so a rule written against an undated alias also covers the dated snapshot of the same model. Use "*" on one side to accept any model there; both sides is rejected, because that is what Observe mode already does.'
					}
				/>
			</CardContent>
		</Card>
	);
}
