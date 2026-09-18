import type { HueName } from "../../hooks/useSeriesPalette";
import {
	type ClientEfficiencyGroup,
	perCoveredRequest,
	tokensPerRequest,
} from "./client-efficiency-rollup";

export interface BreakdownPart {
	label: string;
	hue: HueName;
	value: number | null;
}

export function harnessLabel(group: ClientEfficiencyGroup): string {
	return group.label === "claude-code" ? "Claude Code" : group.label;
}

export function tokenParts(group: ClientEfficiencyGroup): BreakdownPart[] {
	return [
		{ label: "Uncached input", hue: "grey" as const, sum: group.inputTokens },
		{ label: "Cache reads", hue: "green" as const, sum: group.cacheReadTokens },
		{
			label: "Cache writes",
			hue: "tan" as const,
			sum: group.cacheCreationTokens,
		},
		{ label: "Output", hue: "blue" as const, sum: group.outputTokens },
	].map(({ label, hue, sum }) => ({
		label,
		hue,
		value: perCoveredRequest(sum, group.requests),
	}));
}

export function contextParts(group: ClientEfficiencyGroup): BreakdownPart[] {
	const context = group.contextBreakdown;
	return [
		{
			label: "System prompt",
			hue: "blue" as const,
			sum: context.systemCharsSum,
		},
		{
			label: "Tool definitions",
			hue: "tan" as const,
			sum: context.toolsCharsSum,
		},
		{
			label: "Tool results",
			hue: "green" as const,
			sum: context.toolResultCharsSum,
		},
		{
			label: "Other history",
			hue: "purple" as const,
			sum: context.otherMessagesCharsSum,
		},
	].map(({ label, hue, sum }) => ({
		label,
		hue,
		value: perCoveredRequest(sum, context.coveredRequests),
	}));
}

export function tokenDifference(
	baseline: ClientEfficiencyGroup,
	comparison: ClientEfficiencyGroup,
) {
	const before = tokensPerRequest(baseline);
	const after = tokensPerRequest(comparison);
	if (before === null || after === null) return null;
	const delta = after - before;
	const baseParts = tokenParts(baseline);
	const changes = tokenParts(comparison).map((part, index) => ({
		label: part.label,
		delta: (part.value ?? 0) - (baseParts[index].value ?? 0),
	}));
	changes.sort((a, b) => (delta < 0 ? a.delta - b.delta : b.delta - a.delta));
	return { delta, driver: changes[0].label, driverDelta: changes[0].delta };
}
