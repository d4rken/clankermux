/** Validate a JSON value incrementally, retaining only native response accounting. */
type Selection = { readonly [key: string]: Selection | true };
const ERROR: Selection = { code: true, type: true };
const FIELDS: Selection = {
	type: true,
	code: true,
	error: ERROR,
	response: {
		model: true,
		error: ERROR,
		usage: {
			input_tokens: true,
			output_tokens: true,
			cost: true,
			is_byok: true,
			input_tokens_details: {
				cached_tokens: true,
				cache_write_tokens: true,
				cache_creation_input_tokens: true,
			},
		},
	},
};

type Phase =
	| "keyOrEnd"
	| "key"
	| "colon"
	| "valueOrEnd"
	| "value"
	| "commaOrEnd";
interface Frame {
	kind: "object" | "array";
	phase: Phase;
	selection: Selection | undefined;
	value: Record<string, unknown> | undefined;
	key?: string;
}
type NumberPhase =
	| "sign"
	| "zero"
	| "integer"
	| "dot"
	| "fraction"
	| "exponent"
	| "exponentSign"
	| "exponentDigits";
export type NativeJsonError =
	| "native_responses_parse_error"
	| "native_responses_parse_limit";

export class NativeTerminalJson {
	error: NativeJsonError | null = null;
	private stack: Frame[] = [];
	private result: unknown;
	private complete = false;
	private token: "string" | "number" | "literal" | null = null;
	private raw = "";
	private retain = false;
	private keyToken = false;
	private oversizedKey = false;
	private escape = false;
	private unicodeLeft = 0;
	private literal = "";
	private literalIndex = 0;
	private numberPhase: NumberPhase = "integer";
	private retained = 0;

	/** Upper bound on retained JSON text, excluding fixed parser bookkeeping. */
	get retainedCharacters(): number {
		return (
			this.retained +
			this.raw.length +
			this.stack.reduce((n, frame) => n + (frame.key?.length ?? 0), 0)
		);
	}

	private fail(limit = false): void {
		this.error ??= limit
			? "native_responses_parse_limit"
			: "native_responses_parse_error";
		this.stack = [];
		this.raw = "";
		this.result = undefined;
	}
	private selection(): Selection | true | undefined {
		const frame = this.stack.at(-1);
		if (!frame) return FIELDS;
		return frame.kind === "object" &&
			frame.key !== undefined &&
			frame.selection &&
			Object.hasOwn(frame.selection, frame.key)
			? frame.selection[frame.key]
			: undefined;
	}
	private finishValue(value: unknown): void {
		const frame = this.stack.at(-1);
		if (!frame) {
			this.result = value;
			this.complete = true;
		} else {
			if (frame.value && frame.key !== undefined && this.selection())
				frame.value[frame.key] = value;
			frame.key = undefined;
			frame.phase = "commaOrEnd";
		}
	}
	private append(char: string): void {
		if (!this.retain) return;
		this.raw += char;
		if (this.keyToken && this.raw.length > 1024) {
			this.oversizedKey = true;
			this.raw = "";
			this.retain = false;
		} else if (
			this.raw.length > 4096 ||
			(!this.keyToken && ++this.retained > 65536)
		)
			this.fail(true);
	}
	private finishToken(): void {
		if (this.token === "string" && this.keyToken) {
			const frame = this.stack.at(-1);
			if (!frame) {
				this.fail();
				return;
			}
			frame.key = this.oversizedKey ? undefined : JSON.parse(this.raw);
			frame.phase = "colon";
		} else {
			const value =
				this.token === "literal"
					? JSON.parse(this.literal)
					: this.retain
						? JSON.parse(this.raw)
						: undefined;
			this.finishValue(value);
		}
		this.token = null;
		this.raw = "";
	}
	private startString(key: boolean): void {
		this.token = "string";
		this.keyToken = key;
		this.oversizedKey = false;
		this.retain = key
			? this.stack.at(-1)?.selection !== undefined
			: this.selection() !== undefined;
		this.oversizedKey = key && !this.retain;
		this.raw = this.retain ? '"' : "";
		this.escape = false;
		this.unicodeLeft = 0;
	}

	feed(text: string): void {
		for (let i = 0; i < text.length && !this.error; i++) {
			const char = text[i];
			if (this.token === "string") {
				this.append(char);
				if (this.error) break;
				if (this.unicodeLeft) {
					if (!/[0-9a-fA-F]/.test(char)) this.fail();
					this.unicodeLeft--;
				} else if (this.escape) {
					this.escape = false;
					if (char === "u") this.unicodeLeft = 4;
					else if (!'"\\/bfnrt'.includes(char)) this.fail();
				} else if (char === "\\") this.escape = true;
				else if (char === '"') this.finishToken();
				else if (char.charCodeAt(0) < 32) this.fail();
				continue;
			}
			if (this.token === "literal") {
				if (char !== this.literal[this.literalIndex++]) this.fail();
				else if (this.literalIndex === this.literal.length) this.finishToken();
				continue;
			}
			if (this.token === "number") {
				const digit = char >= "0" && char <= "9";
				let next: NumberPhase | undefined;
				switch (this.numberPhase) {
					case "sign":
						if (digit) next = char === "0" ? "zero" : "integer";
						break;
					case "zero":
					case "integer":
						if (digit && this.numberPhase === "integer") next = "integer";
						else if (char === ".") next = "dot";
						else if (char === "e" || char === "E") next = "exponent";
						break;
					case "dot":
						if (digit) next = "fraction";
						break;
					case "fraction":
						if (digit) next = "fraction";
						else if (char === "e" || char === "E") next = "exponent";
						break;
					case "exponent":
						if (char === "+" || char === "-") next = "exponentSign";
						else if (digit) next = "exponentDigits";
						break;
					case "exponentSign":
					case "exponentDigits":
						if (digit) next = "exponentDigits";
						break;
				}
				if (next) {
					this.numberPhase = next;
					this.append(char);
					continue;
				}
				if (!this.numberCanEnd() || digit) {
					this.fail();
					continue;
				}
				this.finishToken();
			}
			if (char === " " || char === "\t" || char === "\r" || char === "\n")
				continue;
			if (this.complete) {
				this.fail();
				continue;
			}
			const frame = this.stack.at(-1);
			if (!frame && char !== "{") {
				this.fail();
				continue;
			}
			if (frame) {
				if (
					(char === "}" &&
						frame.kind === "object" &&
						(frame.phase === "keyOrEnd" || frame.phase === "commaOrEnd")) ||
					(char === "]" &&
						frame.kind === "array" &&
						(frame.phase === "valueOrEnd" || frame.phase === "commaOrEnd"))
				) {
					this.stack.pop();
					this.finishValue(frame.value);
					continue;
				}
				if (frame.phase === "keyOrEnd" || frame.phase === "key") {
					if (char !== '"') this.fail();
					else this.startString(true);
					continue;
				}
				if (frame.phase === "colon") {
					if (char !== ":") this.fail();
					else frame.phase = "value";
					continue;
				}
				if (frame.phase === "commaOrEnd") {
					if (char !== ",") this.fail();
					else frame.phase = frame.kind === "object" ? "key" : "value";
					continue;
				}
			}
			if (char === "{" || char === "[") {
				if (this.stack.length >= 64) {
					this.fail(true);
					continue;
				}
				const selection = this.selection();
				this.stack.push({
					kind: char === "{" ? "object" : "array",
					phase: char === "{" ? "keyOrEnd" : "valueOrEnd",
					selection:
						char === "{" && typeof selection === "object"
							? selection
							: undefined,
					value: selection ? Object.create(null) : undefined,
				});
			} else if (char === '"') this.startString(false);
			else if (char === "t" || char === "f" || char === "n") {
				this.token = "literal";
				this.literal = char === "t" ? "true" : char === "f" ? "false" : "null";
				this.literalIndex = 1;
			} else if (char === "-" || (char >= "0" && char <= "9")) {
				this.token = "number";
				this.keyToken = false;
				this.retain = this.selection() !== undefined;
				this.raw = this.retain ? char : "";
				this.numberPhase =
					char === "-" ? "sign" : char === "0" ? "zero" : "integer";
			} else this.fail();
		}
	}
	private numberCanEnd(): boolean {
		return ["zero", "integer", "fraction", "exponentDigits"].includes(
			this.numberPhase,
		);
	}
	finish(): Record<string, unknown> | undefined {
		if (this.error) return undefined;
		if (this.token === "number" && this.numberCanEnd()) this.finishToken();
		if (
			this.token ||
			this.stack.length ||
			!this.complete ||
			!this.result ||
			typeof this.result !== "object"
		)
			this.fail();
		return this.error ? undefined : (this.result as Record<string, unknown>);
	}
}
