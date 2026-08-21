import { Check, Palette as PaletteIcon } from "lucide-react";
import { PALETTES, useTheme } from "../contexts/theme-context";
import { Button } from "./ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";

/**
 * Visual-direction picker. Sits next to the light/dark toggle because the two
 * are independent: changing direction keeps whichever mode is active.
 *
 * Each row previews its own palette with three swatches rendered from that
 * palette's actual token values. They are hardcoded here rather than read from
 * CSS because the swatch has to show the palette you are NOT currently in —
 * `getComputedStyle` on the live document can only ever report the active one.
 * Keep them in step with styles/globals.css.
 */
const SWATCHES: Record<string, [string, string, string]> = {
	classic: ["#12151a", "#2c333b", "#f38020"],
	signal: ["#0a0e11", "#1e2a31", "#4fc3e8"],
	foundry: ["#151210", "#342c25", "#f2691c"],
	paper: ["#eef1f2", "#d9e0e2", "#0f6d74"],
};

export function PalettePicker() {
	const { palette, setPalette } = useTheme();

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className="w-9 px-0"
					title="Visual direction"
				>
					<PaletteIcon className="h-[1.2rem] w-[1.2rem]" />
					<span className="sr-only">Change visual direction</span>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-64">
				{PALETTES.map((option) => {
					const swatch = SWATCHES[option.id] ?? SWATCHES.classic;
					return (
						<DropdownMenuItem
							key={option.id}
							onClick={() => setPalette(option.id)}
							className="gap-3 py-2"
						>
							<span
								className="flex h-6 w-6 shrink-0 overflow-hidden rounded-sm border"
								aria-hidden="true"
							>
								{swatch.map((color) => (
									<span
										key={color}
										className="h-full flex-1"
										style={{ backgroundColor: color }}
									/>
								))}
							</span>
							<span className="min-w-0 flex-1">
								<span className="block text-sm font-medium leading-tight">
									{option.label}
								</span>
								<span className="block text-xs text-muted-foreground leading-tight">
									{option.description}
								</span>
							</span>
							{palette === option.id && (
								<Check className="h-4 w-4 shrink-0 text-primary" />
							)}
						</DropdownMenuItem>
					);
				})}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
