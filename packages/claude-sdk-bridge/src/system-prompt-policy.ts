import { createHash } from "node:crypto";
import {
	SDK_BRIDGE_PI_PROMPT_HEADER,
	type SdkBridgeSystemPromptDetail,
} from "@clankermux/types";
import type { BridgeError } from "./errors";
import {
	type PiProjection,
	piPromptLayout,
	projectPiPrompt,
	SUPPORTED_PI_PROMPT_VERSIONS,
} from "./pi-prompt";

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

const PI_POLICY = "pi-projection-v1";

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
 * pi's own instructions projected onto the preset (see `projectPiPrompt`),
 * for the prompt layout pi declares in {@link SDK_BRIDGE_PI_PROMPT_HEADER}.
 * An undeclared or unknown layout, a prompt that does not parse as the
 * declared one, and a projection carrying the text subscription accounts
 * reject are each refused, never sent as `drop`: that turn would run
 * without the persona or the project rules the client sent.
 */
export const piProjectionSystemPromptPolicy: SystemPromptPolicy = {
	name: PI_POLICY,
	decide(clientSystem, turn) {
		const version = turn.piPromptVersion;
		const layout = version ? piPromptLayout(version) : null;
		if (!version || !layout)
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
		let projection: PiProjection;
		try {
			projection = projectPiPrompt(clientSystem, layout);
		} catch {
			// A defect of the parser, still answered as a refusal rather than a throw.
			return refusal(
				"sdk_bridge_prompt_malformed",
				`${PI_POLICY}: the system prompt could not be read as pi prompt layout ${version}`,
				{ version, reason: "unparseable", section: null, text: clientSystem },
			);
		}
		if (projection.ok)
			return {
				ok: true,
				decision: {
					append: projection.append,
					excludeDynamicSections: false,
				},
				detail: {
					outcome: "projected",
					version,
					shape: projection.shape,
					droppedSections: projection.droppedSections,
					sectionUpdates: projection.sectionUpdates,
				},
			};
		const where = projection.section ? ` (${projection.section})` : "";
		const facts = {
			version,
			reason: projection.reason,
			section: projection.section,
			text: clientSystem,
		};
		if (projection.kind === "refused")
			return refusal(
				"sdk_bridge_prompt_refused",
				`${PI_POLICY}: the projected system prompt carries text subscription accounts reject (${projection.reason}${where}); nothing was sent`,
				facts,
			);
		return refusal(
			"sdk_bridge_prompt_malformed",
			`${PI_POLICY}: the system prompt does not parse as pi prompt layout ${version} (${projection.reason}${where})`,
			facts,
		);
	},
};

const POLICIES: ReadonlyMap<string, SystemPromptPolicy> = new Map([
	[dropSystemPromptPolicy.name, dropSystemPromptPolicy],
	[piProjectionSystemPromptPolicy.name, piProjectionSystemPromptPolicy],
]);

export function registeredSystemPromptPolicies(): string[] {
	return [...POLICIES.keys()];
}

export function getSystemPromptPolicy(name = "drop"): SystemPromptPolicy {
	const policy = POLICIES.get(name);
	if (!policy) throw new Error(`Unknown system prompt policy "${name}"`);
	return policy;
}

/** pi's prompt is projected; every other client's is dropped. */
export function selectSystemPromptPolicy(
	clientHarness: string | null,
): SystemPromptPolicy {
	return clientHarness === "pi"
		? piProjectionSystemPromptPolicy
		: dropSystemPromptPolicy;
}
