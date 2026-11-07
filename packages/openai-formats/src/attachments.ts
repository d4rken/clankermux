import { ValidationError } from "@clankermux/core";
import type { OpenAIRequest } from "./types";

/** An Anthropic attachment `source`, typed loosely because clients send it unchecked. */
export interface AnthropicAttachmentSourceInput {
	type?: unknown;
	media_type?: unknown;
	data?: unknown;
	url?: unknown;
}

const nonEmptyString = (value: unknown): string | undefined => {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * The URL an OpenAI-family image part carries for an Anthropic image source:
 * chat-completions `image_url.url` and Responses `input_image.image_url` both
 * take it.
 *
 *   { type: "base64", media_type: "image/png", data: "iVBO…" } -> "data:image/png;base64,iVBO…"
 *   { type: "url", url: "https://x/cat.png" }                 -> "https://x/cat.png"
 *   { type: "url", url: "file:///etc/passwd" }                -> throws
 *
 * Only http(s) urls pass, because the upstream fetches them and a `file:` or
 * `blob:` url would be resolved by whatever host serves the request. Anything
 * unusable throws ValidationError: dropping the image makes the model answer
 * as if none was sent, and an empty part is rejected upstream with an
 * unrelated message.
 */
export function anthropicImageUrl(
	source: AnthropicAttachmentSourceInput | undefined,
): string {
	if (source?.type === "base64") {
		const mediaType = nonEmptyString(source.media_type);
		const data = source.data;
		if (mediaType && typeof data === "string" && data.length > 0) {
			return `data:${mediaType};base64,${data}`;
		}
	}
	if (source?.type === "url") {
		const url = nonEmptyString(source.url);
		if (url) {
			if (url.startsWith("https://") || url.startsWith("http://")) return url;
			throw new ValidationError(
				`unsupported image source url scheme: ${url.split(":", 1)[0]}`,
			);
		}
	}
	throw new ValidationError(
		`unsupported image source: ${typeof source?.type === "string" ? source.type : "missing"}`,
	);
}

/**
 * What the model reads in place of a document the backend cannot take, so the
 * turn does not look as though nothing was attached.
 *
 *   "application/pdf" -> "[application/pdf document removed: not supported on this backend]"
 *   undefined         -> "[document removed: not supported on this backend]"
 */
export function documentRemovalMarker(mediaType: unknown): string {
	const label = nonEmptyString(mediaType);
	return `[${label ? `${label} ` : ""}document removed: not supported on this backend]`;
}

/** What a text-only model reads where an image was. */
export const IMAGE_REMOVED_MARKER =
	"[image removed: this model does not accept image input]";

/**
 * Replace every chat-completions `image_url` part with
 * {@link IMAGE_REMOVED_MARKER}, in place, and return how many it replaced.
 */
export function replaceImageParts(body: OpenAIRequest): number {
	if (!Array.isArray(body.messages)) return 0;
	let replaced = 0;
	for (const message of body.messages) {
		if (!Array.isArray(message.content)) continue;
		message.content = message.content.map((part) => {
			if (part?.type !== "image_url") return part;
			replaced++;
			return { type: "text", text: IMAGE_REMOVED_MARKER };
		});
	}
	return replaced;
}
