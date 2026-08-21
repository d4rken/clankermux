import type React from "react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";

type Theme = "dark" | "light" | "system";

type ThemeContextType = {
	theme: Theme;
	setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

/**
 * Arm the cross-fade for one frame's worth of work, then disarm it.
 *
 * The transition used to live on a global `* { transition: … }` rule, which
 * meant every node in the app carried it and every ordinary hover was smoothed
 * whether or not that was wanted. Scoping it to `html.theme-switching` keeps
 * the switch pleasant without taxing the rest of the UI.
 */
function withThemeTransition(apply: () => void): void {
	const root = document.documentElement;
	root.classList.add("theme-switching");
	apply();
	window.setTimeout(() => root.classList.remove("theme-switching"), 220);
}

/**
 * Best-effort persistence. Reads are guarded too: `localStorage` throws
 * outright when site data is blocked, and this runs from a passive effect where
 * the throw would surface as an unhandled render error rather than a failed
 * save.
 */
function persist(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// A preference that cannot be saved is not worth breaking the app over.
	}
}

function readStoredTheme(): Theme {
	try {
		const stored = localStorage.getItem("theme");
		return stored === "dark" || stored === "light" || stored === "system"
			? stored
			: "system";
	} catch {
		return "system";
	}
}

/** Resolve `system` against the OS preference; light and dark pass through. */
function resolveMode(theme: Theme): "light" | "dark" {
	if (theme !== "system") return theme;
	return window.matchMedia("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
	const [theme, setThemeState] = useState<Theme>(readStoredTheme);

	useEffect(() => {
		const root = window.document.documentElement;
		root.classList.remove("light", "dark");
		root.classList.add(resolveMode(theme));
		persist("theme", theme);
	}, [theme]);

	// Track the OS preference only while following it.
	useEffect(() => {
		if (theme !== "system") return;
		const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
		const handleChange = () => {
			const root = window.document.documentElement;
			root.classList.remove("light", "dark");
			root.classList.add(mediaQuery.matches ? "dark" : "light");
		};

		mediaQuery.addEventListener("change", handleChange);
		return () => mediaQuery.removeEventListener("change", handleChange);
	}, [theme]);

	const setTheme = useCallback((next: Theme) => {
		withThemeTransition(() => setThemeState(next));
	}, []);

	return (
		<ThemeContext.Provider value={{ theme, setTheme }}>
			{children}
		</ThemeContext.Provider>
	);
}

export function useTheme() {
	const context = useContext(ThemeContext);
	if (!context) {
		throw new Error("useTheme must be used within a ThemeProvider");
	}
	return context;
}

/** The mode currently stamped on the document, independent of any provider. */
function paintedMode(): "light" | "dark" {
	if (typeof document === "undefined") return "dark";
	return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/**
 * The colour mode currently painted. Charts need this because the model-series
 * palette differs between light and dark grounds (see lib/model-colors).
 *
 * Reads the `light`/`dark` class off `<html>` rather than going through
 * `useTheme`, for three reasons: the class is already the single source of
 * truth that every CSS token resolves against; the pre-React inline script in
 * index.html sets it before any provider exists; and a presentational chart
 * should not throw because it was rendered outside ThemeProvider — which is
 * exactly what a `useTheme` call inside a chart would do in tests and in any
 * standalone render.
 */
export function useColorMode(): "light" | "dark" {
	const [mode, setMode] = useState<"light" | "dark">(paintedMode);

	useEffect(() => {
		// Covers both axes at once: an explicit toggle and an OS change both land
		// as a class swap on the same element.
		const root = document.documentElement;
		const sync = () => setMode(paintedMode());
		sync();
		const observer = new MutationObserver(sync);
		observer.observe(root, { attributes: true, attributeFilter: ["class"] });
		return () => observer.disconnect();
	}, []);

	return mode;
}
