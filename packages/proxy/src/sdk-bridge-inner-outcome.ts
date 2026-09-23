import { Logger } from "@clankermux/logger";
import {
	getSdkBridgeInnerMetaContext,
	type RequestMeta,
	type SdkBridgeInnerOutcome,
} from "@clankermux/types";

const log = new Logger("SdkBridgeInner");

const lastSentAccount = new WeakMap<RequestMeta, string>();

/** Called for every authorized send, so the report names the account last tried. */
export function noteSdkBridgeInnerSend(
	meta: RequestMeta,
	accountId: string,
): void {
	if (getSdkBridgeInnerMetaContext(meta)) lastSentAccount.set(meta, accountId);
}

function deliver(meta: RequestMeta, outcome: SdkBridgeInnerOutcome): void {
	const report = getSdkBridgeInnerMetaContext(meta)?.onInnerOutcome;
	if (!report) return;
	try {
		report(outcome);
	} catch (error) {
		log.warn("SDK bridge inner outcome callback failed", error);
	}
}

/**
 * Tell the bridge how one of its inner calls ended. An error body is read from
 * a clone, off the response path, so the report can land just after the
 * response itself has been handed back.
 */
export function reportSdkBridgeInnerResponse(
	meta: RequestMeta,
	response: Response,
): void {
	if (!getSdkBridgeInnerMetaContext(meta)?.onInnerOutcome) return;
	const base = {
		requestId: meta.id,
		status: response.status,
		retryAfter: response.headers.get("retry-after"),
		accountId: lastSentAccount.get(meta) ?? null,
	};
	if (
		response.ok ||
		!response.headers.get("content-type")?.includes("application/json")
	) {
		deliver(meta, { ...base, errorType: null, message: null });
		return;
	}
	void response
		.clone()
		.json()
		.then(
			(body: { error?: { type?: unknown; message?: unknown } }) => ({
				errorType:
					typeof body?.error?.type === "string" ? body.error.type : null,
				message:
					typeof body?.error?.message === "string" ? body.error.message : null,
			}),
			() => ({ errorType: null, message: null }),
		)
		.then((detail) => deliver(meta, { ...base, ...detail }));
}

/** The same report for a request that ended in a thrown give-up terminal. */
export function reportSdkBridgeInnerFailure(
	meta: RequestMeta,
	error: unknown,
): void {
	const failure = error as {
		statusCode?: unknown;
		retryAfterSeconds?: unknown;
		name?: unknown;
		message?: unknown;
	} | null;
	deliver(meta, {
		requestId: meta.id,
		status: typeof failure?.statusCode === "number" ? failure.statusCode : 500,
		errorType: typeof failure?.name === "string" ? failure.name : null,
		message: typeof failure?.message === "string" ? failure.message : null,
		retryAfter:
			typeof failure?.retryAfterSeconds === "number"
				? String(failure.retryAfterSeconds)
				: null,
		accountId: lastSentAccount.get(meta) ?? null,
	});
}
