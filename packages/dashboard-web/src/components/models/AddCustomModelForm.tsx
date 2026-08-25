import type { ModelDialect } from "@clankermux/types";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

interface AddCustomModelFormProps {
	dialect: ModelDialect;
	busy: boolean;
	onAdd(modelId: string, displayName: string | null): void;
}

/**
 * Does Claude Code's model discovery keep an id like this?
 *
 * Its picker filters the gateway's listing down to ids that name the family it
 * speaks, so an id with neither "claude" nor "anthropic" in it is accepted and
 * stored here and then never appears in the client. Warning rather than
 * blocking: the listing has other readers, and the filter is the client's rule,
 * not ours.
 */
export function isLikelyDiscoverableByClaudeCode(modelId: string): boolean {
	const lowered = modelId.toLowerCase();
	return lowered.includes("claude") || lowered.includes("anthropic");
}

export function AddCustomModelForm({
	dialect,
	busy,
	onAdd,
}: AddCustomModelFormProps) {
	const [modelId, setModelId] = useState("");
	const [displayName, setDisplayName] = useState("");

	const trimmedId = modelId.trim();
	const showDiscoveryHint =
		dialect === "anthropic" &&
		trimmedId !== "" &&
		!isLikelyDiscoverableByClaudeCode(trimmedId);

	const submit = () => {
		if (trimmedId === "" || busy) return;
		onAdd(trimmedId, displayName.trim() === "" ? null : displayName.trim());
		setModelId("");
		setDisplayName("");
	};

	return (
		<div className="space-y-item border-t pt-group">
			<div className="flex flex-wrap items-end gap-row">
				<div className="space-y-tight">
					<Label htmlFor={`add-model-id-${dialect}`}>Model id</Label>
					<Input
						id={`add-model-id-${dialect}`}
						className="w-64 font-mono"
						value={modelId}
						placeholder={
							dialect === "anthropic" ? "claude-opus-5" : "gpt-5.6-sol"
						}
						disabled={busy}
						onChange={(event) => setModelId(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								submit();
							}
						}}
					/>
				</div>
				<div className="space-y-tight">
					<Label htmlFor={`add-model-name-${dialect}`}>
						Display name (optional)
					</Label>
					<Input
						id={`add-model-name-${dialect}`}
						className="w-56"
						value={displayName}
						disabled={busy}
						onChange={(event) => setDisplayName(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								submit();
							}
						}}
					/>
				</div>
				<Button
					className="gap-item"
					disabled={busy || trimmedId === ""}
					onClick={submit}
				>
					<Plus className="h-4 w-4" />
					Add custom model
				</Button>
			</div>

			{showDiscoveryHint && (
				<p className="text-xs text-warning-strong">
					Claude Code only keeps ids naming the Claude family, so it will drop
					this one from its picker. Other clients still see it.
				</p>
			)}
		</div>
	);
}
