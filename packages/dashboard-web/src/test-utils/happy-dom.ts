import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * DOM globals for the dashboard DOM test lane (`bun run test:dom`).
 *
 * This module is ONLY ever used as the `--preload` of that lane; no test file
 * imports it. The DOM must exist before ANY test module evaluates, because
 * `@radix-ui/react-use-layout-effect` compiles to
 * `var useLayoutEffect2 = globalThis?.document ? React.useLayoutEffect : () => {}`
 * — a module-scope binding evaluated ONCE per process. If the first Radix
 * import in the process happens while `document` is still undefined (e.g. a
 * `renderToStaticMarkup` test file that pulls in a Radix component), the
 * binding is the no-op forever after: `@radix-ui/react-portal` never sets
 * `mounted`, portals render null, and every Radix dialog/popover/select test
 * silently asserts against empty output. A per-file import cannot fix that, so
 * the DOM tests run in their own process with this module preloaded.
 *
 * Deliberately NOT a root `bunfig.toml` preload either: `bun test` runs from
 * the repo root, and `GlobalRegistrator.register()` replaces the globalThis
 * `Request`, `Response`, `fetch`, `Headers`, `AbortController`, `WebSocket` and
 * `URL` implementations (measured) with happy-dom's. The proxy suite tests real
 * request/response plumbing against Bun's natives and must not run against
 * those substitutes.
 *
 * Almost every test in this package renders with `renderToStaticMarkup`, which
 * never runs effects and needs no DOM. Only tests that must mount for real —
 * effect lifecycles, or portalled Radix content — belong in the lane.
 */
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
