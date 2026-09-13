import {
	isAccountAllowedByPin,
	isModelPermitted,
	matchRoutingRule,
	type RoutingPin,
	resolveRoutingTarget,
	supportsChatIngress,
	unsupportedChatField,
} from "@clankermux/core";
import type {
	Account,
	ChatRequirements,
	ModelPermissionSet,
	RequestMeta,
	ResolvedRoutingTarget,
	RoutingRule,
} from "@clankermux/types";
import { modelPermissionScope } from "./account-model-permissions";
import { isOfficialAnthropicProvider } from "./provider-overload-cooldown";

export class RoutingPolicyError extends Error {
	readonly code: string = "routing_policy_rejected";
	readonly statusCode: number = 403;
	readonly param: string | null = null;
	attemptRecorded = false;
	routeSnapshot?: string;
	ruleId?: string | null;
	constructor(message: string) {
		super(message);
		this.name = "RoutingPolicyError";
	}
}
export class ChatCapabilityError extends RoutingPolicyError {
	override readonly code = "unsupported_parameter";
	override readonly statusCode = 400;
	constructor(
		override readonly param: string,
		requestedModel: string,
	) {
		super(
			`No permitted destination for model "${requestedModel}" can honor Chat Completions field "${param}"`,
		);
	}
}
export interface AuthorizedTarget extends ResolvedRoutingTarget {
	readonly provider: string;
	readonly scope: string;
}
/** Operator-facing account label for rejections. Never carries a credential. */
export function routeAccountLabel(account: Account): string {
	return `${account.name || account.id} (${account.provider})`;
}
export interface BuildRouteInput {
	accounts: readonly Account[];
	rules: readonly RoutingRule[];
	requestedModel: string;
	apiKeyId: string | null;
	pin: RoutingPin | null;
	permissions: ReadonlyMap<string, ModelPermissionSet>;
	/**
	 * Why the caller already dropped an account, keyed by account ID. The pool
	 * handed in here is pre-filtered, so without these an operator sees no reason
	 * at all for the accounts that never reached the loop below.
	 */
	priorExclusions?: ReadonlyMap<string, string>;
	suppressedPairs?: ReadonlySet<string>;
	forcedAccountId?: string | null;
	headerAccountId?: string | null;
	excludeOfficialAnthropic?: boolean;
	chatRequirements?: ChatRequirements;
	/** Only in-process scheduler code supplies this, never client headers alone. */
	maintenance?: { accountId: string; purpose: "auto_refresh" | "keepalive" };
}
/** Private maps never escape: Object.freeze alone would not freeze a Map's entries. */
export class ResolvedRoute {
	readonly requestedModel: string;
	readonly ruleId: string | null;
	readonly snapshot: string;
	readonly maintenance: BuildRouteInput["maintenance"];
	readonly #rule: RoutingRule | null;
	readonly #targets: Map<string, Readonly<AuthorizedTarget>>;
	constructor(
		input: BuildRouteInput,
		rule: RoutingRule | null,
		targets: Map<string, AuthorizedTarget>,
	) {
		this.#rule = rule ? structuredClone(rule) : null;
		this.requestedModel = input.requestedModel;
		this.ruleId = rule?.id ?? null;
		this.maintenance = input.maintenance
			? Object.freeze({ ...input.maintenance })
			: undefined;
		this.#targets = new Map(
			[...targets].map(([id, target]) => [id, Object.freeze({ ...target })]),
		);
		this.snapshot = JSON.stringify({
			requestedModel: input.requestedModel,
			rule,
			pin: input.pin,
			forcedAccountId: input.forcedAccountId ?? null,
			headerAccountId: input.headerAccountId ?? null,
			excludeOfficialAnthropic: input.excludeOfficialAnthropic ?? false,
			maintenance: this.maintenance,
			chatRequirements: input.chatRequirements,
			targets: [...this.#targets].map(
				([id, { upstreamModel, targetSource, provider }]) => ({
					accountId: id,
					upstreamModel,
					targetSource,
					provider,
				}),
			),
		});
		Object.freeze(this);
	}
	permits(account: Account, permissions: ModelPermissionSet | null): boolean {
		const target = this.target(account);
		return (
			!!target &&
			(!!this.maintenance ||
				isModelPermitted(
					permissions,
					account.id,
					target.upstreamModel,
					this.#rule,
				))
		);
	}

	accountIds(): string[] {
		return [...this.#targets.keys()];
	}
	target(account: Account): Readonly<AuthorizedTarget> | null {
		const target = this.#targets.get(account.id);
		return target &&
			target.provider === account.provider &&
			target.scope === modelPermissionScope(account)
			? target
			: null;
	}
}
/** The destination restrictions that do not depend on the resolved model. */
export type DestinationRestrictions = Pick<
	BuildRouteInput,
	| "pin"
	| "forcedAccountId"
	| "headerAccountId"
	| "excludeOfficialAnthropic"
	| "maintenance"
>;
/**
 * Why this account cannot be a destination at all, or null if it can.
 *
 * Shared with the pre-filter in routing-service so one account cannot be
 * dropped there for a reason this file would have phrased differently.
 */
export function destinationExclusionReason(
	account: Account,
	input: DestinationRestrictions,
	rule: RoutingRule | null,
): string | null {
	if (!isAccountAllowedByPin(input.pin ?? null, account))
		return "excluded by the API key's destinations";
	if (
		input.excludeOfficialAnthropic &&
		isOfficialAnthropicProvider(account.provider)
	)
		return "official Anthropic accounts are excluded from this attempt";
	if (input.forcedAccountId && input.forcedAccountId !== account.id)
		return "another account was forced for this request";
	if (input.headerAccountId && input.headerAccountId !== account.id)
		return "another account was named by request header";
	if (input.maintenance && input.maintenance.accountId !== account.id)
		return "maintenance requests target one named account";
	if (rule?.pool_kind === "provider" && rule.pool_provider !== account.provider)
		return `rule "${rule.name}" pools provider ${rule.pool_provider}`;
	if (
		rule?.pool_kind === "accounts" &&
		!rule.pool_account_ids?.includes(account.id)
	)
		return `rule "${rule.name}" does not pool this account`;
	return null;
}
export function buildResolvedRoute(input: BuildRouteInput): ResolvedRoute {
	if (!input.requestedModel?.trim())
		throw new RoutingPolicyError("Inference requests require a model");
	if (
		input.pin &&
		(input.pin.accountId === "" ||
			(input.pin.providers !== null &&
				(!input.pin.providers.length || input.pin.accountId !== null)))
	)
		throw new RoutingPolicyError("Invalid API key destinations");
	const winning = input.maintenance
		? null
		: matchRoutingRule(input.rules, input.apiKeyId, input.requestedModel);
	const targets = new Map<string, AuthorizedTarget>();
	// Why each account dropped out, in pool order, so the rejection can say what
	// an operator would otherwise have to reconstruct from the dashboard.
	const exclusions: string[] = [];
	const exclude = (account: Account, reason: string): void => {
		exclusions.push(`${routeAccountLabel(account)}: ${reason}`);
	};
	let unsupportedProvider = false;
	let unsupportedField: string | null = null;
	for (const account of input.accounts) {
		const blocked = destinationExclusionReason(account, input, winning);
		if (blocked) {
			exclude(account, blocked);
			continue;
		}
		// Keepalive replays an already resolved model. Everything else takes the
		// routing table's answer, which is the requested model unless a literal
		// rule names another.
		const resolved =
			input.maintenance?.purpose === "keepalive"
				? {
						upstreamModel: input.requestedModel,
						targetSource: "requested" as const,
					}
				: resolveRoutingTarget(winning, input.requestedModel);
		if (
			!input.maintenance &&
			!isModelPermitted(
				input.permissions.get(account.id) ?? null,
				account.id,
				resolved.upstreamModel,
				winning,
			)
		) {
			exclude(account, `does not permit model "${resolved.upstreamModel}"`);
			continue;
		}
		if (
			input.suppressedPairs?.has(
				JSON.stringify([account.id, resolved.upstreamModel]),
			)
		) {
			exclude(
				account,
				`model "${resolved.upstreamModel}" is suppressed on this account`,
			);
			continue;
		}
		if (input.chatRequirements) {
			if (!supportsChatIngress(account.provider)) {
				unsupportedProvider = true;
				exclude(
					account,
					`provider ${account.provider} has no Chat Completions ingress`,
				);
				continue;
			}
			const field = unsupportedChatField(
				account.provider,
				input.chatRequirements,
			);
			if (field) {
				unsupportedField ??= field;
				exclude(account, `cannot honor Chat Completions field "${field}"`);
				continue;
			}
		}
		targets.set(account.id, {
			...resolved,
			provider: account.provider,
			scope: modelPermissionScope(account),
		});
	}
	if (!targets.size) {
		const error = unsupportedField
			? new ChatCapabilityError(unsupportedField, input.requestedModel)
			: unsupportedProvider
				? new RoutingPolicyError(
						`No permitted destination for model "${input.requestedModel}" supports Chat Completions; supported providers are codex and openrouter`,
					)
				: new RoutingPolicyError(
						`No permitted destination/model pair for model "${input.requestedModel}" survives API key destinations${winning ? ` and routing rule "${winning.name}"` : ""}${input.forcedAccountId || input.headerAccountId ? " and forced account selection" : ""}.${describeExclusions(
							[...(input.priorExclusions?.values() ?? []), ...exclusions],
						)} Permit the model on an account, or add a routing rule targeting a model it already permits.`,
					);
		error.routeSnapshot = new ResolvedRoute(input, winning, targets).snapshot;
		error.ruleId = winning?.id ?? null;
		throw error;
	}
	return new ResolvedRoute(input, winning, targets);
}
/** Bounded: a large pool must not turn one rejection into a log-sized message. */
const REPORTED_EXCLUSIONS = 8;
function describeExclusions(reasons: readonly string[]): string {
	if (!reasons.length) return " No account was even considered.";
	const shown = reasons.slice(0, REPORTED_EXCLUSIONS);
	const rest = reasons.length - shown.length;
	return ` Excluded: ${shown.join("; ")}${rest ? `; and ${rest} more account(s)` : ""}.`;
}
const routes = new WeakMap<RequestMeta, ResolvedRoute>();
export function installResolvedRoute(
	meta: RequestMeta,
	route: ResolvedRoute,
): void {
	if (routes.has(meta))
		throw new RoutingPolicyError(
			"A request's routing policy cannot be replaced",
		);
	routes.set(meta, route);
}
export function getResolvedRoute(meta: RequestMeta): ResolvedRoute {
	const route = routes.get(meta);
	if (!route)
		throw new RoutingPolicyError(
			"Request has no resolved routing authorization",
		);
	return route;
}
export function getAttemptTarget(
	meta: RequestMeta,
	account: Account,
): Readonly<AuthorizedTarget> {
	const target = getResolvedRoute(meta).target(account);
	if (!target)
		throw new RoutingPolicyError(
			`Account ${account.id} is outside this request's authorized destinations or its identity changed`,
		);
	return target;
}
export function rejectModelSwitchFields(body: Record<string, unknown>): void {
	for (const field of ["models", "fallbacks", "model_fallbacks", "route"]) {
		if (Object.hasOwn(body, field))
			throw new RoutingPolicyError(
				`Request field "${field}" can override the resolved model`,
			);
	}
	// Known provider passthrough container; tool inputs and message content are data.
	if (
		body.extra_body &&
		typeof body.extra_body === "object" &&
		!Array.isArray(body.extra_body)
	) {
		const extra = body.extra_body as Record<string, unknown>;
		if (Object.hasOwn(extra, "model"))
			throw new RoutingPolicyError(
				"extra_body.model can override the resolved model",
			);
		rejectModelSwitchFields(extra);
	}
}
export async function enforceOutgoingModel(
	request: Request,
	expectedModel: string,
): Promise<string> {
	let body: unknown;
	try {
		body = await request.clone().json();
	} catch {
		throw new RoutingPolicyError(
			"Cannot verify serialized upstream request model",
		);
	}
	if (!body || typeof body !== "object" || Array.isArray(body))
		throw new RoutingPolicyError("Upstream request must be a JSON object");
	const object = body as Record<string, unknown>;
	rejectModelSwitchFields(object);
	if (object.model !== expectedModel)
		throw new RoutingPolicyError(
			`Upstream transformation changed the authorized model ${expectedModel}`,
		);
	return expectedModel;
}
