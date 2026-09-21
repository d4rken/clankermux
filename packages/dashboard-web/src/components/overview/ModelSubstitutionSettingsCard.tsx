import type { ServedModelSubstitutionMode } from "../../api";
import {
	useServedModelSubstitutionMode,
	useSetServedModelSubstitutionMode,
} from "../../hooks/queries";
import { SettingRow } from "../settings/SettingRow";
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

export function ModelSubstitutionSettingsCard() {
	const { data, isLoading } = useServedModelSubstitutionMode();
	const setMode = useSetServedModelSubstitutionMode();

	const mode: ServedModelSubstitutionMode =
		data?.servedModelSubstitutionMode ?? "enforce";
	const help = MODE_HELP[mode];

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
			</CardContent>
		</Card>
	);
}
