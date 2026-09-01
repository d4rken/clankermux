import { MessageSquare } from "lucide-react";
import React from "react";
import { useCollapsible } from "../../hooks/useCollapsible";
import { Alert } from "../ui/alert";
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
		// The shell is a byte-for-byte match for what this rendered by hand
		// (`p-3` is `p-row`), but two things inside it do move: the title grows
		// from text-xs to Alert-sm's text-sm, and the header-to-body gap grows
		// from 0.25rem to Alert's own 0.5rem. The old `mb-1` is therefore gone
		// rather than left to stack on top of that offset.
		<Alert
			tone="warning"
			title="Thinking"
			icon={<MessageSquare className="w-3 h-3" />}
			action={
				isLong ? (
					// h-6, matching the other two blocks; this one was the h-5
					// outlier. `text-xs` is dropped: Button's sm size already sets it.
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
			<div className="whitespace-pre overflow-x-auto">{display}</div>
		</Alert>
	);
}

export const ThinkingBlock = React.memo(ThinkingBlockComponent);
