import { useEffect, useState } from "react";
import { useCacheWarming, useSetCacheWarming } from "../../hooks/queries";
import {
	clampBridgeHours,
	hoursToRiskFactor,
	keepalivesForHours,
} from "../../lib/bridge-horizon";
import { Button } from "../ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Input } from "../ui/input";
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

const MODE_HELP: Record<CacheWarmingMode, string> = {
	off: "Disabled — no prompt caches are kept warm.",
	static:
		"Every eligible session (≥ min context) is kept warm at the 1-hour cache TTL. Predictable, but pays the 1h-write premium on all of them.",
	dynamic:
		"Adaptive: only idle-prone, established sessions are promoted to the 1h TTL; continuously-active sessions are demoted back to the cheap 5-minute TTL (de-stick). Smartest, lowest waste.",
};

export function CacheWarmingCard() {
	const { data, isLoading } = useCacheWarming();
	const setCacheWarming = useSetCacheWarming();

	const mode: CacheWarmingMode = data?.mode ?? "off";
	const [minTokens, setMinTokens] = useState<number>(
		data?.minTokens ?? DEFAULT_MIN_TOKENS,
	);
	const [hours, setHours] = useState<number>(data?.bridgeHours ?? 6);

	// Keep the local inputs in sync once the server values load/change. The server's
	// bridgeHours is a derived float (e.g. 6.3333…); round to 1 decimal for a clean
	// input — the tiny precision loss on save is economically negligible.
	useEffect(() => {
		if (typeof data?.minTokens === "number") setMinTokens(data.minTokens);
	}, [data?.minTokens]);
	useEffect(() => {
		if (typeof data?.bridgeHours === "number")
			setHours(round1(data.bridgeHours));
	}, [data?.bridgeHours]);

	const busy = isLoading || setCacheWarming.isPending;
	const validMinTokens = Number.isFinite(minTokens) && minTokens >= 0;
	const dirty = data != null && minTokens !== data.minTokens;
	const offMode = mode === "off";

	// Bridge-horizon conversion constants are owned by the server (bridge-policy);
	// fall back to sane values only until the first load resolves.
	const maxBridgeHours = data?.maxBridgeHours ?? 15.8;
	const hoursPerRiskUnit = data?.hoursPerRiskUnit ?? 15.8;
	const refreshMinutes = data?.refreshMinutes ?? 50;
	const validHours =
		Number.isFinite(hours) && hours >= 0 && hours <= maxBridgeHours + 1e-6;
	const hoursDirty =
		data != null && Math.abs(hours - round1(data.bridgeHours)) > 1e-6;
	const previewRiskFactor = hoursToRiskFactor(hours, hoursPerRiskUnit);
	const previewKeepalives = Math.round(
		keepalivesForHours(hours, refreshMinutes),
	);

	return (
		<Card className="card-hover">
			<CardHeader>
				<CardTitle>Cache Keep-Alive</CardTitle>
				<CardDescription>
					Keeps large, idle Anthropic prompt caches warm so returning to a
					forgotten session stays cheap. Only applies to providers with a
					cache-write premium (Anthropic) — OpenAI/Codex cache automatically and
					don't benefit.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<div>
					<div className="flex items-center gap-3">
						<span className="text-sm font-medium w-12">Mode</span>
						<Select
							value={mode}
							disabled={busy}
							onValueChange={(value) =>
								setCacheWarming.mutate({ mode: value as CacheWarmingMode })
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
					</div>
					<p className="text-xs text-muted-foreground mt-1">
						{MODE_HELP[mode]}
					</p>
				</div>

				<div>
					<div className="flex items-center gap-2">
						<span className="text-sm font-medium">
							Minimum context size (tokens)
						</span>
					</div>
					<div className="flex items-center gap-2 mt-1">
						<Input
							type="number"
							min={0}
							step={1000}
							value={minTokens}
							disabled={busy || offMode}
							onChange={(e) =>
								setMinTokens(parseInt(e.target.value || "0", 10))
							}
							className="w-32"
						/>
						<Button
							size="sm"
							disabled={busy || offMode || !validMinTokens || !dirty}
							onClick={() => setCacheWarming.mutate({ minTokens })}
						>
							Save
						</Button>
					</div>
					<p className="text-xs text-muted-foreground mt-1">
						Only sessions whose cached context is at least this many tokens are
						kept warm (default 100,000 ≈ 100k).
					</p>
				</div>

				<div>
					<div className="flex items-center gap-2">
						<span className="text-sm font-medium">Bridge horizon (hours)</span>
					</div>
					<div className="flex items-center gap-2 mt-1">
						<Input
							type="number"
							min={0}
							max={maxBridgeHours}
							step={0.5}
							value={hours}
							disabled={busy || offMode}
							onChange={(e) =>
								setHours(
									clampBridgeHours(
										parseFloat(e.target.value || "0"),
										maxBridgeHours,
									),
								)
							}
							className="w-32"
						/>
						<Button
							size="sm"
							disabled={busy || offMode || !validHours || !hoursDirty}
							onClick={() => setCacheWarming.mutate({ bridgeHours: hours })}
						>
							Save
						</Button>
					</div>
					<p className="text-xs text-muted-foreground mt-1">
						How long an <strong>idle, promoted (1-hour)</strong> session is kept
						warm before the spend budget gives up — ≈{previewKeepalives}{" "}
						keepalive
						{previewKeepalives === 1 ? "" : "s"} at the {refreshMinutes}-min
						cadence (risk factor {previewRiskFactor.toFixed(2)}). Longer
						recovers older idle sessions (e.g. overnight) cheaply on return,
						since a refresh costs ~20× less than rebuilding the cache — but you
						pay that hold cost on sessions you never come back to. Max ~
						{maxBridgeHours.toFixed(1)}h: beyond the break-even point it's
						cheaper to let the cache rebuild.
					</p>
				</div>
			</CardContent>
		</Card>
	);
}
