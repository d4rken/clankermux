import type { ClientApplication } from "@clankermux/types";
import { Terminal } from "lucide-react";
import { CLAUDE_MARK, OPENAI_MARK } from "../accounts/provider-marks";

/**
 * Brand marks for the harnesses a client can be set up as.
 *
 * Claude Code and Codex reuse the upstream provider marks rather than carrying
 * a second copy of the same path data. The rest are vendored here: OpenCode and
 * Pi from Simple Icons (https://simple-icons.org, CC0-1.0), Oh My Pi from its
 * own site mark (https://omp.sh/favicon.svg). The marks remain trademarks of
 * their respective owners and identify the harness, nothing more.
 */

interface ApplicationMark {
	/** Single-path outline, filled with one color so `fill` can tint it. */
	path: string;
	/** The box the path is authored against; provider marks all use 24x24. */
	viewBox?: string;
	/**
	 * Tailwind fill utility, as a literal string so the JIT keeps it. Omitted
	 * for marks published as black, which inherit the row's text color.
	 */
	fill?: string;
}

const OPENCODE_PATH = "M22 24H2V0h20zM17 4.8H7v14.4h10z";

const PI_PATH = "M0 0v24h6v-6h6v-6H6V6h6v6h6V0Zm18 12v12h6V12Z";

const OH_MY_PI_PATH = "M14 16h36v8H40v32h-8V24h-6v22h-8V24h-4z";

/**
 * The source mark sits in a 64x64 badge with generous padding, so rendered
 * against `0 0 64 64` its pi comes out visibly smaller than the other marks in
 * the same 20px row. This is the path's own bounding box, which makes it fill
 * its box the way the 24x24 marks fill theirs.
 */
const OH_MY_PI_VIEW_BOX = "14 16 36 40";

/**
 * Oh My Pi publishes its pi as a three-stop gradient, which a single-path mark
 * cannot carry. The midpoint holds 4.3:1 on the light row and 3.5:1 on the
 * dark one, so one value covers both themes.
 */
const OH_MY_PI_FILL = "fill-[#9B4DFF]";

/**
 * Exhaustive over the application union, and `null` rather than an omission
 * for the unbranded one: a new harness then fails to compile here instead of
 * quietly shipping the fallback glyph for a brand that does have a mark.
 */
const APPLICATION_MARKS: Record<ClientApplication, ApplicationMark | null> = {
	generic: null,
	"claude-code": CLAUDE_MARK,
	codex: OPENAI_MARK,
	opencode: { path: OPENCODE_PATH },
	pi: { path: PI_PATH },
	"oh-my-pi": {
		path: OH_MY_PI_PATH,
		viewBox: OH_MY_PI_VIEW_BOX,
		fill: OH_MY_PI_FILL,
	},
};

interface ApplicationMarkIconProps {
	application: ClientApplication;
	className?: string;
}

/**
 * Renders a harness's brand mark. `generic` has no brand, so it falls back to
 * a terminal glyph — every row gets a mark, and a column of icons with a hole
 * in it reads as a rendering failure.
 *
 * Decorative, so it is hidden from assistive technology. Every caller owes a
 * text rendering of the same application beside it — `ClientLabel` carries one
 * as `sr-only`, the Clients list spells it out in the row's sub-line.
 */
export function ApplicationMarkIcon({
	application,
	className,
}: ApplicationMarkIconProps) {
	// `Object.hasOwn` keeps inherited keys (`constructor`, `toString`) from
	// resolving to something that is not a mark, should a value off the union
	// reach this from an API response.
	const mark = Object.hasOwn(APPLICATION_MARKS, application)
		? APPLICATION_MARKS[application]
		: null;
	if (!mark) return <Terminal aria-hidden="true" className={className} />;
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			viewBox={mark.viewBox ?? "0 0 24 24"}
			className={`${mark.fill ?? "fill-current"}${className ? ` ${className}` : ""}`}
		>
			<path d={mark.path} />
		</svg>
	);
}
