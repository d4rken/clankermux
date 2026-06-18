import { useEffect, useState } from "react";
import { useCacheWarming, useSetCacheWarming } from "../../hooks/queries";
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

	// Keep the local input in sync once the server value loads/changes.
	useEffect(() => {
		if (typeof data?.minTokens === "number") setMinTokens(data.minTokens);
	}, [data?.minTokens]);

	const busy = isLoading || setCacheWarming.isPending;
	const validMinTokens = Number.isFinite(minTokens) && minTokens >= 0;
	const dirty = data != null && minTokens !== data.minTokens;
	const offMode = mode === "off";

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
			</CardContent>
		</Card>
	);
}
