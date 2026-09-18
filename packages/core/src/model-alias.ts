import type { ModelAlias, ModelAliasTarget } from "@clankermux/types";

/** The prefix is reserved even when the remainder is not a valid alias ID. */
export function isModelAliasId(model: string): boolean {
	return model.startsWith("alias:");
}

export function validateModelAlias(value: unknown): ModelAlias {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Model alias must be an object");
	const alias = value as ModelAlias;
	if (
		typeof alias.id !== "string" ||
		!/^alias:[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(alias.id)
	)
		throw new Error(
			"Alias ID must start with alias: and contain a name using letters, numbers, dots, underscores, or hyphens",
		);
	if (
		typeof alias.displayName !== "string" ||
		!alias.displayName.trim() ||
		alias.displayName !== alias.displayName.trim() ||
		alias.displayName.length > 256
	)
		throw new Error("Invalid alias display name");
	if (
		!Number.isSafeInteger(alias.revision) ||
		alias.revision < 0 ||
		alias.revision === Number.MAX_SAFE_INTEGER
	)
		throw new Error("Alias revision must be a nonnegative safe integer");
	if (
		!Array.isArray(alias.targets) ||
		alias.targets.length === 0 ||
		alias.targets.length > 16
	)
		throw new Error("Model alias requires between 1 and 16 ordered targets");
	const models = new Set<string>();
	const targets = alias.targets.map((target): ModelAliasTarget => {
		if (
			!target ||
			typeof target !== "object" ||
			Array.isArray(target) ||
			typeof target.model !== "string" ||
			!target.model.trim() ||
			target.model !== target.model.trim() ||
			target.model.length > 256
		)
			throw new Error("Invalid alias target model");
		if (isModelAliasId(target.model))
			throw new Error(
				"Alias targets must be concrete models; nested aliases are not supported",
			);
		if (models.has(target.model))
			throw new Error("Duplicate alias target model");
		models.add(target.model);
		if (
			target.accountIds !== null &&
			(!Array.isArray(target.accountIds) ||
				target.accountIds.length === 0 ||
				target.accountIds.length > 1000 ||
				target.accountIds.some(
					(id) =>
						typeof id !== "string" ||
						!id.trim() ||
						id !== id.trim() ||
						id.length > 256,
				) ||
				new Set(target.accountIds).size !== target.accountIds.length)
		)
			throw new Error(
				"Alias target accounts must be null or a nonempty list of unique account IDs",
			);
		return {
			model: target.model,
			accountIds: target.accountIds === null ? null : [...target.accountIds],
		};
	});
	return {
		id: alias.id,
		displayName: alias.displayName,
		targets,
		revision: alias.revision,
	};
}
