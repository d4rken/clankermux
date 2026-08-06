import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * DOM globals for the handful of dashboard tests that must run React EFFECTS.
 *
 * Almost every test in this package renders with `renderToStaticMarkup`, which
 * never runs effects and needs no DOM. A few defects only exist in effect
 * lifecycles — an `EventSource` torn down by a dependency array, a state reset
 * fired by a re-running effect — and cannot be observed that way.
 *
 * Deliberately NOT a `bun test` preload. `bun test` runs from the repo root, so
 * a preload would have to live in the root `bunfig.toml` and would install
 * `window`/`document` for all ~394 test files, including packages that today
 * run with no DOM at all. This module is imported only by the tests that need
 * it, and it must be the FIRST import in such a file: ESM evaluates imports in
 * source order, and `react-dom/client` inspects these globals when it loads.
 *
 * The registration still leaks for the rest of the process (bun shares one
 * process across test files), so every consumer must call `unregisterDom()`
 * from `afterAll` to hand the process back the way it found it.
 */
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

/** Remove the DOM globals again. Call from `afterAll`. */
export async function unregisterDom(): Promise<void> {
	if (GlobalRegistrator.isRegistered) {
		await GlobalRegistrator.unregister();
	}
}
