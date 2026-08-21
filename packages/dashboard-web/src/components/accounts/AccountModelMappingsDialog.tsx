import React, { useMemo, useState } from "react";
import type { Account } from "../../api";
import {
	buildModelMappingsPayload,
	formatMappingValue,
	getPlaceholderModels,
	type ModelFamilyFieldValues,
} from "../../lib/model-mappings";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

interface AccountModelMappingsDialogProps {
	isOpen: boolean;
	account: Account | null;
	onOpenChange: (open: boolean) => void;
	onUpdateModelMappings: (
		accountId: string,
		modelMappings: { [key: string]: string | string[] },
	) => Promise<void>;
}

const EMPTY_FIELDS: ModelFamilyFieldValues = {
	opus: "",
	sonnet: "",
	haiku: "",
	fable: "",
};

export function AccountModelMappingsDialog({
	isOpen,
	account,
	onOpenChange,
	onUpdateModelMappings,
}: AccountModelMappingsDialogProps) {
	const [modelMappings, setModelMappings] =
		useState<ModelFamilyFieldValues>(EMPTY_FIELDS);
	// The account's mapping as stored. Keys outside the four family fields (e.g.
	// an exact `claude-fable-5` entry) are not editable here but must survive a
	// save, since the update endpoint replaces model_mappings wholesale.
	const [storedMappings, setStoredMappings] = useState<{
		[key: string]: string | string[];
	} | null>(null);
	const [isLoading, setIsLoading] = useState(false);

	const placeholders = useMemo(
		() => getPlaceholderModels(account?.provider),
		[account?.provider],
	);

	// Update form when account changes
	React.useEffect(() => {
		const stored = account?.modelMappings ?? null;
		setStoredMappings(stored);
		if (stored) {
			setModelMappings({
				opus: formatMappingValue(stored.opus),
				sonnet: formatMappingValue(stored.sonnet),
				haiku: formatMappingValue(stored.haiku),
				fable: formatMappingValue(stored.fable),
			});
		} else {
			setModelMappings(EMPTY_FIELDS);
		}
	}, [account]);

	const handleSave = async () => {
		if (!account) return;

		setIsLoading(true);
		try {
			await onUpdateModelMappings(
				account.id,
				buildModelMappingsPayload(storedMappings, modelMappings),
			);
			onOpenChange(false);
		} catch (error) {
			console.error("Failed to update model mappings:", error);
		} finally {
			setIsLoading(false);
		}
	};

	const handleInputChange = (
		modelType: keyof ModelFamilyFieldValues,
		value: string,
	) => {
		setModelMappings((prev) => ({
			...prev,
			[modelType]: value,
		}));
	};

	if (!account) return null;

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[600px] flex flex-col max-h-[85vh]">
				<DialogHeader>
					<DialogTitle>Edit Model Configuration</DialogTitle>
					<DialogDescription>
						Configure model mappings for {account.name}. Separate multiple
						models with commas to cycle through them on rate limits.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-group py-2 overflow-y-auto flex-1">
					<div>
						<h4 className="text-sm font-medium mb-2">Model Mappings</h4>
						<p className="text-xs text-muted-foreground mb-3">
							Map Anthropic model names to provider-specific models. Use commas
							for multiple models (e.g.{" "}
							<code className="text-xs bg-muted px-1 rounded">
								model-a, model-b
							</code>
							) to cycle on rate limits.
						</p>
						<div className="grid grid-cols-2 gap-row">
							<div className="space-y-tight">
								<Label htmlFor="opus" className="text-xs">
									Opus
								</Label>
								<Input
									id="opus"
									value={modelMappings.opus}
									onChange={(e) => handleInputChange("opus", e.target.value)}
									placeholder={`e.g., ${placeholders.opus}`}
									className="h-8"
								/>
							</div>
							<div className="space-y-tight">
								<Label htmlFor="sonnet" className="text-xs">
									Sonnet
								</Label>
								<Input
									id="sonnet"
									value={modelMappings.sonnet}
									onChange={(e) => handleInputChange("sonnet", e.target.value)}
									placeholder={`e.g., ${placeholders.sonnet}`}
									className="h-8"
								/>
							</div>
							<div className="space-y-tight">
								<Label htmlFor="haiku" className="text-xs">
									Haiku
								</Label>
								<Input
									id="haiku"
									value={modelMappings.haiku}
									onChange={(e) => handleInputChange("haiku", e.target.value)}
									placeholder={`e.g., ${placeholders.haiku}`}
									className="h-8"
								/>
							</div>
							<div className="space-y-tight">
								<Label htmlFor="fable" className="text-xs">
									Fable
								</Label>
								<Input
									id="fable"
									value={modelMappings.fable}
									onChange={(e) => handleInputChange("fable", e.target.value)}
									placeholder={`e.g., ${placeholders.fable}`}
									className="h-8"
								/>
							</div>
						</div>
					</div>
				</div>
				<DialogFooter className="mt-2 shrink-0">
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={isLoading}
					>
						Cancel
					</Button>
					<Button type="button" onClick={handleSave} disabled={isLoading}>
						{isLoading ? "Saving..." : "Save Changes"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
