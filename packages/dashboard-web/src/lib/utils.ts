import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The five names registered as --spacing-* in styles/globals.css. Without this,
// tailwind-merge treats `p-row` as an unknown class: it resolves no conflicts, so a
// primitive's `pt-0` survives a call site's `p-group` and the padding silently
// collapses. See the git history of ui/card.tsx for what that cost.
//
// The extension APPENDS to the default spacing scale rather than replacing it, so
// numeric utilities keep resolving exactly as before. One `theme.spacing` entry
// covers padding, margin, `gap` and `space-*` — they all validate through the same
// `themeSpacing` getter.
const twMerge = extendTailwindMerge({
	extend: { theme: { spacing: ["tight", "item", "row", "group", "section"] } },
});

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}
