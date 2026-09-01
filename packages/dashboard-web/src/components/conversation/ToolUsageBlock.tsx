import { Terminal } from "lucide-react";
import React, { useMemo } from "react";
import { useCollapsible } from "../../hooks/useCollapsible";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";

interface ToolUsageBlockProps {
	toolName: string;
	input?: Record<string, unknown>;
}

const MAX_CHARS_COLLAPSE = 200;

function ToolUsageBlockComponent({ toolName, input }: ToolUsageBlockProps) {
	const inputStr = useMemo(
		() => (input ? JSON.stringify(input, null, 2) : ""),
		[input],
	);

	const { display, isLong, isExpanded, toggle } = useCollapsible(
		inputStr,
		MAX_CHARS_COLLAPSE,
	);
	const hasInput = input && Object.keys(input).length > 0;

	return (
		<Alert
			tone="info"
			title={`Tool: ${toolName}`}
			// The icon keeps its own hue here, unlike the warning and success
			// blocks: Alert maps `info` icons to `text-foreground` because no info
			// call site had an icon when it was written, and `--info-strong` is
			// deliberately not invented without a consumer.
			icon={<Terminal className="w-3 h-3 text-info" />}
			action={
				hasInput && isLong ? (
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
			{hasInput ? (
				// `text-foreground` for the same reason as the tool-result block:
				// this is the tool's actual input, not a note about it.
				<pre
					className={`bg-muted p-item rounded overflow-x-auto whitespace-pre text-left text-foreground ${
						isExpanded && isLong ? "max-h-96 overflow-y-auto pr-item" : ""
					}`}
				>
					{display}
				</pre>
			) : null}
		</Alert>
	);
}

export const ToolUsageBlock = React.memo(ToolUsageBlockComponent);
