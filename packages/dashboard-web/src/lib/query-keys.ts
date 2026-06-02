export const queryKeys = {
	all: ["clankermux"] as const,
	accounts: () => [...queryKeys.all, "accounts"] as const,
	forcedAccount: () => [...queryKeys.all, "forced-account"] as const,
	stats: (errorsSinceHours?: number) =>
		errorsSinceHours !== undefined
			? ([...queryKeys.all, "stats", { errorsSinceHours }] as const)
			: ([...queryKeys.all, "stats"] as const),
	analytics: (
		timeRange?: string,
		filters?: unknown,
		modelBreakdown?: boolean,
	) =>
		[
			...queryKeys.all,
			"analytics",
			{ timeRange, filters, modelBreakdown },
		] as const,
	usageHistory: (range?: string) =>
		[...queryKeys.all, "usage-history", { range }] as const,
	requests: (limit?: number) =>
		[...queryKeys.all, "requests", { limit }] as const,
	logs: () => [...queryKeys.all, "logs"] as const,
	logHistory: () => [...queryKeys.all, "logs", "history"] as const,
	combos: () => [...queryKeys.all, "combos"] as const,
	families: () => [...queryKeys.all, "families"] as const,
	apiKeys: () => [...queryKeys.all, "api-keys"] as const,
	storage: () => [...queryKeys.all, "storage"] as const,
	systemStatus: () => [...queryKeys.all, "system-status"] as const,
} as const;
