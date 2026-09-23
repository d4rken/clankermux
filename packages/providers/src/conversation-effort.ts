/**
 * Claude Code sends a mid-conversation effort change as a system message
 * carrying `output_config: { effort }`. For backends that reject message-level
 * `output_config`, fold the last such update into the request's own
 * `output_config` and strip it from the messages, which otherwise keep their
 * position and content.
 *
 * Mutates `body` and returns how many updates were folded; 0 means untouched.
 * A malformed top-level `output_config` is left alone for upstream validation
 * rather than silently replaced (or spread from a string or array).
 */
export function hoistConversationEffortUpdates(
	body: Record<string, unknown>,
): number {
	if (!Array.isArray(body.messages)) return 0;
	if (
		"output_config" in body &&
		(!body.output_config ||
			typeof body.output_config !== "object" ||
			Array.isArray(body.output_config))
	)
		return 0;
	let updates = 0;
	const messages = body.messages.map((message: Record<string, unknown>) => {
		const config = message.output_config;
		if (
			message.role !== "system" ||
			!config ||
			typeof config !== "object" ||
			Array.isArray(config) ||
			Object.keys(config).length !== 1 ||
			!("effort" in config) ||
			typeof config.effort !== "string"
		)
			return message;
		body.output_config = {
			...(body.output_config as Record<string, unknown> | undefined),
			effort: config.effort,
		};
		const { output_config: _config, ...rest } = message;
		updates++;
		return rest;
	});
	if (updates) body.messages = messages;
	return updates;
}
