import { createHash } from "node:crypto";
import {
	SDK_BRIDGE_PI_PROMPT_HEADER,
	type SdkBridgeSystemPromptDetail,
	SUPPORTED_PI_PROMPT_VERSIONS,
} from "@clankermux/types";
import type { BridgeError } from "./errors";
import { piPromptHead, stripPiHead } from "./pi-prompt";

/** What the client's system prompt becomes on top of Claude Code's own. */
export interface SystemPromptDecision {
	/** Text appended to the claude_code preset; null sends the preset alone. */
	append: string | null;
	excludeDynamicSections: boolean;
}

export interface SystemPromptPolicyTurn {
	model: string;
	clientHarness: string | null;
	piPromptVersion: string | null;
}

export type SystemPromptOutcome =
	| {
			ok: true;
			decision: SystemPromptDecision;
			detail: SdkBridgeSystemPromptDetail | null;
	  }
	| {
			ok: false;
			error: BridgeError;
			/** The key the rejection is counted under. */
			reason: string;
			detail: SdkBridgeSystemPromptDetail;
	  };

export interface SystemPromptPolicy {
	/** Recorded on the turn row as `system_prompt_policy`. */
	readonly name: string;
	/** Never throws: a prompt the policy cannot serve is a refusal. */
	decide(
		clientSystem: string,
		turn: SystemPromptPolicyTurn,
	): SystemPromptOutcome;
}

/**
 * Claude Code's preset alone; the client's system text is never sent. Stock
 * pi's prompt contains phrases that reproducibly draw a 400 "out of extra
 * usage" from subscription accounts.
 */
export const dropSystemPromptPolicy: SystemPromptPolicy = {
	name: "drop",
	decide: () => ({
		ok: true,
		decision: { append: null, excludeDynamicSections: false },
		detail: null,
	}),
};

const PI_POLICY = "pi-head-v1";

function refusal(
	code: string,
	message: string,
	detail: {
		version: string | null;
		reason: string;
		section: string | null;
		text: string;
	},
): SystemPromptOutcome {
	return {
		ok: false,
		error: {
			status: 400,
			type: "invalid_request_error",
			code,
			message,
			retryAfter: null,
		},
		reason: code.replace(/^sdk_bridge_/, ""),
		detail: {
			outcome: "refused",
			version: detail.version,
			code,
			reason: detail.reason,
			section: detail.section,
			promptLength: detail.text.length,
			promptSha256: createHash("sha256").update(detail.text).digest("hex"),
		},
	};
}

/**
 * pi's prompt minus pi's own harness head (see `stripPiHead`), for the
 * prompt layout pi declares in {@link SDK_BRIDGE_PI_PROMPT_HEADER}. An
 * undeclared or unknown layout, a head that cannot be told apart, and
 * forwarded text subscription accounts reject are each refused, never sent
 * as `drop`: that turn would run without the instructions the client sent.
 */
export const piHeadSystemPromptPolicy: SystemPromptPolicy = {
	name: PI_POLICY,
	decide(clientSystem, turn) {
		const version = turn.piPromptVersion;
		const head = version ? piPromptHead(version) : null;
		if (!version || !head)
			return refusal(
				"sdk_bridge_prompt_unsupported",
				`${PI_POLICY} serves pi prompt layout ${SUPPORTED_PI_PROMPT_VERSIONS.join(", ")}; this request ${
					version
						? `declared "${version}"`
						: `did not send ${SDK_BRIDGE_PI_PROMPT_HEADER}`
				}`,
				{
					version,
					reason: version ? "unsupported_version" : "missing_version",
					section: null,
					text: clientSystem,
				},
			);
		const strip = stripPiHead(clientSystem, head);
		if (strip.ok)
			return {
				ok: true,
				decision: { append: strip.append, excludeDynamicSections: false },
				detail: {
					outcome: "forwarded",
					version,
					headStripped: strip.headStripped,
					forwardedLength: strip.append?.length ?? 0,
					removedUpdates: strip.removedUpdates,
					sectionsSeen: strip.sectionsSeen,
				},
			};
		if (strip.kind === "refused")
			return refusal(
				"sdk_bridge_prompt_refused",
				`${PI_POLICY}: the forwarded system prompt carries text subscription accounts reject (${strip.reason}); nothing was sent`,
				{ version, reason: strip.reason, section: null, text: clientSystem },
			);
		const where = strip.section ? ` (</${strip.section}>)` : "";
		return refusal(
			"sdk_bridge_prompt_malformed",
			`${PI_POLICY}: pi's head in the system prompt cannot be told apart under layout ${version} (${strip.reason}${where})`,
			{
				version,
				reason: strip.reason,
				section: strip.section,
				text: clientSystem,
			},
		);
	},
};

const POLICIES: ReadonlyMap<string, SystemPromptPolicy> = new Map([
	[dropSystemPromptPolicy.name, dropSystemPromptPolicy],
	[piHeadSystemPromptPolicy.name, piHeadSystemPromptPolicy],
]);

export function registeredSystemPromptPolicies(): string[] {
	return [...POLICIES.keys()];
}

export function getSystemPromptPolicy(name = "drop"): SystemPromptPolicy {
	const policy = POLICIES.get(name);
	if (!policy) throw new Error(`Unknown system prompt policy "${name}"`);
	return policy;
}

/** pi's prompt goes without pi's head; every other client's is dropped. */
export function selectSystemPromptPolicy(
	clientHarness: string | null,
): SystemPromptPolicy {
	return clientHarness === "pi"
		? piHeadSystemPromptPolicy
		: dropSystemPromptPolicy;
}
