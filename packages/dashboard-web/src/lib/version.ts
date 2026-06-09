// Read version directly from the repo-root package.json at build time
import packageJson from "../../../../package.json";

export function getVersion(): string {
	const version = packageJson.version;
	return version.startsWith("v") ? version : `v${version}`;
}

export const version = getVersion();

/**
 * Human label describing how the running deployment relates to main, given the
 * ahead/behind commit counts from `/api/version/check`. "behind" takes priority
 * (it's the actionable direction); "ahead" reflects unpushed local commits.
 */
export function commitRelationshipLabel(
	aheadBy: number | null,
	behindBy: number | null,
): string {
	if ((behindBy ?? 0) > 0) {
		return `${behindBy} commit${behindBy === 1 ? "" : "s"} behind main`;
	}
	if ((aheadBy ?? 0) > 0) {
		return `${aheadBy} commit${aheadBy === 1 ? "" : "s"} ahead of main`;
	}
	return "Up to date with main";
}
