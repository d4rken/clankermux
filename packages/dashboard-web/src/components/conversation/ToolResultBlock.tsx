import { FileText } from "lucide-react";
import React from "react";
import { useCollapsible } from "../../hooks/useCollapsible";
import { Button } from "../ui/button";

interface ToolResultBlockProps {
	content: string;
}

const MAX_CHARS_COLLAPSE = 200;

function ToolResultBlockComponent({ content }: ToolResultBlockProps) {
	const { display, isLong, isExpanded, toggle } = useCollapsible(
		content,
		MAX_CHARS_COLLAPSE,
	);

	return (
		<div className="p-3 bg-success/10 border border-success/25 rounded-lg">
			<div className="flex items-center justify-between mb-1">
				<div className="flex items-center gap-item">
					<FileText className="w-3 h-3 text-success-strong" />
					<span className="text-xs font-medium text-success-strong">
						Tool Result
					</span>
				</div>
				{isLong && (
					<Button
						variant="ghost"
						size="sm"
						className="h-6 px-2 text-xs"
						onClick={toggle}
					>
						{isExpanded ? "Show less" : "Show more"}
					</Button>
				)}
			</div>
			<div className="text-xs bg-muted p-2 rounded mt-1 overflow-hidden">
				<pre
					className={`overflow-x-auto whitespace-pre text-left ${
						isExpanded && isLong ? "max-h-96 overflow-y-auto pr-2" : ""
					}`}
				>
					{display}
				</pre>
			</div>
		</div>
	);
}

export const ToolResultBlock = React.memo(ToolResultBlockComponent);
