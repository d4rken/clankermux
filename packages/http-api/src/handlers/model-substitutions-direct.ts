import { AccountRepository, RoutingRepository } from "@clankermux/database";
import { jsonResponse } from "@clankermux/http-common";
import { BACKEND_RESOLVED_SLUGS, isModelSubstitution } from "@clankermux/proxy";
import type {
	Account,
	DegradedAccount,
	ModelSubstitutionPair,
	ModelSubstitutionPoint,
	ModelSubstitutionsResponse,
} from "@clankermux/types";
import {
	MODEL_SUBSTITUTION_ACTIVE_MIN_ATTEMPTS,
	MODEL_SUBSTITUTION_ACTIVE_MIN_SHARE,
	MODEL_SUBSTITUTION_ACTIVE_WINDOW_MS,
	substitutionShare,
} from "@clankermux/types";
import type { APIContext } from "../types";
import { getRangeConfig } from "./range-config";
import { normalizeRange } from "./usage-history-shared";

/**
 * Serves all three substitution surfaces from one query: the Accounts chip, the
 * Overview banner and the analytics card. The chip and banner do not live on
 * the analytics page, so a dedicated endpoint was needed regardless; the card
 * reuses it rather than adding a section to the consolidated payload.
 */

export interface ModelSubstitutionSources {
	getModelSubstitutions: (opts: {
		sinceMs: number;
		bucketMs: number;
	}) => Promise<{
		pairs: Array<{
			accountId: string;
			provider: string;
			outgoingModel: string;
			reportedModel: string;
			substituted: number;
			firstAtMs: number;
			lastAtMs: number;
		}>;
		comparable: Array<{
			accountId: string;
			outgoingModel: string;
			comparable: number;
		}>;
		series: Array<{
			bucketMs: number;
			substituted: number;
			comparable: number;
		}>;
	}>;
	getAllAccounts: () => Promise<Account[]>;
	now?: () => number;
}

/**
 * The same rule the proxy fails over on, applied again here.
 *
 * Re-checking rather than trusting the stored rows is deliberate: rows written
 * before a normalisation existed would otherwise keep reading as substitutions
 * forever. A dated snapshot recorded last week must stop showing as a swap the
 * moment the comparison learns that spelling.
 */
function isRealSubstitution(outgoing: string, reported: string): boolean {
	return isModelSubstitution(outgoing, reported);
}

export function computeModelSubstitutions(
	raw: Awaited<ReturnType<ModelSubstitutionSources["getModelSubstitutions"]>>,
	accounts: readonly Account[],
	nowMs: number,
): ModelSubstitutionsResponse {
	const nameById = new Map(accounts.map((a) => [a.id, a.name]));
	const comparableByKey = new Map(
		raw.comparable.map((c) => [
			`${c.accountId}\u0000${c.outgoingModel}`,
			c.comparable,
		]),
	);
	const pairs: ModelSubstitutionPair[] = raw.pairs
		.filter((p) => isRealSubstitution(p.outgoingModel, p.reportedModel))
		.map((p) => ({
			accountId: p.accountId,
			accountName: nameById.get(p.accountId) ?? p.accountId,
			provider: p.provider,
			outgoingModel: p.outgoingModel,
			reportedModel: p.reportedModel,
			substituted: p.substituted,
			comparable:
				comparableByKey.get(`${p.accountId}\u0000${p.outgoingModel}`) ??
				p.substituted,
			firstAtMs: p.firstAtMs,
			lastAtMs: p.lastAtMs,
		}))
		.sort((a, b) => b.lastAtMs - a.lastAtMs);

	// "Degraded now" is a judgement the rows cannot make on their own: they are
	// a history. Recency, share and a floor on the sample together decide it.
	const activeSince = nowMs - MODEL_SUBSTITUTION_ACTIVE_WINDOW_MS;
	const byAccount = new Map<string, ModelSubstitutionPair[]>();
	for (const pair of pairs) {
		if (pair.lastAtMs < activeSince) continue;
		if (pair.comparable < MODEL_SUBSTITUTION_ACTIVE_MIN_ATTEMPTS) continue;
		if (substitutionShare(pair) < MODEL_SUBSTITUTION_ACTIVE_MIN_SHARE) continue;
		const list = byAccount.get(pair.accountId);
		if (list) list.push(pair);
		else byAccount.set(pair.accountId, [pair]);
	}
	const degraded: DegradedAccount[] = [...byAccount.entries()]
		.map(([accountId, list]) => ({
			accountId,
			accountName: list[0]?.accountName ?? accountId,
			provider: list[0]?.provider ?? "unknown",
			pairs: [...list].sort(
				(a, b) => substitutionShare(b) - substitutionShare(a),
			),
		}))
		.sort((a, b) => a.accountName.localeCompare(b.accountName));

	const series: ModelSubstitutionPoint[] = raw.series.map((point) => ({
		bucketMs: point.bucketMs,
		substituted: point.substituted,
		comparable: point.comparable,
	}));

	return { pairs, degraded, series, generatedAtMs: nowMs };
}

export function createModelSubstitutionsHandlerFromSources(
	sources: ModelSubstitutionSources,
): (params: URLSearchParams) => Promise<Response> {
	return async (params: URLSearchParams) => {
		const range = normalizeRange(params.get("range"));
		const { bucketMs, windowMs } = getRangeConfig(range);
		const nowMs = sources.now?.() ?? Date.now();
		const sinceMs = windowMs === null ? 0 : nowMs - windowMs;
		const [raw, accounts] = await Promise.all([
			sources.getModelSubstitutions({ sinceMs, bucketMs }),
			sources.getAllAccounts(),
		]);
		return jsonResponse(computeModelSubstitutions(raw, accounts, nowMs));
	};
}

/**
 * Repositories are constructed from the ADAPTER, never reached through
 * `context.dbOps`. This handler also runs inside the analytics worker, whose
 * synthetic APIContext carries only `getAdapter()` — going through `dbOps`
 * there throws on every call, and does so in a place no unit test driving the
 * sources seam can see.
 */
export function createModelSubstitutionsHandler(
	context: APIContext,
): (params: URLSearchParams) => Promise<Response> {
	const adapter = context.dbOps.getAdapter();
	const routing = new RoutingRepository(adapter);
	const accounts = new AccountRepository(adapter);
	return createModelSubstitutionsHandlerFromSources({
		getModelSubstitutions: (opts) => routing.getModelSubstitutions(opts),
		// Disabled accounts included: an account taken out of rotation can still
		// own substitutions recorded while it was live, and the history must not
		// silently rename them to a bare id.
		getAllAccounts: () => accounts.findAll(true),
	});
}

/** Exported for the test that pins the virtual-slug exclusion. */
export { BACKEND_RESOLVED_SLUGS };
