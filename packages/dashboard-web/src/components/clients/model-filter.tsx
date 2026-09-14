import type { ClientModel } from "@clankermux/types";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/**
 * Every term of `query` must appear in one of the model's three names. The
 * fields are searched separately, so `gpt claude` matches nothing that does not
 * carry both words.
 */
export function matchesModelQuery(model: ClientModel, query: string): boolean {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!terms.length) return true;
	const fields = [model.id, model.displayName, model.targetModel].map((field) =>
		field.toLowerCase(),
	);
	return terms.every((term) => fields.some((field) => field.includes(term)));
}

export function ModelFilterField({
	value,
	onChange,
	shown,
	total,
	label,
}: {
	value: string;
	onChange: (value: string) => void;
	shown: number;
	total: number;
	label: string;
}) {
	return (
		<div className="grid gap-1">
			<div className="flex items-center gap-2">
				<Input
					type="search"
					className="max-w-xs"
					aria-label={label}
					placeholder="Filter models"
					value={value}
					onChange={(e) => onChange(e.target.value)}
				/>
				{value && (
					<Button variant="ghost" size="sm" onClick={() => onChange("")}>
						Clear
					</Button>
				)}
			</div>
			<p className="text-xs text-muted-foreground tabular-nums">
				{shown} of {total} shown
			</p>
		</div>
	);
}
