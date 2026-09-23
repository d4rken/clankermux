import { useCacheWarming } from "../../hooks/queries";
import {
	FALLBACK_BRIDGE_HOURS,
	FALLBACK_HOURS_PER_RISK_UNIT,
	FALLBACK_MAX_BRIDGE_HOURS,
	FALLBACK_REFRESH_MINUTES,
	hoursToRiskFactor,
	keepalivesForHours,
} from "../../lib/bridge-horizon";
import {
	SettingFigure,
	SettingNumberControl,
	SettingRow,
} from "../settings/SettingRow";
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

const DEFAULT_MIN_TOKENS = 100000;

/** Round to 1 decimal for a clean hours input (server bridgeHours is a derived float). */
function round1(n: number): number {
	return Math.round(n * 10) / 10;
}

type CacheWarmingMode = "off" | "static" | "dynamic";

const MODE_OPTIONS: { value: CacheWarmingMode; label: string }[] = [
	{ value: "off", label: "Off" },
	{ value: "static", label: "Static" },
	{ value: "dynamic", label: "Dynamic" },
];

/**
 * Mode help, split into the line that is always on screen and the reasoning
 * behind the expander. The summary says what the mode DOES; the detail says
 * what it costs, which is the part you only need while choosing.
 */
const MODE_HELP: Record<
	CacheWarmingMode,
	{ summary: string; detail?: string }
> = {
	off: { summary: "Disabled — no prompt caches are kept warm." },
	static: {
		summary: "Every eligible session is kept warm at the 1-hour cache TTL.",
		detail:
			"Predictable, but it pays the 1-hour cache-write premium on all of them, including sessions that were never going to be resumed.",
	},
	dynamic: {
		summary:
			"Only idle-prone, established sessions are promoted to the 1-hour TTL.",
		detail:
			"Adaptive: continuously-active sessions are demoted back to the cheap 5-minute TTL (de-stick), so the 1-hour premium is paid only where an idle gap makes it worth holding. Smartest, lowest waste.",
	},
};

/**
 * Read-only while cache warming is re-evaluated: the card shows the current
 * settings but owns no mutation, so nothing here can change them. The
 * management API (`POST /api/config/cache-warming`) still can.
 */
export function CacheWarmingCard() {
	const { data } = useCacheWarming();

	const mode: CacheWarmingMode = data?.mode ?? "off";
	const minTokens = data?.minTokens ?? DEFAULT_MIN_TOKENS;
	// The server's bridgeHours is a derived float (e.g. 6.3333…).
	const hours = round1(data?.bridgeHours ?? FALLBACK_BRIDGE_HOURS);

	// Bridge-horizon conversion constants are owned by the server (bridge-policy);
	// the fallbacks restate its derivation and apply only until the first load.
	const maxBridgeHours = data?.maxBridgeHours ?? FALLBACK_MAX_BRIDGE_HOURS;
	const hoursPerRiskUnit =
		data?.hoursPerRiskUnit ?? FALLBACK_HOURS_PER_RISK_UNIT;
	const refreshMinutes = data?.refreshMinutes ?? FALLBACK_REFRESH_MINUTES;
	const previewRiskFactor = hoursToRiskFactor(hours, hoursPerRiskUnit);
	const previewKeepalives = Math.round(
		keepalivesForHours(hours, refreshMinutes),
	);

	const modeHelp = MODE_HELP[mode];

	return (
		<Card className="card-hover">
			<CardHeader>
				<CardTitle>Cache Keep-Alive</CardTitle>
				<CardDescription>
					Keeps large, idle Anthropic prompt caches warm so returning to a
					forgotten session stays cheap.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-row">
				<p className="text-xs text-muted-foreground">
					Cache warming is being re-evaluated. These settings can only be
					changed through the management API.
				</p>

				<SettingRow
					label="Mode"
					control={
						<Select value={mode} disabled>
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
					summary={modeHelp.summary}
					detail={
						modeHelp.detail ??
						"Only applies to providers with a cache-write premium (Anthropic). OpenAI and Codex cache automatically and gain nothing from keep-alive."
					}
				/>

				<SettingRow
					label="Minimum context"
					control={
						<SettingNumberControl
							value={minTokens}
							unit="tokens"
							min={0}
							step={1000}
							disabled
							canSave={false}
							onChange={() => {}}
							onSave={() => {}}
							inputClassName="w-28"
						/>
					}
					summary="Only sessions with at least this much cached context are kept warm."
					detail="Below this size a cache is cheap enough to rebuild on demand, so holding it warm costs more than it saves. Default is 100,000 tokens (≈100k)."
				/>

				<SettingRow
					label="Bridge horizon"
					control={
						<SettingNumberControl
							value={hours}
							unit="hours"
							min={0}
							max={maxBridgeHours}
							step={0.5}
							disabled
							canSave={false}
							onChange={() => {}}
							onSave={() => {}}
							inputClassName="w-28"
						/>
					}
					value={
						<SettingFigure
							figure={`≈${previewKeepalives}`}
							note={`keepalive${previewKeepalives === 1 ? "" : "s"} at the ${refreshMinutes}-min cadence · risk ${previewRiskFactor.toFixed(2)}`}
						/>
					}
					summary="How long an idle, promoted (1-hour) session is kept warm."
					detail={`Longer recovers older idle sessions (an overnight gap, say) cheaply on return, since a refresh costs ~20× less than rebuilding the cache — but you pay that hold cost on every session you never come back to. Max ~${maxBridgeHours.toFixed(1)}h: beyond the break-even point it is cheaper to let the cache rebuild.`}
				/>
			</CardContent>
		</Card>
	);
}
