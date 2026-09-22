/**
 * Does a provider report token counts at all?
 *
 * Separate from what a translator puts on the wire. The Anthropic streaming
 * shape REQUIRES `usage` on `message_start` and `message_delta`, so a provider
 * that reports nothing still has to emit the fields, and a translator that
 * omitted them would hand a client an event its SDK cannot accumulate. Those
 * emitted values are placeholders, not measurements.
 *
 * The usage collector reads the same stream the client does, so without this it
 * cannot tell a placeholder from a count. It would record a complete zero
 * vector as provider-reported, and `requests` publishes a stored 0 as a
 * positive claim that none of that class was consumed.
 */
export function reportsTokenUsage(provider: string | undefined): boolean {
	return provider !== "ollama" && provider !== "ollama-cloud";
}
