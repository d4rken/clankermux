import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";

export interface MemorySample {
	/** epoch ms when the sample was taken (used as React key only) */
	t: number;
	/** resident set size in MB */
	rss: number;
}

interface MemorySparklineProps {
	data: MemorySample[];
	color: string;
	height?: number;
}

/**
 * Minimal RSS sparkline — no axes, grid, or tooltip chrome. The Y domain is
 * padded ~5% around the observed min/max so small fluctuations stay visible
 * instead of flat-lining. History is supplied by the caller (accumulated
 * client-side across polls); this component is purely presentational.
 */
export function MemorySparkline({
	data,
	color,
	height = 40,
}: MemorySparklineProps) {
	if (data.length < 2) {
		return (
			<div
				className="flex items-center justify-center text-[10px] text-muted-foreground"
				style={{ height }}
			>
				collecting…
			</div>
		);
	}

	const values = data.map((d) => d.rss);
	const min = Math.min(...values);
	const max = Math.max(...values);
	const pad = Math.max(1, (max - min) * 0.05);
	const gradientId = "memorySparklineGradient";

	return (
		<ResponsiveContainer width="100%" height={height}>
			<AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
				<defs>
					<linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stopColor={color} stopOpacity={0.4} />
						<stop offset="100%" stopColor={color} stopOpacity={0.05} />
					</linearGradient>
				</defs>
				<YAxis hide domain={[min - pad, max + pad]} />
				<Area
					type="monotone"
					dataKey="rss"
					stroke={color}
					strokeWidth={1.5}
					fill={`url(#${gradientId})`}
					isAnimationActive={false}
					dot={false}
				/>
			</AreaChart>
		</ResponsiveContainer>
	);
}
