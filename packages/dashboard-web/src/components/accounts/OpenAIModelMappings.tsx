import { useEffect, useId, useRef, useState } from "react";
import { api } from "../../api";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

export interface OpenAIModelMappingsProps {
	apiKey: string;
	endpoint: string;
	mappings: { opusModel: string; sonnetModel: string; haikuModel: string };
	onChange: (
		field: "opusModel" | "sonnetModel" | "haikuModel",
		value: string,
	) => void;
}

export function OpenAIModelMappings({
	apiKey,
	endpoint,
	mappings,
	onChange,
}: OpenAIModelMappingsProps) {
	const listId = useId();
	const [models, setModels] = useState<
		Array<{ id: string; displayName: string }>
	>([]);
	const [status, setStatus] = useState("idle");
	const [error, setError] = useState("");
	const pending = useRef<AbortController | null>(null);
	// These source fields deliberately drive cleanup even though the effect
	// only clears results; removing them would allow stale responses to land.
	// biome-ignore lint/correctness/useExhaustiveDependencies: invalidate previews on credential/endpoint changes
	useEffect(() => {
		// Also runs on unmount (provider switch, cancel, or successful save).
		setModels([]);
		setStatus("idle");
		setError("");
		return () => {
			pending.current?.abort();
			pending.current = null;
		};
	}, [apiKey, endpoint]);
	const fetchModels = async () => {
		pending.current?.abort();
		const controller = new AbortController();
		pending.current = controller;
		setStatus("loading");
		setError("");
		try {
			const result = await api.previewOpenAICompatibleModels(
				{ apiKey, endpoint },
				controller.signal,
			);
			if (controller.signal.aborted || pending.current !== controller) return;
			if (!result.models.length)
				throw new Error("The endpoint returned no usable models.");
			setModels(result.models);
			setStatus("success");
		} catch (err) {
			if (controller.signal.aborted || pending.current !== controller) return;
			setModels([]);
			setStatus("error");
			setError(err instanceof Error ? err.message : "Model discovery failed.");
		}
	};
	return (
		<div className="space-y-item">
			<Button
				type="button"
				variant="outline"
				size="sm"
				disabled={!apiKey.trim() || !endpoint.trim() || status === "loading"}
				onClick={fetchModels}
			>
				{status === "loading" ? "Fetching…" : "Fetch models"}
			</Button>
			<div aria-live="polite" className="text-xs text-muted-foreground">
				{status === "success" &&
					`Found ${models.length} models. Choose a model for each mapping below.`}
				{status === "error" &&
					`${error} You can still enter model IDs manually.`}
			</div>
			<Label>Model Mappings (Optional)</Label>
			<p className="text-xs text-muted-foreground">
				Search available models or enter any model ID. Leave empty to use
				defaults. Changing the API key, endpoint, or provider clears these
				mappings.
			</p>
			<datalist id={listId}>
				{models.map((model) => (
					<option key={model.id} value={model.id}>
						{model.displayName}
					</option>
				))}
			</datalist>
			<div className="space-y-item pl-group">
				{(["opus", "sonnet", "haiku"] as const).map((family) => {
					const field = `${family}Model` as const;
					return (
						<div key={family}>
							<Label htmlFor={field} className="text-sm">
								{family[0].toUpperCase() + family.slice(1)} Model
							</Label>
							<Input
								id={field}
								list={listId}
								autoComplete="off"
								value={mappings[field]}
								onChange={(event) => onChange(field, event.target.value)}
								placeholder={
									family === "haiku"
										? "openai/gpt-5-mini (default)"
										: "openai/gpt-5 (default)"
								}
								className="mt-tight"
							/>
						</div>
					);
				})}
			</div>
		</div>
	);
}
