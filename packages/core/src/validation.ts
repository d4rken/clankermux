/**
 * Input validation and sanitization utilities
 */
import { ValidationError } from "./errors";

/**
 * Validates and sanitizes a string input
 */
export function validateString(
	value: unknown,
	field: string,
	options: {
		required?: boolean;
		minLength?: number;
		maxLength?: number;
		pattern?: RegExp;
		patternErrorMessage?: string;
		allowedValues?: readonly string[];
		transform?: (value: string) => string;
	} = {},
): string | undefined {
	// Handle undefined/null
	if (value === undefined || value === null) {
		if (options.required) {
			throw new ValidationError(`${field} is required`, field);
		}
		return undefined;
	}

	// Ensure it's a string
	if (typeof value !== "string") {
		throw new ValidationError(`${field} must be a string`, field, value);
	}

	// Apply transformation if provided
	const sanitized = options.transform ? options.transform(value) : value;

	// Validate length
	if (options.minLength !== undefined && sanitized.length < options.minLength) {
		throw new ValidationError(
			`${field} must be at least ${options.minLength} characters long`,
			field,
			value,
		);
	}

	if (options.maxLength !== undefined && sanitized.length > options.maxLength) {
		throw new ValidationError(
			`${field} must be at most ${options.maxLength} characters long`,
			field,
			value,
		);
	}

	// Validate pattern
	if (options.pattern && !options.pattern.test(sanitized)) {
		const errorMessage = options.patternErrorMessage
			? `${field} ${options.patternErrorMessage}`
			: `${field} has an invalid format`;
		throw new ValidationError(errorMessage, field, value);
	}

	// Validate allowed values
	if (options.allowedValues && !options.allowedValues.includes(sanitized)) {
		throw new ValidationError(
			`${field} must be one of: ${options.allowedValues.join(", ")}`,
			field,
			value,
		);
	}

	return sanitized;
}

/**
 * Validates and sanitizes a number input
 */
export function validateNumber(
	value: unknown,
	field: string,
	options: {
		required?: boolean;
		min?: number;
		max?: number;
		integer?: boolean;
		allowedValues?: readonly number[];
	} = {},
): number | undefined {
	// Handle undefined/null
	if (value === undefined || value === null) {
		if (options.required) {
			throw new ValidationError(`${field} is required`, field);
		}
		return undefined;
	}

	// Convert string to number if needed
	let num: number;
	if (typeof value === "string") {
		num = Number(value);
		if (Number.isNaN(num)) {
			throw new ValidationError(
				`${field} must be a valid number`,
				field,
				value,
			);
		}
	} else if (typeof value === "number") {
		num = value;
	} else {
		throw new ValidationError(`${field} must be a number`, field, value);
	}

	// Validate integer
	if (options.integer && !Number.isInteger(num)) {
		throw new ValidationError(`${field} must be an integer`, field, value);
	}

	// Validate range
	if (options.min !== undefined && num < options.min) {
		throw new ValidationError(
			`${field} must be at least ${options.min}`,
			field,
			value,
		);
	}

	if (options.max !== undefined && num > options.max) {
		throw new ValidationError(
			`${field} must be at most ${options.max}`,
			field,
			value,
		);
	}

	// Validate allowed values
	if (options.allowedValues && !options.allowedValues.includes(num)) {
		throw new ValidationError(
			`${field} must be one of: ${options.allowedValues.join(", ")}`,
			field,
			value,
		);
	}

	return num;
}

/**
 * Common string sanitizers
 */
export const sanitizers = {
	trim: (value: string) => value.trim(),
	lowercase: (value: string) => value.toLowerCase(),
	uppercase: (value: string) => value.toUpperCase(),
	removeWhitespace: (value: string) => value.replace(/\s+/g, ""),
	alphanumeric: (value: string) => value.replace(/[^a-zA-Z0-9]/g, ""),
	alphanumericWithSpaces: (value: string) =>
		value.replace(/[^a-zA-Z0-9\s]/g, ""),
	email: (value: string) => value.trim().toLowerCase(),
	url: (value: string) => {
		try {
			const parsed = new URL(value);
			return parsed.toString();
		} catch {
			throw new ValidationError("Invalid URL format", "url", value);
		}
	},
};

/**
 * Common validation patterns
 */
export const patterns = {
	email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
	uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
	alphanumeric: /^[a-zA-Z0-9]+$/,
	alphanumericWithSpaces: /^[a-zA-Z0-9\s]+$/,
	// Account name: alphanumeric with spaces, hyphens, and underscores
	// Spaces are allowed for better UX - CLI command suggestions will quote names properly
	accountName: /^[a-zA-Z0-9\s\-_.]+$/,
	// Path pattern for API endpoints
	apiPath: /^\/v1\/[a-zA-Z0-9\-_/]*$/,
	// URL pattern
	url: /^https?:\/\/.+$/i,
};

/**
 * Validate and sanitize a URL endpoint
 */
export function validateEndpointUrl(url: unknown, field = "endpoint"): string {
	const urlStr = validateString(url, field, {
		required: true,
		pattern: patterns.url,
		transform: (value) => value.trim().replace(/\/$/, ""), // Remove trailing slash
	});

	if (!urlStr) {
		throw new ValidationError(`${field} is required`, field);
	}

	try {
		const parsed = new URL(urlStr);

		// Validate protocol
		if (!["http:", "https:"].includes(parsed.protocol)) {
			throw new ValidationError(
				`${field} protocol must be http or https`,
				field,
				url,
			);
		}

		// Validate hostname exists
		if (!parsed.hostname) {
			throw new ValidationError(
				`${field} must have a valid hostname`,
				field,
				url,
			);
		}

		return urlStr;
	} catch (error) {
		if (error instanceof ValidationError) {
			throw error;
		}
		throw new ValidationError(
			`${field} has invalid URL format: ${error instanceof Error ? error.message : String(error)}`,
			field,
			url,
		);
	}
}

/**
 * Validate API key format (basic check)
 */
export function validateApiKey(apiKey: unknown, field = "apiKey"): string {
	const key = validateString(apiKey, field, {
		required: true,
		minLength: 10,
		transform: (value) => value.trim(),
	});

	if (!key) {
		throw new ValidationError(`${field} is required`, field);
	}

	return key;
}

/**
 * Safely parse JSON with error handling and validation
 */
export function safeJsonParse<T = unknown>(json: unknown, field = "json"): T {
	if (typeof json !== "string") {
		throw new ValidationError(`${field} must be a string`, field, json);
	}

	const trimmed = json.trim();
	if (!trimmed) {
		throw new ValidationError(`${field} cannot be empty`, field, json);
	}

	try {
		return JSON.parse(trimmed) as T;
	} catch (error) {
		throw new ValidationError(
			`${field} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
			field,
			json,
		);
	}
}

/**
 * Validate account priority (0-100)
 */
export function validatePriority(
	priority: unknown,
	field = "priority",
): number {
	return (
		validateNumber(priority, field, {
			min: 0,
			max: 100,
			integer: true,
		}) ?? 0
	); // Default to 0 if undefined
}
