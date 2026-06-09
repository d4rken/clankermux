/**
 * Decode a base64-encoded request/response body for display.
 *
 * `atob` returns a "binary string" where each character holds one byte
 * (0–255), so multi-byte UTF-8 sequences (any non-ASCII content — non-English
 * prose, code, emoji) render as garbled Latin-1 characters. We reconstruct the
 * raw bytes and decode them as UTF-8 to render the original text correctly.
 *
 * Mirrors the prior inline behavior: `null`/empty → "No data", the
 * "[streamed]" sentinel → a friendly message, and undecodable input falls back
 * to an error string (logged) rather than throwing.
 */
export function decodeBase64Utf8(str: string | null): string {
	if (!str) return "No data";
	try {
		// Handle edge cases like "[streamed]" from older data.
		if (str === "[streamed]") {
			return "[Streaming data not captured]";
		}
		const binary = atob(str);
		const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
		return new TextDecoder("utf-8").decode(bytes);
	} catch (error) {
		console.error("Failed to decode base64:", error, "Input:", str);
		return `Failed to decode: ${str}`;
	}
}
