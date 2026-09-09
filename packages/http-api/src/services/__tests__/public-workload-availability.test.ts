import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@clankermux/config";
import {
	applyProviderOverloadCooldown,
	clearProviderOverloadCooldown,
	inspectProviderOverload,
	tryAcquireProviderOverloadProbe,
} from "@clankermux/proxy";
import type { Account, AnthropicUsageData } from "@clankermux/types";
import type { PublicAccountSnapshot } from "../public-snapshot";
import { buildWorkloadAvailability } from "../public-workload-availability";

const NOW = 1700000000000;
const config = { getUsageThrottlingWeeklyEnabled: () => false } as Config;
const account = {
	id: "a",
	name: "Example",
	provider: "anthropic",
	paused: false,
	availableAtMs: null,
	windows: [{ kind: "weekly_scoped", scopeId: "fable", label: "Fable" }],
} as PublicAccountSnapshot;
const routing = { id: "a", name: "Example", provider: "anthropic" } as Account;
function usage(scoped = 100): AnthropicUsageData {
	return {
		five_hour: {
			utilization: 10,
			resets_at: new Date(NOW + 3600000).toISOString(),
		},
		seven_day: {
			utilization: 40,
			resets_at: new Date(NOW + 86400000).toISOString(),
		},
		limits: [
			{
				kind: "weekly_scoped",
				group: "7d",
				percent: scoped,
				resets_at: new Date(NOW + 86400000).toISOString(),
				scope: { model: { id: "fable", display_name: "Fable" } },
				is_active: true,
			},
		],
	};
}
const read = (data: AnthropicUsageData | null = usage()) =>
	buildWorkloadAvailability(
		[account],
		[routing],
		["a"],
		new Map([["a", data]]),
		true,
		config,
		NOW,
	);
beforeEach(() => clearProviderOverloadCooldown());
afterEach(() => clearProviderOverloadCooldown());
describe("workload availability", () => {
	it("does not equate provider availability with family availability", () => {
		const rows = read();
		expect(
			rows.find((r) => r.id === "class:anthropic")?.availableAccounts,
		).toBe(1);
		expect(rows.find((r) => r.id === "family:fable")).toMatchObject({
			availableAccounts: 0,
			constrainedAccounts: 1,
			nextRecoveryAtMs: NOW + 86400000,
			parentId: "class:anthropic",
		});
	});
	it("missing readings do not become hard routing exclusions", () => {
		expect(read(null).every((r) => r.availableAccounts === 1)).toBe(true);
	});
	it("unknown routing evaluation is distinct from no candidates", () => {
		const rows = buildWorkloadAvailability(
			[account],
			[routing],
			[],
			new Map(),
			false,
			config,
			NOW,
		);
		expect(
			rows.every((r) => r.unknownAccounts === 1 && r.constrainedAccounts === 0),
		).toBe(true);
	});
	it("does not promise recovery while an untimed hold remains", () => {
		const rows = buildWorkloadAvailability(
			[{ ...account, paused: true }],
			[routing],
			[],
			new Map([["a", usage()]]),
			true,
			config,
			NOW,
		);
		expect(
			rows.every(
				(r) => r.availableAccounts === 0 && r.nextRecoveryAtMs === null,
			),
		).toBe(true);
	});
	it("evaluates optional family pacing using the routing policy", () => {
		const rows = buildWorkloadAvailability(
			[account],
			[routing],
			["a"],
			new Map([["a", usage(98)]]),
			true,
			{ ...config, getUsageThrottlingWeeklyEnabled: () => true } as Config,
			NOW,
		);
		expect(rows.find((r) => r.id === "family:fable")?.constrainedAccounts).toBe(
			1,
		);
	});
});

it.each([
	null,
	"fable",
])("active overload probe blocks only its scope without claiming recovery: %s", (model) => {
	const until = applyProviderOverloadCooldown(
		"anthropic",
		Date.now() + 1000,
		model,
	);
	const now = until + 1;
	expect(
		tryAcquireProviderOverloadProbe("anthropic", model, now).admitted,
	).toBe(true);
	const before = inspectProviderOverload("anthropic", model, now);
	const rows = buildWorkloadAvailability(
		[account],
		[routing],
		["a"],
		new Map(),
		true,
		config,
		now,
	);
	expect(rows.find((r) => r.id === "family:fable")).toMatchObject({
		availableAccounts: 0,
		constrainedAccounts: 1,
		nextRecoveryAtMs: null,
	});
	expect(rows.find((r) => r.id === "class:anthropic")?.availableAccounts).toBe(
		model ? 1 : 0,
	);
	expect(inspectProviderOverload("anthropic", model, now)).toEqual(before);
});
