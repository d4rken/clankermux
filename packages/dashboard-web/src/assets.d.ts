// Ambient declarations for static assets imported from TypeScript.
// This file must stay script-mode (no top-level import/export) so the
// wildcard module declarations register globally instead of being treated
// as augmentations of a non-existent module.
declare module "*.png" {
	const src: string;
	export default src;
}
