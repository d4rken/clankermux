// Color palette used across UI components
export const COLORS = {
	primary: "#f38020",
	success: "#10b981",
	warning: "#f59e0b",
	error: "#ef4444",
	blue: "#3b82f6",
	purple: "#8b5cf6",
	pink: "#ec4899",
	indigo: "#6366f1",
	cyan: "#06b6d4",
} as const;

/**
 * Qualitative palette for per-model data series.
 *
 * Deliberately separate from `COLORS`: those are SEMANTIC names (success,
 * warning, error, ...) that other components rely on, and there are only nine
 * of them — far too few to give every model a unique hue, which is why models
 * used to collide. Charts plot every model in the time range side by side, so
 * a data-series palette needs many mutually distinguishable hues and nothing
 * else.
 *
 * Every entry is taken verbatim from an established colorblind-safe
 * qualitative set (Okabe-Ito, and Paul Tol's bright/light/muted/vibrant
 * schemes). The 17 hues were picked to maximise the smallest pairwise CIE76
 * distance while keeping every pair at least ~9 dE apart under simulated
 * protanopia and deuteranopia, and every entry above L* 45 so it stays legible
 * on the dashboard's near-black chart background (hsl(220 13% 8%)).
 * model-colors.test.ts enforces the separation.
 */
export const MODEL_PALETTE = {
	blue: "#0077BB", // Tol vibrant blue
	orange: "#E69F00", // Okabe-Ito orange
	green: "#228833", // Tol bright green
	magenta: "#EE3377", // Tol vibrant magenta
	skyBlue: "#99DDFF", // Tol light cyan
	yellow: "#EEDD88", // Tol light yellow
	red: "#CC3311", // Tol vibrant red
	mint: "#44BB99", // Tol light mint
	purple: "#AA4499", // Tol muted purple
	pear: "#BBCC33", // Tol light pear
	peach: "#EE8866", // Tol light orange
	lightBlue: "#77AADD", // Tol light blue
	olive: "#999933", // Tol muted olive
	mauve: "#CC79A7", // Okabe-Ito reddish purple
	grey: "#DDDDDD", // Tol pale grey
	rose: "#EE6677", // Tol bright red
	pink: "#FFAABB", // Tol light pink
} as const;

// Chart color sequence for multi-series charts
export const CHART_COLORS = [
	COLORS.primary,
	COLORS.blue,
	COLORS.purple,
	COLORS.pink,
	COLORS.success,
] as const;

// Time range options for analytics
export type TimeRange = "1h" | "6h" | "24h" | "7d" | "30d" | "all";

export const TIME_RANGES: Record<TimeRange, string> = {
	"1h": "Last Hour",
	"6h": "Last 6 Hours",
	"24h": "Last 24 Hours",
	"7d": "Last 7 Days",
	"30d": "Last 30 Days",
	all: "All Time",
} as const;

// Chart dimensions
export const CHART_HEIGHTS = {
	compact: 180,
	small: 250,
	medium: 300,
	large: 400,
} as const;

// Common chart tooltip styles
export const CHART_TOOLTIP_STYLE = {
	default: {
		backgroundColor: "var(--background)",
		border: "1px solid var(--border)",
		borderRadius: "var(--radius)",
	},
	success: {
		backgroundColor: COLORS.success,
		border: `1px solid ${COLORS.success}`,
		borderRadius: "var(--radius)",
		color: "#fff",
	},
	dark: {
		backgroundColor: "rgba(0,0,0,0.8)",
		border: "1px solid rgba(255,255,255,0.2)",
		borderRadius: "8px",
		backdropFilter: "blur(8px)",
	},
} as const;

// Chart common properties
export const CHART_PROPS = {
	strokeDasharray: "3 3",
	gridClassName: "stroke-muted",
} as const;

// API and data refresh intervals (in milliseconds)
export const REFRESH_INTERVALS = {
	default: 30000, // 30 seconds
	fast: 10000, // 10 seconds
	slow: 60000, // 1 minute
} as const;

// API timeout
export const API_TIMEOUT = 30000; // 30 seconds

// React Query configuration
export const QUERY_CONFIG = {
	staleTime: 10000, // Consider data stale after 10 seconds
} as const;

// API default limits
export const API_LIMITS = {
	requestsDetail: 50,
	requestsSummary: 50,
} as const;
