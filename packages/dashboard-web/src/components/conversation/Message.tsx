import {
	type ContentBlock,
	ContentBlockType,
	type Role,
	type ToolResult,
	type ToolUse,
} from "@clankermux/types";
import type { LucideIcon } from "lucide-react";
import { Bot, FileText, Terminal, User } from "lucide-react";
import React from "react";
import { Badge } from "../ui/badge";
import { MessageBubble } from "./MessageBubble";
import { ROLE_BACKGROUNDS } from "./role-styles";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolResultBlock } from "./ToolResultBlock";
import { ToolUsageBlock } from "./ToolUsageBlock";

interface MessageProps {
	role: Role;
	content: string;
	contentBlocks?: ContentBlock[];
	tools?: ToolUse[];
	toolResults?: ToolResult[];
	cleanLineNumbers: (content: string) => string;
}

/** The avatar glyph. Only `Message` draws one, so it stays local. */
const ROLE_ICONS: Record<Role, LucideIcon> = {
	user: User,
	assistant: Bot,
	system: Bot,
};

function MessageComponent({
	role,
	content,
	contentBlocks,
	tools,
	toolResults,
	cleanLineNumbers,
}: MessageProps) {
	const isRightAligned = role === "user";
	const thinkingBlock = contentBlocks?.find(
		(b) => b.type === ContentBlockType.Thinking,
	);
	const thinkingText =
		typeof thinkingBlock?.thinking === "string" ? thinkingBlock.thinking : "";
	const hasThinking =
		thinkingText && cleanLineNumbers(thinkingText).trim().length > 0;
	const cleanedContent =
		typeof content === "string" ? cleanLineNumbers(content).trim() : "";
	const hasTools = tools?.length || 0;
	const hasToolResults = toolResults?.length || 0;

	const Icon = ROLE_ICONS[role];

	return (
		<div
			className={`flex gap-row w-full ${isRightAligned ? "flex-row-reverse" : "flex-row"}`}
		>
			<div
				className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${ROLE_BACKGROUNDS[role]}`}
			>
				<Icon className="w-4 h-4" />
			</div>

			<div
				className={`flex-1 min-w-0 ${isRightAligned ? "text-right" : "text-left"}`}
			>
				<div
					className={`inline-block max-w-[85%] ${isRightAligned ? "ml-auto" : "mr-auto"}`}
				>
					<div className="flex items-center gap-item mb-tight">
						<span className="text-xs font-medium text-muted-foreground">
							{role.charAt(0).toUpperCase() + role.slice(1)}
						</span>
						{hasThinking && <Badge variant="secondary">Thinking</Badge>}
						{hasTools > 0 && (
							<Badge variant="outline">
								<Terminal className="w-3 h-3 mr-tight" />
								{hasTools} tool{hasTools > 1 ? "s" : ""} used
							</Badge>
						)}
						{hasToolResults > 0 && (
							<Badge variant="secondary">
								<FileText className="w-3 h-3 mr-tight" />
								{hasToolResults} result{hasToolResults > 1 ? "s" : ""}
							</Badge>
						)}
					</div>

					{/* Thinking block */}
					{hasThinking && thinkingBlock && (
						<div className="mb-item">
							<ThinkingBlock content={cleanLineNumbers(thinkingText)} />
						</div>
					)}

					{/* Main content */}
					{cleanedContent.length > 0 && (
						<MessageBubble role={role} content={cleanedContent} />
					)}

					{/* Tool usage */}
					{hasTools > 0 && (
						<div className="mt-item space-y-item">
							{tools?.map((tool, index) => (
								<ToolUsageBlock
									key={
										// biome-ignore lint/suspicious/noArrayIndexKey: ToolUse.id is optional; index is a tiebreaker when multiple tools share name without id
										`tool-${tool.id || tool.name}-${index}`
									}
									toolName={tool.name}
									input={tool.input}
								/>
							))}
						</div>
					)}

					{/* Tool results */}
					{hasToolResults > 0 && (
						<div className="mt-item space-y-item">
							{toolResults?.map((result, index) => (
								<ToolResultBlock
									key={`result-${result.tool_use_id || index}`}
									content={
										typeof result.content === "string"
											? cleanLineNumbers(result.content)
											: ""
									}
								/>
							))}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

export const Message = React.memo(MessageComponent);
