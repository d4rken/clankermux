import type { Role } from "@clankermux/types";
import React from "react";
import { useCollapsible } from "../../hooks/useCollapsible";
import { Button } from "../ui/button";
import { ROLE_BACKGROUNDS } from "./role-styles";

interface MessageBubbleProps {
	role: Role;
	content: string;
}

const MAX_CHARS_COLLAPSE = 300;

function MessageBubbleComponent({ role, content }: MessageBubbleProps) {
	const { display, isLong, isExpanded, toggle } = useCollapsible(
		content,
		MAX_CHARS_COLLAPSE,
	);
	const bgColor = ROLE_BACKGROUNDS[role];

	return (
		<div>
			<div className={`rounded-lg px-group py-item ${bgColor}`}>
				<div
					className={`whitespace-pre text-sm overflow-x-auto text-left ${
						isExpanded && isLong ? "max-h-96 overflow-y-auto pr-item" : ""
					}`}
				>
					{display}
				</div>
			</div>
			{isLong && (
				<Button
					variant="ghost"
					size="sm"
					className="mt-tight h-6 px-item text-xs"
					onClick={toggle}
				>
					{isExpanded ? "Show less" : "Show more"}
				</Button>
			)}
		</div>
	);
}

export const MessageBubble = React.memo(MessageBubbleComponent);
