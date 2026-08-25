import type {
	ModelBaselineSource,
	ModelCatalogRow,
	ModelDialect,
} from "@clankermux/types";
import { formatDistanceToNow } from "date-fns";
import { useState } from "react";
import {
	useDeleteModelOverride,
	useModelCatalog,
	useSetModelOverride,
} from "../../hooks/queries";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { AddCustomModelForm } from "./AddCustomModelForm";
import { ModelRow } from "./ModelRow";

/**
 * Where the uncurated list came from, said plainly.
 *
 * "The models Anthropic lists" and "the models this build knows about" are
 * different answers, and only one of them is live. An operator deciding whether
 * a missing model is Anthropic's doing or ours needs to be told which they are
 * looking at.
 */
function describeBaseline(
	source: ModelBaselineSource,
	fetchedAt: number | null,
): string {
	const age =
		fetchedAt === null
			? null
			: formatDistanceToNow(new Date(fetchedAt), { addSuffix: true });
	switch (source) {
		case "upstream":
			return age
				? `Live Anthropic catalogue, fetched ${age}`
				: "Live Anthropic catalogue";
		case "bundled":
			return "Bundled fallback list — Anthropic's catalogue could not be read";
		case "codex-catalog":
			return age
				? `Static list plus the Codex catalogue, fetched ${age}`
				: "Static list plus the Codex catalogue";
		case "static":
			return "Static list — no Codex catalogue could be read";
	}
}

const DIALECT_TITLES: Record<ModelDialect, string> = {
	anthropic: "/wire/anthropic",
	openai: "/wire/openai",
};

const DIALECT_BLURBS: Record<ModelDialect, string> = {
	anthropic:
		"Served to Claude Code's gateway model discovery and anything else " +
		"reading Anthropic's model listing.",
	openai:
		"Served to the Codex CLI and to OpenAI-format clients. The plain OpenAI " +
		"list carries no display name, so a rename there shows here and in the " +
		"Codex catalogue only.",
};

export function ModelDialectPanel({ dialect }: { dialect: ModelDialect }) {
	const { data, isLoading, isError, error } = useModelCatalog(dialect);
	const setOverride = useSetModelOverride();
	const deleteOverride = useDeleteModelOverride();
	// Which rows have a write in flight, so only those go inert rather than the
	// whole list freezing on an unrelated edit. A SET, not a single id: writes
	// from different rows overlap, and tracking one id would re-enable the first
	// row the moment a second edit started, inviting a pair of full-replacement
	// writes whose loser is silently discarded.
	const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());

	// A new Set every time: React compares state by identity, and mutating the
	// existing one would leave the rows rendering the previous busy state.
	const markPending = (modelId: string, pending: boolean) => {
		setPendingIds((current) => {
			const next = new Set(current);
			if (pending) next.add(modelId);
			else next.delete(modelId);
			return next;
		});
	};

	/** One full-replacement write, with that row inert until it settles. */
	const write = async (row: {
		modelId: string;
		hidden: boolean;
		custom: boolean;
		displayName: string | null;
	}): Promise<void> => {
		markPending(row.modelId, true);
		try {
			await setOverride.mutateAsync({ dialect, ...row });
		} finally {
			markPending(row.modelId, false);
		}
	};

	const remove = async (modelId: string): Promise<void> => {
		markPending(modelId, true);
		try {
			await deleteOverride.mutateAsync({ dialect, modelId });
		} finally {
			markPending(modelId, false);
		}
	};

	/**
	 * Start a write from a row gesture and stop caring about its outcome.
	 *
	 * The rejection is dropped on purpose: the mutation's error state is already
	 * the error surface, and the row keeps whatever the operator typed. The add
	 * form is the one caller that awaits a write instead, because it has a draft
	 * to clear on success and keep on failure.
	 */
	const detach = (work: Promise<void>) => {
		void work.catch(() => {});
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle className="font-mono text-base">
					{DIALECT_TITLES[dialect]}
				</CardTitle>
				<p className="text-sm text-muted-foreground">
					{DIALECT_BLURBS[dialect]}
				</p>
			</CardHeader>
			<CardContent className="space-y-group">
				{isLoading && (
					<p className="text-sm text-muted-foreground">Loading models…</p>
				)}

				{isError && (
					<p className="text-sm text-destructive">
						Could not load the model catalogue
						{error instanceof Error ? `: ${error.message}` : ""}
					</p>
				)}

				{data && (
					<>
						<p className="text-xs text-muted-foreground">
							{describeBaseline(data.baseline.source, data.baseline.fetchedAt)}
						</p>

						{data.rows.length === 0 ? (
							<p className="text-sm text-muted-foreground">
								No models in this catalogue yet.
							</p>
						) : (
							<div>
								{data.rows.map((row: ModelCatalogRow) => (
									<ModelRow
										key={row.id}
										dialect={dialect}
										row={row}
										busy={pendingIds.has(row.id)}
										onRename={(displayName) =>
											detach(
												write({
													modelId: row.id,
													hidden: row.hidden,
													custom: row.source === "custom",
													displayName,
												}),
											)
										}
										onSetHidden={(hidden) =>
											detach(
												write({
													modelId: row.id,
													hidden,
													custom: row.source === "custom",
													// The write replaces the whole row, so the stored
													// name has to be sent back or hiding an entry would
													// also discard its rename.
													displayName: row.overrideDisplayName,
												}),
											)
										}
										onDelete={() => detach(remove(row.id))}
									/>
								))}
							</div>
						)}

						<AddCustomModelForm
							dialect={dialect}
							busy={setOverride.isPending}
							onAdd={(modelId, displayName) =>
								write({ modelId, hidden: false, custom: true, displayName })
							}
						/>
					</>
				)}
			</CardContent>
		</Card>
	);
}
