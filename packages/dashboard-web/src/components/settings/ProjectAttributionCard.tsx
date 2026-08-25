import { useEffect, useState } from "react";
import { useProjectRules, useSetProjectRules } from "../../hooks/queries";
import { Button } from "../ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { SettingListControl, SettingRow } from "./SettingRow";

/**
 * Which directory is a project.
 *
 * The proxy only ever sees a path string from the CLIENT's machine, so it
 * cannot look at the filesystem to find a repository root. It used to guess
 * with a hard-coded list of folder names that only applied under a home
 * directory, which quietly merged every repository under an unlisted container
 * (`~/work`, `~/dev`, `~/code`) into one project. That name is also the load
 * balancer's fallback affinity key, so a wrong guess pinned two unrelated
 * codebases to one upstream account.
 *
 * The rules are the operator's answer to that question, and a path matching no
 * rule is now reported here rather than guessed at.
 */

/** Draft rows are `Record<string, string>`, which is what the list editor edits. */
type Row = Record<string, string>;

function rowsEqual(a: Row[], b: Row[]): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

export function ProjectAttributionCard() {
	const { data, isLoading } = useProjectRules();
	const setProjectRules = useSetProjectRules();

	// `null` means "not edited yet", which is NOT the same as an empty list: an
	// operator can legitimately save zero roots. Keeping the distinction is also
	// what lets the rows render from the server's answer before any effect has
	// run, so the lists are populated on first paint and in static rendering
	// rather than flashing "no roots configured".
	const [rootDraft, setRootDraft] = useState<Row[] | null>(null);
	const [overrideDraft, setOverrideDraft] = useState<Row[] | null>(null);

	const serverRoots: Row[] = (data?.roots ?? []).map((path) => ({ path }));
	const serverOverrides: Row[] = (data?.overrides ?? []).map((o) => ({
		prefix: o.prefix,
		name: o.name,
	}));

	const rootRows = rootDraft ?? serverRoots;
	const overrideRows = overrideDraft ?? serverOverrides;

	// Drop the draft when the server's RULES change, so the next render falls
	// back to them. Keyed on the rules alone and not on `data`: the query polls
	// so the unmatched-paths list stays live, and keying on the whole response
	// would throw away whatever the operator was typing every thirty seconds.
	// Both lists are dropped together because they are saved together — a draft
	// holding a new override on top of stale roots would write the stale roots
	// back.
	const rulesKey = JSON.stringify([data?.roots, data?.overrides]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the serialized rules ARE the dependency
	useEffect(() => {
		setRootDraft(null);
		setOverrideDraft(null);
	}, [rulesKey]);

	const busy = isLoading || setProjectRules.isPending;

	// A blank row is how the editor represents "still typing", so it is not an
	// error — it just is not saveable yet.
	const rootsComplete = rootRows.every((r) => (r.path ?? "").trim().length > 0);
	const overridesComplete = overrideRows.every(
		(r) =>
			(r.prefix ?? "").trim().length > 0 && (r.name ?? "").trim().length > 0,
	);
	const dirty =
		!rowsEqual(rootRows, serverRoots) ||
		!rowsEqual(overrideRows, serverOverrides);
	const canSave = dirty && rootsComplete && overridesComplete;

	const save = () => {
		setProjectRules.mutate({
			roots: rootRows.map((r) => r.path.trim()),
			overrides: overrideRows.map((r) => ({
				prefix: r.prefix.trim(),
				name: r.name.trim(),
			})),
		});
	};

	const unmatched = data?.unmatched ?? [];

	return (
		<Card className="card-hover">
			<CardHeader>
				<CardTitle>Project Attribution</CardTitle>
				<CardDescription>
					How a client's working directory becomes a project name.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-row">
				<SettingRow
					label="Project roots"
					control={
						<SettingListControl
							name="root"
							fields={[{ key: "path", placeholder: "/home/*/projects" }]}
							rows={rootRows}
							addLabel="Add root"
							emptyLabel="No roots configured, so nothing is attributed by layout."
							disabled={busy}
							onChange={setRootDraft}
							onReset={
								data
									? () =>
											setRootDraft(data.defaultRoots.map((path) => ({ path })))
									: undefined
							}
						/>
					}
					summary="Directories whose immediate children are projects. The most specific match wins."
					detail={
						"A root of /home/*/projects makes /home/anna/projects/octi/app/src resolve to octi: the project is the single segment below the root, so any working directory inside a repository resolves to the repository itself. A '*' matches exactly one path segment, which is what lets one rule cover every user on a machine. A path that IS a root is a container, not a project, and resolves to nothing. Non-home layouts work the same way: add /workspace and /workspace/myrepo/packages/api resolves to myrepo. A path matching no root is left unattributed rather than guessed at, because the project name is also the load balancer's fallback affinity key and a wrong one pins two unrelated codebases to the same upstream account. Saving clears the session attribution cache, so the next request of each active session re-anchors under the new rules."
					}
				/>

				<SettingRow
					label="Path overrides"
					control={
						<SettingListControl
							name="override"
							fields={[
								{ key: "prefix", placeholder: "/home/anna/.claude", grow: 2 },
								{ key: "name", placeholder: "project name", grow: 1 },
							]}
							rows={overrideRows}
							addLabel="Add override"
							emptyLabel="No overrides."
							disabled={busy}
							onChange={setOverrideDraft}
						/>
					}
					summary="An exact path and the name to use for it, checked before the roots."
					detail={
						"The name is used verbatim for that directory and everything beneath it. This is the one tier that is never second-guessed, which is how a hidden directory becomes a project: names beginning with a dot are rejected when the proxy infers them, because a session sitting in an infrastructure directory should not be labelled with it, but an override is a decision rather than an inference. It is also the way to split a monorepo the other rules treat as one project, or to give a directory a display name that differs from its folder name."
					}
				/>

				<SettingRow
					label="Unmatched paths"
					control={
						unmatched.length === 0 ? (
							<p className="text-sm text-muted-foreground">
								No unmatched working directories seen.
							</p>
						) : (
							<ul className="flex flex-col gap-tight">
								{unmatched.map((entry) => (
									<li
										key={entry.path}
										className="flex items-center justify-between gap-item text-sm"
									>
										<code className="min-w-0 truncate">{entry.path}</code>
										<span className="shrink-0 tabular-nums text-muted-foreground">
											{entry.count}
										</span>
									</li>
								))}
							</ul>
						)
					}
					summary="Working directories seen recently that matched no rule."
					detail="Each of these is a request that carried a usable working directory and still got no project, which almost always means a root is missing. The list is held in memory and bounded, so it is empty after a restart and after any change to the rules, and an empty list means 'nothing recently' rather than 'nothing ever'."
				/>

				{/* One Save for both lists, because the endpoint replaces the whole
				    rule set. A per-list button would write the other list back at
				    whatever the draft happened to be holding. */}
				<div className="flex items-center gap-item">
					<Button disabled={busy || !canSave} onClick={save}>
						Save rules
					</Button>
					{dirty && !canSave && (
						<span className="text-sm text-muted-foreground">
							Fill in or remove the blank row to save.
						</span>
					)}
					{setProjectRules.isError && (
						<span className="text-sm text-destructive">
							Save failed. Your changes are still here.
						</span>
					)}
				</div>
			</CardContent>
		</Card>
	);
}
