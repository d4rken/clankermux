import { HttpError, parseHttpError } from "@clankermux/errors";

export interface RequestOptions extends RequestInit {
	timeout?: number;
	retries?: number;
	retryDelay?: number;
	baseUrl?: string;
}

export interface ClientOptions {
	baseUrl?: string;
	defaultHeaders?: HeadersInit;
	timeout?: number;
	retries?: number;
	retryDelay?: number;
	/**
	 * Called whenever the server answers 401, BEFORE the error is thrown.
	 *
	 * A dashboard cannot recover from this at the call site: the session either
	 * expired or was revoked, and every other in-flight and future request will
	 * fail the same way. Each caller catching its own 401 would produce a page
	 * of unrelated error toasts instead of the one thing that helps, which is
	 * showing the login screen. This hook is how the app learns, once, that it
	 * is signed out. It must not throw — a listener failure is swallowed so it
	 * cannot turn an auth failure into an unrelated one.
	 */
	onUnauthorized?: (url: string) => void;
}

/**
 * Base HTTP client with common functionality
 */
export class HttpClient {
	private options: Required<ClientOptions>;

	constructor(options: ClientOptions = {}) {
		this.options = {
			baseUrl: options.baseUrl || "",
			defaultHeaders: options.defaultHeaders || {},
			timeout: options.timeout || 30000,
			retries: options.retries || 0,
			retryDelay: options.retryDelay || 1000,
			onUnauthorized: options.onUnauthorized ?? (() => {}),
		};
	}

	/**
	 * Make an HTTP request with retries and timeout
	 */
	async request<T = unknown>(
		url: string,
		options: RequestOptions = {},
	): Promise<T> {
		const {
			timeout = this.options.timeout,
			retries = this.options.retries,
			retryDelay = this.options.retryDelay,
			baseUrl = this.options.baseUrl,
			...fetchOptions
		} = options;

		const fullUrl = baseUrl ? new URL(url, baseUrl).toString() : url;
		const headers = {
			...this.options.defaultHeaders,
			...fetchOptions.headers,
		};

		let lastError: Error | null = null;

		for (let attempt = 0; attempt <= retries; attempt++) {
			let timeoutId: Timer | undefined;
			try {
				const controller = new AbortController();
				timeoutId = setTimeout(() => controller.abort(), timeout);

				const response = await fetch(fullUrl, {
					...fetchOptions,
					headers,
					signal: controller.signal,
				});

				clearTimeout(timeoutId);
				timeoutId = undefined;

				if (!response.ok) {
					if (response.status === 401) {
						// Announced BEFORE the throw, so the app switches to the login
						// screen even for a caller that swallows the error. A throwing
						// listener must not become the error this request reports.
						try {
							this.options.onUnauthorized(fullUrl);
						} catch {
							// Best-effort notification only.
						}
					}
					const error = await parseHttpError(response);
					throw error;
				}

				const contentType = response.headers.get("content-type");
				if (contentType?.includes("application/json")) {
					return await response.json();
				}

				return (await response.text()) as T;
			} catch (error) {
				// Ensure timeout is cleared on error
				if (timeoutId !== undefined) {
					clearTimeout(timeoutId);
				}

				lastError = error as Error;

				// The server answered — replaying the exact same request cannot
				// change that answer, and a second round trip is not free: a 503
				// from the dashboard's worker lanes means the request queued and
				// burned a soft deadline, so retrying it doubles the load that
				// produced the 503. Retries here exist for TRANSPORT failures
				// only (connection reset, DNS, TLS); response-level retry policy
				// for dashboard reads lives in React Query.
				if (error instanceof HttpError) {
					throw error;
				}

				// Don't retry on abort
				if (error instanceof Error && error.name === "AbortError") {
					throw new HttpError(408, "Request timeout");
				}

				// Retry if we have attempts left
				if (attempt < retries) {
					await this.delay(retryDelay * (attempt + 1));
				}
			}
		}

		throw lastError || new Error("Unknown error");
	}

	/**
	 * Convenience methods
	 */
	get<T = unknown>(url: string, options?: RequestOptions): Promise<T> {
		return this.request<T>(url, { ...options, method: "GET" });
	}

	post<T = unknown>(
		url: string,
		body?: unknown,
		options?: RequestOptions,
	): Promise<T> {
		return this.request<T>(url, {
			...options,
			method: "POST",
			body: body ? JSON.stringify(body) : undefined,
			headers: {
				"Content-Type": "application/json",
				...options?.headers,
			},
		});
	}

	put<T = unknown>(
		url: string,
		body?: unknown,
		options?: RequestOptions,
	): Promise<T> {
		return this.request<T>(url, {
			...options,
			method: "PUT",
			body: body ? JSON.stringify(body) : undefined,
			headers: {
				"Content-Type": "application/json",
				...options?.headers,
			},
		});
	}

	patch<T = unknown>(
		url: string,
		body?: unknown,
		options?: RequestOptions,
	): Promise<T> {
		return this.request<T>(url, {
			...options,
			method: "PATCH",
			body: body ? JSON.stringify(body) : undefined,
			headers: {
				"Content-Type": "application/json",
				...options?.headers,
			},
		});
	}

	delete<T = unknown>(url: string, options?: RequestOptions): Promise<T> {
		return this.request<T>(url, { ...options, method: "DELETE" });
	}

	/**
	 * Delay helper for retries
	 */
	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
