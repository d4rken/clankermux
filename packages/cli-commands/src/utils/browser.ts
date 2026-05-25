import { spawn } from "node:child_process";

/**
 * Try to open the user's default browser with the given URL.
 * Returns true on success, false otherwise.
 *
 * Uses the platform's native opener via a detached child process. This replaces
 * the `open` npm package, which pulled in ~10 transitive dependencies (including
 * pre-1.0 `powershell-utils`/`wsl-utils`) to do exactly this.
 */
export async function openBrowser(url: string): Promise<boolean> {
	try {
		if (process.platform === "win32") {
			// Windows quoting is critical — use PowerShell's Start-Process.
			spawn(
				"powershell.exe",
				["-NoProfile", "-Command", "Start-Process", `'${url}'`],
				{
					detached: true,
					stdio: "ignore",
				},
			).unref();
		} else if (process.platform === "darwin") {
			spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
		} else {
			// Linux / other: rely on the freedesktop opener.
			spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
		}
		return true;
	} catch {
		return false;
	}
}
