import { FileText } from "lucide-react";
import React from "react";
import { useCollapsible } from "../../hooks/useCollapsible";
import { Alert } from "../ui/alert";
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
		<Alert
			tone="success"
			title="Tool Result"
			icon={<FileText className="w-3 h-3" />}
			action={
				isLong ? (
					<Button
						variant="ghost"
						size="sm"
						className="h-6 px-2"
						onClick={toggle}
					>
						{isExpanded ? "Show less" : "Show more"}
					</Button>
				) : undefined
			}
		>
			{/* `text-foreground` is not redundant: Alert's body wrapper sets the
			    muted body type, and this block is tool OUTPUT rather than a note
			    about it — dimming it would be a legibility regression, not a
			    restyle. The old `mt-1` is gone; the wrapper supplies that offset. */}
			<div className="bg-muted p-item rounded overflow-hidden text-foreground">
				<pre
					className={`overflow-x-auto whitespace-pre text-left ${
						isExpanded && isLong ? "max-h-96 overflow-y-auto pr-item" : ""
					}`}
				>
					{display}
				</pre>
			</div>
		</Alert>
	);
}

export const ToolResultBlock = React.memo(ToolResultBlockComponent);
