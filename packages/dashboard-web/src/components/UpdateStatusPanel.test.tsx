import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	RESTART_COMMAND,
	UPDATE_COMMAND,
	type UpdateCheckStatus,
	type UpdateInfo,
	UpdateStatusPanel,
} from "./UpdateStatusPanel";

function info(overrides: Partial<UpdateInfo> = {}): UpdateInfo {
	return {
		currentSha: "1111111",
		latestSha: "2222222",
		latestUrl: "https://github.com/d4rken/clankermux/commit/2222222",
		dirty: false,
		behindBy: 0,
		aheadBy: 0,
		repo: "d4rken/clankermux",
		bootSha: "1111111",
		restartPending: false,
		remoteError: null,
		...overrides,
	};
}

/** The command as it appears in markup — React escapes the shell `&&`. */
function asMarkup(command: string): string {
	return command.replace(/&/g, "&amp;");
}

function render(
	status: UpdateCheckStatus,
	overrides: Partial<UpdateInfo> = {},
	error: string | null = null,
) {
	return renderToStaticMarkup(
		<UpdateStatusPanel
			status={status}
			info={info(overrides)}
			error={error}
			onCheck={() => {}}
		/>,
	);
}

/** The opening tag of the paragraph that renders `text`. */
function paragraphTag(markup: string, text: string): string {
	const at = markup.indexOf(`>${text}<`);
	if (at === -1) throw new Error(`nothing renders "${text}"`);
	return markup.slice(markup.lastIndexOf("<p", at), at + 1);
}

/**
 * Longer than the panel's column can show, which is the whole point.
 *
 * The real case was a 334-character HTML error document: `parseHttpError`
 * assigns a non-JSON response body to the message whole, and it reached the
 * sidebar untruncated. Plain text here so the assertions are about the length
 * rather than about React's attribute escaping.
 */
const LONG_ERROR =
	"The upstream returned an unexpected response and the deployment check could not complete. " +
	"This message is deliberately long enough to wrap well past two lines in the sidebar column, " +
	"which is 136 pixels wide and cannot show anything like this much text.";

/**
 * Repo freshness ("is there a newer commit on main?") and process freshness
 * ("is the running process on the commit the checkout is at?") are orthogonal.
 * The panel has to say which one is actionable, and a restart always is.
 */
describe("UpdateStatusPanel", () => {
	it("shows the restart chip ahead of 'Up to Date' when the checkout moved since boot", () => {
		const html = render("current", {
			bootSha: "1111111",
			currentSha: "3333333",
			restartPending: true,
		});

		expect(html).toContain("Restart Pending");
		expect(html).not.toContain("Up to Date");
		// Both ends of the divergence, so the operator can see what would change.
		expect(html).toContain("1111111");
		expect(html).toContain("3333333");
		expect(html).toContain(asMarkup(RESTART_COMMAND));
		// Precise wording: comparing SHAs detects a HEAD move, NOT tracked files
		// edited in place, and the copy must not imply otherwise.
		expect(html).toContain("HEAD");
		expect(html).not.toContain("uncommitted");
	});

	it("keeps the restart chip in front when an update is ALSO available", () => {
		const html = render("available", {
			bootSha: "1111111",
			currentSha: "3333333",
			latestSha: "4444444",
			restartPending: true,
			behindBy: 2,
		});

		expect(html).toContain("Restart Pending");
		expect(html).not.toContain("Update Available");
		// The update survives as secondary detail — it is still true, just not the
		// thing to do first.
		expect(html).toContain("4444444");
		expect(html).toContain("2 commits behind");
		expect(html).toContain(asMarkup(UPDATE_COMMAND));
	});

	it("keeps today's behaviour when nothing changed since boot", () => {
		const html = render("current", { restartPending: false });

		expect(html).toContain("Up to Date");
		expect(html).not.toContain("Restart Pending");
		expect(html).not.toContain(asMarkup(RESTART_COMMAND));
	});

	it("keeps today's behaviour for an available update with no restart pending", () => {
		const html = render("available", {
			currentSha: "1111111",
			latestSha: "2222222",
			restartPending: false,
			behindBy: 1,
		});

		expect(html).toContain("Update Available");
		expect(html).not.toContain("Restart Pending");
		expect(html).toContain("1 commit behind");
		expect(html).toContain(asMarkup(UPDATE_COMMAND));
	});

	it("shows nothing new when boot provenance is unavailable", () => {
		// No git at boot means no signal — the panel must not invent one.
		const html = render("current", { bootSha: null, restartPending: false });

		expect(html).not.toContain("Restart Pending");
		expect(html).toContain("Up to Date");
	});

	it("attributes an unknown status to GitHub when that is what failed", () => {
		// The handler now answers 200/unknown on a GitHub outage so the local
		// signals survive; blaming "not a git checkout" would be a lie.
		const html = render("unknown", {
			remoteError: "GitHub API returned status 403",
		});

		expect(html).toContain("Status Unknown");
		expect(html).toContain("GitHub API returned status 403");
		expect(html).not.toContain("not a git checkout");
	});

	it("still explains a local-git failure when there is no remote error", () => {
		const html = render("unknown", { currentSha: null, remoteError: null });

		expect(html).toContain("not a git checkout");
	});

	it("clamps a long GitHub failure and keeps all of it on hover", () => {
		// Nothing bounds this string at the source, and the panel sits in a 136px
		// sidebar column, so the render site clamps it. `title` has to carry the
		// message the panel DISPLAYS — prefix included — or the part the clamp
		// hides is unrecoverable.
		const html = render("unknown", { remoteError: LONG_ERROR });
		const displayed = `Could not reach GitHub: ${LONG_ERROR}`;

		const tag = paragraphTag(html, displayed);
		expect(tag).toContain("line-clamp-2");
		expect(tag).toContain(`title="${displayed}"`);
	});

	it("clamps a long check failure and keeps all of it on hover", () => {
		// The other unbounded string: a transport-level failure of the check
		// itself, which arrives as the raw response body just as often.
		const html = render("error", {}, LONG_ERROR);

		const tag = paragraphTag(html, LONG_ERROR);
		expect(tag).toContain("line-clamp-2");
		expect(tag).toContain(`title="${LONG_ERROR}"`);
	});

	it("renders the restart chip even while a re-check is in flight", () => {
		// The check is a network round-trip; the restart signal is already known.
		const html = render("checking", {
			bootSha: "1111111",
			currentSha: "3333333",
			restartPending: true,
		});

		expect(html).toContain("Checking...");
		expect(html).toContain(asMarkup(RESTART_COMMAND));
	});
});
