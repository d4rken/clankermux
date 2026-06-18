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
import { Switch } from "../ui/switch";

const DEFAULT_MIN_TOKENS = 100000;

export function CacheWarmingCard() {
	const { data, isLoading } = useCacheWarming();
	const setCacheWarming = useSetCacheWarming();

	const enabled = data?.enabled ?? false;
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
				<div className="flex items-center gap-3">
					<Switch
						disabled={busy}
						checked={enabled}
						onCheckedChange={(checked) =>
							setCacheWarming.mutate({ enabled: checked })
						}
					/>
					<span className="text-sm text-muted-foreground">
						{enabled ? "Enabled" : "Disabled"}
					</span>
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
							disabled={busy || !enabled}
							onChange={(e) =>
								setMinTokens(parseInt(e.target.value || "0", 10))
							}
							className="w-32"
						/>
						<Button
							size="sm"
							disabled={busy || !enabled || !validMinTokens || !dirty}
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
