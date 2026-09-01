import type { Combo } from "@clankermux/types";
import { Edit, Trash2 } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Switch } from "../ui/switch";

interface ComboCardProps {
	combo: Combo;
	slotCount?: number;
	assignedFamily?: string | null;
	onEdit: () => void;
	onDelete: () => void;
	onToggleEnabled: (enabled: boolean) => void;
}

export function ComboCard({
	combo,
	slotCount = 0,
	assignedFamily,
	onEdit,
	onDelete,
	onToggleEnabled,
}: ComboCardProps) {
	return (
		<Card>
			<CardHeader className="pb-row">
				<div className="flex items-start justify-between gap-item">
					<div className="min-w-0 flex-1">
						<CardTitle className="text-base leading-snug">
							{combo.name}
						</CardTitle>
						{combo.description && (
							<CardDescription className="line-clamp-2">
								{combo.description}
							</CardDescription>
						)}
					</div>
					<Switch checked={combo.enabled} onCheckedChange={onToggleEnabled} />
				</div>
			</CardHeader>
			<CardContent>
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-item">
						<span className="text-sm text-muted-foreground">
							{slotCount} {slotCount === 1 ? "slot" : "slots"}
						</span>
						{assignedFamily && (
							<Badge variant="secondary">{assignedFamily}</Badge>
						)}
					</div>
					<div className="flex items-center gap-tight">
						<Button variant="ghost" size="sm" onClick={onEdit}>
							<Edit className="h-4 w-4" />
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={onDelete}
							className="text-destructive-strong hover:text-destructive-strong"
						>
							<Trash2 className="h-4 w-4" />
						</Button>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
