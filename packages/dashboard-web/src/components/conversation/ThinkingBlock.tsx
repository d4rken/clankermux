import { MessageSquare } from "lucide-react";
import React from "react";
import { useCollapsible } from "../../hooks/useCollapsible";
import { Button } from "../ui/button";

interface ThinkingBlockProps {
	content: string;
}

const MAX_CHARS_COLLAPSE = 200;

function ThinkingBlockComponent({ content }: ThinkingBlockProps) {
	const { display, isLong, isExpanded, toggle } = useCollapsible(
		content,
		MAX_CHARS_COLLAPSE,
	);

	return (
		<div className="p-3 bg-warning/10 border border-warning/25 rounded-lg">
			<div className="flex items-center justify-between mb-1">
				<div className="flex items-center gap-2">
					<MessageSquare className="w-3 h-3 text-warning-strong" />
					<span className="text-xs font-medium text-warning-strong">
						Thinking
					</span>
				</div>
				{isLong && (
					<Button
						variant="ghost"
						size="sm"
						className="h-5 px-2 text-xs"
						onClick={toggle}
					>
						{isExpanded ? "Show less" : "Show more"}
					</Button>
				)}
			</div>
			<div className="text-xs text-muted-foreground whitespace-pre overflow-x-auto">
				{display}
			</div>
		</div>
	);
}

export const ThinkingBlock = React.memo(ThinkingBlockComponent);
