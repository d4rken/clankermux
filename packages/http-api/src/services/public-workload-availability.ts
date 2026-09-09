import type { Config } from "@clankermux/config";
import { getModelFamily, servableClassFor } from "@clankermux/core";
import {
	type AnyUsageData,
	getAccountCapacitySignal,
} from "@clankermux/providers";
import {
	getProviderOverloadSnapshot,
	inspectProviderOverload,
	resolveFamilyWeeklyExclusion,
	resolveFamilyWeeklyPacing,
} from "@clankermux/proxy";
import type { Account } from "@clankermux/types";
import type { PublicAccountSnapshot } from "./public-snapshot";

export interface WorkloadAvailability {
	id: string;
	label: string;
	parentId: string | null;
	computedAtMs: number;
	availableAccounts: number;
	constrainedAccounts: number;
	unknownAccounts: number;
	nextRecoveryAtMs: number | null;
}

/** Uses the routing candidate set plus the same pure family gates as request admission. */
export function buildWorkloadAvailability(
	accounts: PublicAccountSnapshot[],
	routingAccounts: Account[],
	candidateIds: readonly string[],
	freshUsage: ReadonlyMap<string, AnyUsageData | null>,
	strategyKnown: boolean,
	config: Pick<Config, "getUsageThrottlingWeeklyEnabled">,
	now: number,
): WorkloadAvailability[] {
	const groups = new Map<
		string,
		{ label: string; family: string | null; classIds: Set<string> }
	>();
	for (const a of accounts) {
		const cls = servableClassFor(a.provider);
		groups.set(`class:${cls.classId}`, {
			label: cls.label,
			family: null,
			classIds: new Set([cls.classId]),
		});
		for (const w of a.windows) {
			if (w.kind !== "weekly_scoped" || !w.scopeId) continue;
			const id = `family:${w.scopeId}`;
			const group = groups.get(id) ?? {
				label: w.label ?? w.scopeId,
				family: w.scopeId,
				classIds: new Set<string>(),
			};
			group.classIds.add(cls.classId);
			groups.set(id, group);
		}
	}
	return [...groups].map(([id, group]) => {
		const result: WorkloadAvailability = {
			id,
			label: group.label,
			parentId:
				group.family && group.classIds.size === 1
					? `class:${[...group.classIds][0]}`
					: null,
			computedAtMs: now,
			availableAccounts: 0,
			constrainedAccounts: 0,
			unknownAccounts: 0,
			nextRecoveryAtMs: null,
		};
		for (const a of accounts.filter((a) =>
			group.classIds.has(servableClassFor(a.provider).classId),
		)) {
			if (!strategyKnown) {
				result.unknownAccounts++;
				continue;
			}
			const routingAccount = routingAccounts.find((r) => r.id === a.id);
			if (!routingAccount) {
				result.unknownAccounts++;
				continue;
			}
			let eligible = candidateIds.includes(a.id);
			let recovery = eligible ? null : a.availableAtMs;
			let unscheduled = !eligible && recovery === null;
			const model = group.family;
			const overload = model
				? inspectProviderOverload(a.provider, model, now)
				: getProviderOverloadSnapshot(a.provider, now).find(
						(b) => b.family === null,
					);
			if (overload?.until != null) {
				eligible = false;
				recovery = Math.max(recovery ?? 0, overload.until);
			}
			if (overload?.probeActive) {
				eligible = false;
				unscheduled = true;
			}
			if (model && getModelFamily(model) && a.provider === "anthropic") {
				const data = freshUsage.get(a.id) ?? null;
				const capacity = getAccountCapacitySignal(data, a.provider, now);
				const excluded = resolveFamilyWeeklyExclusion(
					routingAccount,
					model,
					data,
					capacity,
					now,
				);
				const paced = config.getUsageThrottlingWeeklyEnabled()
					? resolveFamilyWeeklyPacing(
							routingAccount,
							model,
							data,
							capacity,
							now,
						)
					: null;
				const until = Math.max(excluded?.resetAt ?? 0, paced?.resumeAt ?? 0);
				if (until) {
					eligible = false;
					recovery = Math.max(recovery ?? 0, until);
				}
			}
			if (eligible) result.availableAccounts++;
			else {
				result.constrainedAccounts++;
				if (!unscheduled && recovery && recovery > now)
					result.nextRecoveryAtMs =
						result.nextRecoveryAtMs === null
							? recovery
							: Math.min(result.nextRecoveryAtMs, recovery);
			}
		}
		return result;
	});
}
