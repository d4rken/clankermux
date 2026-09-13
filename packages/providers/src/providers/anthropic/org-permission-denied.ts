/** Organization-wide access denial, adapted from upstream v3.5.77 / PR #435.
 * A permission_error carrying a machine code is org-wide only for
 * `oauth_not_allowed_for_organization`; the other codes scope to a model or
 * feature. One with NO code is taken as org-wide.
 *
 * Matching on `error.message` was tried and dropped: Anthropic owns that copy
 * and was observed sending two different wordings to one organization inside
 * the same hour, so a reword would silently stop benching and put the 403 back
 * in front of the client while healthy accounts sat in the pool. Nothing would
 * have caught it, since the trigger is a change upstream, not here.
 */
function isOrgPermissionDeniedBody(value: unknown): boolean {
	if (!value || typeof value !== "object" || !("error" in value)) return false;
	const error = value.error;
	if (
		!error ||
		typeof error !== "object" ||
		!("type" in error) ||
		error.type !== "permission_error"
	)
		return false;
	if ("details" in error && error.details != null) {
		if (typeof error.details !== "object") return false;
		if ("error_code" in error.details)
			return error.details.error_code === "oauth_not_allowed_for_organization";
	}
	return true;
}

/** Inspect at most 16 KiB / 500 ms, preserving the original response. Cancel
 * the tee branch without awaiting its twin; never drain or buffer a large body.
 */
export async function isAnthropicOrgPermissionDenied(
	response: Response,
	signal?: AbortSignal,
	timeoutMs = 500,
): Promise<boolean> {
	if (
		response.status !== 403 ||
		!response.body ||
		response.headers
			.get("content-type")
			?.split(";", 1)[0]
			.trim()
			.toLowerCase() !== "application/json"
	)
		return false;
	signal?.throwIfAborted();
	let reader: ReadableStreamDefaultReader<Uint8Array>;
	try {
		const branch = response.clone().body;
		if (!branch) return false;
		reader = branch.getReader();
	} catch {
		return false;
	}
	const maxBytes = 16 * 1024;
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	const stop = new Promise<null>((resolve, reject) => {
		timer = setTimeout(() => resolve(null), timeoutMs);
		if (signal) {
			onAbort = () =>
				reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
	try {
		while (true) {
			const next = await Promise.race([reader.read(), stop]);
			if (!next) return false;
			if (next.done)
				return isOrgPermissionDeniedBody(JSON.parse(text + decoder.decode()));
			bytes += next.value.byteLength;
			if (bytes > maxBytes) return false;
			text += decoder.decode(next.value, { stream: true });
		}
	} catch {
		signal?.throwIfAborted();
		return false;
	} finally {
		clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
