/**
 * Whether an upstream 400/404 says the model cannot take image input.
 * Wording adapted from better-ccflare v3.6.4 `isVisionUnsupportedError`.
 *
 *   400 "unknown variant `image_url`, expected `text`"     -> true  (DeepSeek)
 *   404 "No endpoints found that support image input"      -> true  (OpenRouter-shaped)
 *   400 "Invalid image_url: invalid base64 data"           -> false (the image is broken)
 *
 * Reads only wording, so callers gate it on the sent body carrying an image.
 */

/** Words naming the image input. */
const IMAGE_INPUT_NOUNS = [
	"image",
	"images",
	"image_url",
	"image url",
	"image input",
	"image content",
	"vision",
	"visual",
	"modality",
	"modalities",
	"multimodal",
	"file",
	"files",
	"attachment",
	"attachments",
] as const;

/** Phrasings that state the capability is absent. */
const CAPABILITY_ABSENT_PATTERNS = [
	"not support",
	"n't support",
	// "No endpoints found that support image input": the negation is elsewhere.
	"that support",
	"unsupported",
	"not supported",
	// A schema with no image part at all (serde, GLM, pydantic).
	"unknown variant",
	"unknown field",
	"extra inputs are not permitted",
	"extra_forbidden",
	"does not accept",
	"doesn't accept",
	"do not accept",
	"cannot accept",
	"can't accept",
	"not accept",
	"only supports",
	"only support",
	"only accepts",
	"only accept",
	"not available",
	"isn't available",
	"not enabled",
	"no support",
	"not a valid",
	"invalid content type",
] as const;

/** Refusals about this image or this request, which another try would repeat. */
const NON_CAPABILITY_PATTERNS = [
	"invalid base64",
	"base64",
	"malformed",
	"corrupt",
	"decode",
	"too large",
	"too big",
	"exceeds",
	"maximum size",
	"max size",
	"file size",
	"dimensions",
	"resolution",
	"policy",
	"moderation",
	"content filter",
	"content_filter",
	"safety",
	"blocked",
	"not allowed",
	"too many",
	"exceeded the maximum",
	"cache_control",
] as const;

function statesImageInputUnsupported(text: string): boolean {
	const lower = text.toLowerCase();
	if (NON_CAPABILITY_PATTERNS.some((p) => lower.includes(p))) return false;
	if (!IMAGE_INPUT_NOUNS.some((p) => lower.includes(p))) return false;
	return CAPABILITY_ABSENT_PATTERNS.some((p) => lower.includes(p));
}

export async function isImageInputRefusal(
	response: Response,
): Promise<boolean> {
	if (response.status !== 400 && response.status !== 404) return false;
	if (!response.headers.get("content-type")?.includes("application/json"))
		return false;
	try {
		// Cloned only after the content-type check: a clone tees the body.
		const json = (await response.clone().json()) as Record<string, unknown>;
		const error = json.error as Record<string, unknown> | undefined;
		const candidates: string[] = [];
		const push = (value: unknown) => {
			if (typeof value === "string") candidates.push(value);
		};
		push(error?.message);
		push(json.detail);
		push(json.message);
		const nested = (value: unknown) =>
			value && typeof value === "object"
				? (value as { detail?: unknown }).detail
				: undefined;
		const detail = [json.detail, nested(error?.message), nested(json.message)]
			.filter(Array.isArray)
			.at(0);
		for (const entry of (detail as unknown[] | undefined) ?? []) {
			if (!entry || typeof entry !== "object") continue;
			const { loc, msg } = entry as { loc?: unknown; msg?: unknown };
			// pydantic splits the halves: `loc` names image_url, `msg` the refusal.
			candidates.push(
				`${Array.isArray(loc) ? loc.join(".") : ""} ${typeof msg === "string" ? msg : ""}`,
			);
		}
		return candidates.some(statesImageInputUnsupported);
	} catch {
		return false;
	}
}
