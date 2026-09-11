import { createHash } from "node:crypto";
import type { ChatRequirements } from "@clankermux/types";
import { ChatError, keys, object, string } from "./errors";

type Block =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string; signature: "" }
	| {
			type: "tool_use";
			id: string;
			name: string;
			input: Record<string, unknown>;
	  }
	| { type: "tool_result"; tool_use_id: string; content: string };
export interface MessagesBody {
	model: string;
	stream: true;
	messages: { role: "user" | "assistant"; content: Block[] }[];
	system?: { type: "text"; text: string }[];
	tools?: {
		name: string;
		description?: string;
		input_schema: Record<string, unknown>;
	}[];
	tool_choice?: { type: "auto" | "none" | "any" | "tool"; name?: string };
	max_tokens?: number;
	temperature?: number;
	top_p?: number;
	stop_sequences?: string[];
}
export interface TranslatedChat {
	body: MessagesBody;
	stream: boolean;
	includeUsage: boolean;
	names: Map<string, string>;
	requirements: ChatRequirements;
}
export function translateChatRequest(value: unknown): TranslatedChat {
	const req = object(value, "body");
	keys(req, [
		"model",
		"messages",
		"tools",
		"tool_choice",
		"stream",
		"stream_options",
		"n",
		"max_tokens",
		"temperature",
		"top_p",
		"stop",
		"response_format",
	]);
	const body: MessagesBody = {
		model: string(req.model, "model"),
		stream: true,
		messages: [],
	};
	for (const field of ["stream"] as const)
		if (field in req && typeof req[field] !== "boolean")
			throw new ChatError(`${field}: expected a boolean`, field);
	if ("n" in req && req.n !== 1)
		throw new ChatError(
			"Only n=1 is supported",
			"n",
			400,
			"unsupported_parameter",
		);
	if ("response_format" in req) {
		const format = object(req.response_format, "response_format");
		keys(format, ["type"], "response_format");
		if (format.type !== "text")
			throw new ChatError(
				"Only text response_format is supported",
				"response_format",
				400,
				"unsupported_parameter",
			);
	}
	let includeUsage = false;
	if ("stream_options" in req) {
		const options = object(req.stream_options, "stream_options");
		keys(options, ["include_usage"], "stream_options");
		if (
			req.stream !== true ||
			("include_usage" in options && typeof options.include_usage !== "boolean")
		)
			throw new ChatError(
				"stream_options requires stream:true and boolean include_usage",
				"stream_options",
			);
		includeUsage = options.include_usage === true;
	}
	const fields: string[] = [];
	for (const field of ["max_tokens", "temperature", "top_p"] as const) {
		if (!(field in req)) continue;
		const v = req[field];
		if (
			typeof v !== "number" ||
			!Number.isFinite(v) ||
			(field === "max_tokens"
				? !Number.isSafeInteger(v) || v < 1
				: v < 0 || v > (field === "temperature" ? 2 : 1))
		)
			throw new ChatError(`Invalid ${field}`, field);
		body[field] = v;
		fields.push(field);
	}
	if ("stop" in req) {
		const stops = Array.isArray(req.stop) ? req.stop : [req.stop];
		if (!stops.length || stops.length > 4)
			throw new ChatError("stop requires 1 to 4 nonempty strings", "stop");
		body.stop_sequences = stops.map((s, i) => string(s, `stop[${i}]`));
		fields.push("stop");
	}
	const names = new Map<string, string>();
	const encode = (name: string) => {
		if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name))
			throw new ChatError(
				"Function names must contain 1–64 letters, digits, underscores or hyphens",
				"tools",
			);
		const encoded = `cmux_chat_${createHash("sha256").update(name).digest("hex").slice(0, 48)}`;
		names.set(encoded, name);
		return encoded;
	};
	const declared = new Set<string>();
	if ("tools" in req) {
		if (!Array.isArray(req.tools))
			throw new ChatError("tools must be an array", "tools");
		body.tools = req.tools.map((v, i) => {
			const p = `tools[${i}]`,
				t = object(v, p);
			keys(t, ["type", "function"], p);
			if (t.type !== "function")
				throw new ChatError(
					"Only function tools are supported",
					p,
					400,
					"unsupported_parameter",
				);
			const f = object(t.function, `${p}.function`);
			keys(f, ["name", "description", "parameters", "strict"], `${p}.function`);
			if ("strict" in f && f.strict !== false)
				throw new ChatError(
					"strict tools are not supported",
					`${p}.function.strict`,
					400,
					"unsupported_parameter",
				);
			const name = string(f.name, `${p}.function.name`);
			if (declared.has(name))
				throw new ChatError("Duplicate function name", `${p}.function.name`);
			declared.add(name);
			return {
				name: encode(name),
				...(f.description !== undefined
					? {
							description: string(
								f.description,
								`${p}.function.description`,
								true,
							),
						}
					: {}),
				input_schema:
					f.parameters === undefined
						? { type: "object", properties: {} }
						: object(f.parameters, `${p}.function.parameters`),
			};
		});
		if (!body.tools.length) delete body.tools;
	}
	if ("tool_choice" in req) {
		const c = req.tool_choice;
		if (c === "auto" || c === "none" || c === "required") {
			if (c === "required" && !body.tools?.length)
				throw new ChatError("required tool_choice needs tools", "tool_choice");
			if (body.tools?.length)
				body.tool_choice = { type: c === "required" ? "any" : c };
		} else {
			const choice = object(c, "tool_choice");
			keys(choice, ["type", "function"], "tool_choice");
			const f = object(choice.function, "tool_choice.function");
			keys(f, ["name"], "tool_choice.function");
			const name = string(f.name, "tool_choice.function.name");
			if (choice.type !== "function" || !declared.has(name))
				throw new ChatError(
					"tool_choice must name a declared function",
					"tool_choice",
				);
			body.tool_choice = { type: "tool", name: encode(name) };
		}
	}
	if (!Array.isArray(req.messages) || !req.messages.length)
		throw new ChatError("messages must be a nonempty array", "messages");
	let instructionRole: string | undefined;
	const pending = new Set<string>(),
		used = new Set<string>();
	const textParts = (
		content: unknown,
		path: string,
	): { type: "text"; text: string }[] => {
		if (typeof content === "string")
			return content.length ? [{ type: "text", text: content }] : [];
		if (!Array.isArray(content))
			throw new ChatError("Expected text content", path);
		return content.flatMap((v, i) => {
			const p = `${path}[${i}]`,
				part = object(v, p);
			keys(part, ["type", "text"], p);
			if (part.type !== "text")
				throw new ChatError(
					"Only text content is supported",
					p,
					400,
					"unsupported_parameter",
				);
			const text = string(part.text, `${p}.text`, true);
			return text.length ? [{ type: "text" as const, text }] : [];
		});
	};
	for (const [i, v] of req.messages.entries()) {
		const p = `messages[${i}]`,
			m = object(v, p);
		keys(
			m,
			["role", "content", "tool_calls", "tool_call_id", "reasoning_content"],
			p,
		);
		const role = string(m.role, `${p}.role`);
		if ("reasoning_content" in m && role !== "assistant")
			throw new ChatError(
				"Reasoning replay requires an assistant message",
				`${p}.reasoning_content`,
			);
		if (role === "system" || role === "developer") {
			if (body.messages.length || (instructionRole && instructionRole !== role))
				throw new ChatError(
					"Only one leading instruction role is supported",
					`${p}.role`,
					400,
					"unsupported_parameter",
				);
			if ("tool_calls" in m || "tool_call_id" in m)
				throw new ChatError("Unexpected tool fields", p);
			instructionRole = role;
			body.system ??= [];
			body.system.push(...textParts(m.content, `${p}.content`));
			continue;
		}
		if (role === "tool") {
			keys(m, ["role", "content", "tool_call_id"], p);
			const id = string(m.tool_call_id, `${p}.tool_call_id`);
			if (!pending.delete(id))
				throw new ChatError(
					"Tool result has no matching pending call",
					`${p}.tool_call_id`,
				);
			const result: Block = {
				type: "tool_result",
				tool_use_id: id,
				content: string(m.content, `${p}.content`, true),
			};
			const last = body.messages.at(-1);
			if (
				last?.role === "user" &&
				last.content.every((b) => b.type === "tool_result")
			)
				last.content.push(result);
			else body.messages.push({ role: "user", content: [result] });
			continue;
		}
		if (role !== "user" && role !== "assistant")
			throw new ChatError(
				"Unsupported message role",
				`${p}.role`,
				400,
				"unsupported_parameter",
			);
		if (pending.size)
			throw new ChatError("Tool calls require results before the next turn", p);
		if ("tool_call_id" in m || (role !== "assistant" && "tool_calls" in m))
			throw new ChatError("Unexpected tool fields", p);
		const content: Block[] =
			m.content === null || m.content === undefined
				? []
				: textParts(m.content, `${p}.content`);
		if ("reasoning_content" in m) {
			const thinking = string(
				m.reasoning_content,
				`${p}.reasoning_content`,
				true,
			);
			// OpenRouter requires the signature key even for unsigned text reasoning.
			content.unshift({ type: "thinking", thinking, signature: "" });
			if (!fields.includes("reasoning_content"))
				fields.push("reasoning_content");
		}
		if ("tool_calls" in m) {
			if (!Array.isArray(m.tool_calls) || !m.tool_calls.length)
				throw new ChatError("tool_calls must be nonempty", `${p}.tool_calls`);
			for (const [j, v] of m.tool_calls.entries()) {
				const q = `${p}.tool_calls[${j}]`,
					call = object(v, q);
				keys(call, ["id", "type", "function"], q);
				const id = string(call.id, `${q}.id`);
				if (call.type !== "function" || used.has(id))
					throw new ChatError("Invalid or duplicate function call", q);
				used.add(id);
				pending.add(id);
				const f = object(call.function, `${q}.function`);
				keys(f, ["name", "arguments"], `${q}.function`);
				const args = string(f.arguments, `${q}.function.arguments`, true);
				let parsed: unknown;
				try {
					parsed = JSON.parse(args);
				} catch {
					throw new ChatError(
						"Invalid JSON tool arguments",
						`${q}.function.arguments`,
					);
				}
				content.push({
					type: "tool_use",
					id,
					name: encode(string(f.name, `${q}.function.name`)),
					input: object(parsed, `${q}.function.arguments`),
				});
			}
		}
		if (!content.length)
			throw new ChatError(
				"Message must contain text or tool calls",
				`${p}.content`,
			);
		body.messages.push({ role, content });
	}
	if (pending.size)
		throw new ChatError("Conversation has unanswered tool calls", "messages");
	if (!body.messages.length)
		throw new ChatError(
			"Conversation requires a user or assistant turn",
			"messages",
		);
	return {
		body,
		stream: req.stream === true,
		includeUsage,
		names,
		requirements: Object.freeze({ fields: Object.freeze(fields) }),
	};
}
