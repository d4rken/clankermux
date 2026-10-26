export interface EmbeddedWorker {
	worker: Worker;
	/** Terminates the worker, then releases its blob URL. Safe to call twice. */
	dispose(): void;
}

/**
 * Start a worker from its embedded base64 bundle, or from `sourceUrl` when the
 * bundle is an empty placeholder (tests, fresh worktrees).
 *
 * The blob URL is revoked only after `terminate()`: revoking right after
 * `new Worker(url)` races the worker thread's own load of it, and never
 * revoking keeps one copy of the bundle alive per spawn for the process
 * lifetime.
 */
export function spawnEmbeddedWorker(
	embeddedCode: string,
	sourceUrl: string,
): EmbeddedWorker {
	if (!embeddedCode) {
		const worker = new Worker(sourceUrl);
		return { worker, dispose: () => worker.terminate() };
	}

	const code = Buffer.from(embeddedCode, "base64").toString("utf8");
	let blobUrl: string | null = URL.createObjectURL(
		new Blob([code], { type: "text/javascript" }),
	);
	let worker: Worker;
	try {
		worker = new Worker(blobUrl, { smol: true });
	} catch (err) {
		URL.revokeObjectURL(blobUrl);
		throw err;
	}
	return {
		worker,
		dispose() {
			worker.terminate();
			if (blobUrl === null) return;
			URL.revokeObjectURL(blobUrl);
			blobUrl = null;
		},
	};
}
