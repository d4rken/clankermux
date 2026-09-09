import { Input } from "../ui/input";
import { Label } from "../ui/label";

type ModelMappingField = "opusModel" | "sonnetModel" | "haikuModel";

export interface ModelMappingFieldsProps {
	/** Current value of each family field, keyed as on the add-form state. */
	mappings: Record<ModelMappingField, string>;
	onChange: (field: ModelMappingField, value: string) => void;
	/** Provider-specific explanation of what an empty family does. */
	description: string;
	placeholders: Record<ModelMappingField, string>;
}

const FAMILIES: Array<{ label: string; field: ModelMappingField }> = [
	{ label: "Opus Model", field: "opusModel" },
	{ label: "Sonnet Model", field: "sonnetModel" },
	{ label: "Haiku Model", field: "haikuModel" },
];

/**
 * Presentational opus/sonnet/haiku mapping trio shared by the API-key provider
 * modes that have no model discovery. Uses the same prop shape as
 * `OpenAIModelMappings` so the two stay interchangeable at the call site.
 */
export function ModelMappingFields({
	mappings,
	onChange,
	description,
	placeholders,
}: ModelMappingFieldsProps) {
	return (
		<div className="space-y-item">
			<Label>Model Mappings (Optional)</Label>
			<p className="text-xs text-muted-foreground mb-item">{description}</p>
			<div className="space-y-item pl-group">
				{FAMILIES.map(({ label, field }) => (
					<div key={field}>
						<Label htmlFor={field} className="text-sm">
							{label}
						</Label>
						<Input
							id={field}
							value={mappings[field]}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
								onChange(field, (e.target as HTMLInputElement).value)
							}
							placeholder={placeholders[field]}
							className="mt-tight"
						/>
					</div>
				))}
			</div>
		</div>
	);
}
