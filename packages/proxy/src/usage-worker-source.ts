import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Where the usage worker should be loaded from:
 * - `source`: a `file:` URL to the on-disk `post-processor.worker.ts`
 * - `embedded`: the base64-encoded worker bundle baked in at build time
 *
 * This module intentionally imports nothing from `@clankermux/*` or the
 * generated `inline-worker.ts`. `resolveUsageWorkerSource` is a pure function,
 * and keeping it dependency-free lets it (and its tests) load without dragging
 * in the logger/core import cycle or the multi-MB embedded worker blob.
 */
export type UsageWorkerSource =
	| { kind: "source"; url: string }
	| { kind: "embedded"; code: string };

function sourceWorkerExists(workerUrl: URL): boolean {
	if (workerUrl.protocol !== "file:") return false;
	try {
		return existsSync(fileURLToPath(workerUrl));
	} catch {
		return false;
	}
}

export function resolveUsageWorkerSource(
	options: {
		embeddedCode?: string;
		env?: Record<string, string | undefined>;
		sourceExists?: (workerUrl: URL) => boolean;
		workerUrl?: URL;
	} = {},
): UsageWorkerSource {
	const embeddedCode = options.embeddedCode ?? "";
	const env = options.env ?? process.env;
	const workerUrl =
		options.workerUrl ?? new URL("./post-processor.worker.ts", import.meta.url);
	const exists = options.sourceExists ?? sourceWorkerExists;

	const override = env.CLANKERMUX_USE_EMBEDDED_WORKER;
	if (override === "true") {
		if (!embeddedCode) {
			throw new Error(
				"CLANKERMUX_USE_EMBEDDED_WORKER=true but no embedded worker code is available",
			);
		}
		return { kind: "embedded", code: embeddedCode };
	}
	if (override === "false") {
		return { kind: "source", url: workerUrl.href };
	}

	if (exists(workerUrl)) {
		return { kind: "source", url: workerUrl.href };
	}
	if (embeddedCode) {
		return { kind: "embedded", code: embeddedCode };
	}
	return { kind: "source", url: workerUrl.href };
}
