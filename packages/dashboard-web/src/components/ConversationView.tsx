import type { MessageData } from "@clankermux/types";
import {
	cleanLineNumbers,
	genMessageKey,
	parseAssistantMessage,
	parseRequestMessages,
} from "@clankermux/ui-common";
import React, { useCallback, useMemo } from "react";
import { Message } from "./conversation";

interface ConversationViewProps {
	requestBody: string | null;
	responseBody: string | null;
}

function ConversationViewComponent({
	requestBody,
	responseBody,
}: ConversationViewProps) {
	// Create stable cleanLineNumbers function
	const cleanLineNumbersCallback = useCallback(cleanLineNumbers, []);

	// Parse request body to extract conversation messages
	const requestMessages = useMemo(
		() => parseRequestMessages(requestBody),
		[requestBody],
	);

	// Parse streaming response to extract assistant message
	const assistantMessage = useMemo(
		() => parseAssistantMessage(responseBody),
		[responseBody],
	);

	// Derived synchronously, and deliberately NOT via `useState` + `useEffect`.
	// With state populated from an effect, EVERY conversation — valid ones
	// included — rendered `messages.length === 0` on its first paint, so opening
	// any request flashed the empty state before the real one arrived.
	const messages = useMemo(() => {
		const allMessages: MessageData[] = [...requestMessages];
		if (assistantMessage) {
			allMessages.push(assistantMessage);
		}
		return allMessages;
	}, [requestMessages, assistantMessage]);

	// One fixed-height container around both branches, so the panel does not
	// change size between the empty and loaded states. The height constant is
	// hand-tuned against the modal header above it — do not adjust it here.
	return (
		<div className="h-[calc(65vh-10rem)] w-full overflow-hidden">
			{messages.length === 0 ? (
				<div className="flex h-full w-full items-center justify-center">
					<p className="text-muted-foreground">
						No conversation data available
					</p>
				</div>
			) : (
				<div className="h-full w-full overflow-y-auto overflow-x-hidden px-group py-row space-y-row">
					{messages.map((message, index) => (
						<Message
							key={genMessageKey(message, index)}
							role={message.role}
							content={message.content}
							contentBlocks={message.contentBlocks}
							tools={message.tools}
							toolResults={message.toolResults}
							cleanLineNumbers={cleanLineNumbersCallback}
						/>
					))}
				</div>
			)}
		</div>
	);
}

export const ConversationView = React.memo(ConversationViewComponent);
