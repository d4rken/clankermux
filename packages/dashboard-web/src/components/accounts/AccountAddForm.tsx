import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { runGuarded } from "../../lib/submit-guard";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import { AuthorizationHandoff } from "./AuthorizationHandoff";
import { DevinAccountFields } from "./DevinAccountFields";
import { ModelMappingFields } from "./ModelMappingFields";
import { OpenAIModelMappings } from "./OpenAIModelMappings";

interface AccountAddFormProps {
	onAddAccount: (params: {
		name: string;
		mode:
			| "claude-oauth"
			| "console"
			| "zai"
			| "minimax"
			| "anthropic-compatible"
			| "openai-compatible"
			| "kilo"
			| "openrouter"
			| "alibaba-coding-plan"
			| "codex"
			| "qwen"
			| "ollama";
		priority: number;
		customEndpoint?: string;
	}) => Promise<{ authUrl: string; sessionId: string }>;
	onCompleteAccount: (params: {
		sessionId: string;
		code: string;
	}) => Promise<void>;
	onAddZaiAccount: (params: {
		name: string;
		apiKey: string;
		priority: number;
		customEndpoint?: string;
		modelMappings?: { [key: string]: string };
	}) => Promise<void>;
	onAddMinimaxAccount: (params: {
		name: string;
		apiKey: string;
		priority: number;
	}) => Promise<void>;
	onAddAnthropicCompatibleAccount: (params: {
		name: string;
		apiKey: string;
		priority: number;
		customEndpoint?: string;
		modelMappings?: { [key: string]: string };
	}) => Promise<void>;
	onAddOpenAIAccount: (params: {
		name: string;
		apiKey: string;
		priority: number;
		customEndpoint: string;
		modelMappings?: { [key: string]: string };
	}) => Promise<void>;
	onAddAlibabaCodingPlanAccount: (params: {
		name: string;
		apiKey: string;
		priority: number;
		modelMappings?: { [key: string]: string };
	}) => Promise<void>;
	onAddKiloAccount: (params: {
		name: string;
		apiKey: string;
		priority: number;
		modelMappings?: { [key: string]: string };
	}) => Promise<void>;
	onAddDevinAccount?: (params: {
		name: string;
		apiKey: string;
		priority: number;
		modelMappings?: Record<string, string>;
	}) => Promise<void>;
	onAddOpenRouterAccount: (params: {
		name: string;
		apiKey: string;
		priority: number;
		modelMappings?: { [key: string]: string };
	}) => Promise<void>;
	onAddOllamaAccount: (params: {
		name: string;
		priority: number;
		customEndpoint?: string;
		modelMappings?: { [key: string]: string };
	}) => Promise<void>;
	onAddOllamaCloudAccount: (params: {
		name: string;
		apiKey: string;
		priority: number;
		modelMappings?: { [key: string]: string };
	}) => Promise<void>;
	onCancel: () => void;
	onSuccess: () => void;
	onError: (error: string) => void;
}

export function AccountAddForm({
	onAddAccount,
	onCompleteAccount,
	onAddZaiAccount,
	onAddMinimaxAccount,
	onAddAnthropicCompatibleAccount,
	onAddOpenAIAccount,
	onAddAlibabaCodingPlanAccount,
	onAddKiloAccount,
	onAddOpenRouterAccount,
	onAddDevinAccount,
	onAddOllamaAccount,
	onAddOllamaCloudAccount,
	onCancel,
	onSuccess,
	onError,
}: AccountAddFormProps) {
	const [authStep, setAuthStep] = useState<"form" | "code">("form");
	const [authCode, setAuthCode] = useState("");
	const [sessionId, setSessionId] = useState("");
	/**
	 * The code step renders the authorization URL as a link with a copy button,
	 * and nothing is opened automatically: the URL usually has to be carried to
	 * another browser — the one signed in to the account being added — so an
	 * auto-opened tab would land in the wrong one (and a popup blocker could eat
	 * it anyway).
	 */
	const [authUrl, setAuthUrl] = useState("");
	const [newAccount, setNewAccount] = useState({
		name: "",
		mode: "claude-oauth" as
			| "claude-oauth"
			| "console"
			| "zai"
			| "minimax"
			| "anthropic-compatible"
			| "openai-compatible"
			| "kilo"
			| "openrouter"
			| "alibaba-coding-plan"
			| "codex"
			| "qwen"
			| "ollama"
			| "ollama-cloud"
			| "devin",
		priority: 0,
		apiKey: "",
		customEndpoint: "",
		projectId: "",
		region: "global",
		profile: "",
		awsRegion: "",
		opusModel: "",
		sonnetModel: "",
		haikuModel: "",
	});

	const updateAccountSource = (
		changes: Partial<
			Pick<typeof newAccount, "apiKey" | "customEndpoint" | "mode">
		>,
	) => {
		setNewAccount((prev) => {
			const changed = Object.entries(changes).some(
				([key, value]) => prev[key as keyof typeof changes] !== value,
			);
			// Rule 1: every mode switch starts from a clean source. Each mode
			// renders its own subset of the source fields, so a value typed under
			// the previous mode may be invisible (and therefore uneditable) under
			// the new one while still being submitted with it, and credentials
			// meant for one provider must never reach another.
			const switchedMode =
				changes.mode !== undefined && changes.mode !== prev.mode;
			// Rule 2: openai-compatible model mappings are discovered against a
			// specific endpoint and key, so editing either of those *within* the
			// mode invalidates them too, not just leaving or entering the mode.
			const staleModelMappings =
				changed &&
				(prev.mode === "openai-compatible" ||
					changes.mode === "openai-compatible");
			return {
				...prev,
				...changes,
				...(switchedMode ? { customEndpoint: "", apiKey: "" } : {}),
				...(switchedMode || staleModelMappings
					? { opusModel: "", sonnetModel: "", haikuModel: "" }
					: {}),
			};
		});
	};

	// Qwen device flow state
	const [qwenStep, setQwenStep] = useState<
		"idle" | "pending" | "complete" | "error"
	>("idle");
	const [qwenAuthUrl, setQwenAuthUrl] = useState("");
	const [qwenUserCode, setQwenUserCode] = useState("");
	const [qwenError, setQwenError] = useState("");
	const qwenSessionIdRef = useRef<string>("");
	const qwenPollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
		null,
	);

	// Codex device flow state
	const [codexStep, setCodexStep] = useState<
		"idle" | "pending" | "complete" | "error"
	>("idle");
	const [codexVerificationUrl, setCodexVerificationUrl] = useState("");
	const [codexUserCode, setCodexUserCode] = useState("");
	const [codexError, setCodexError] = useState("");
	const codexSessionIdRef = useRef<string>("");
	const codexPollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
		null,
	);

	// Cleanup Qwen polling on unmount
	useEffect(() => {
		return () => {
			if (qwenPollIntervalRef.current !== null) {
				clearInterval(qwenPollIntervalRef.current);
			}
		};
	}, []);

	// Cleanup Codex polling on unmount
	useEffect(() => {
		return () => {
			if (codexPollIntervalRef.current !== null) {
				clearInterval(codexPollIntervalRef.current);
			}
		};
	}, []);

	const validateCustomEndpoint = (endpoint: string): boolean => {
		if (!endpoint) return true; // Empty is fine (use default)
		try {
			new URL(endpoint);
			return true;
		} catch {
			return false;
		}
	};

	const stopQwenPolling = () => {
		if (qwenPollIntervalRef.current !== null) {
			clearInterval(qwenPollIntervalRef.current);
			qwenPollIntervalRef.current = null;
		}
	};

	/**
	 * Re-entrancy latch for every account-creation submit.
	 *
	 * A ref, NOT React state: state updates are not synchronous, so two clicks
	 * dispatched before the next render would BOTH observe `isSubmitting === false`
	 * and both fire — creating a duplicate account, or a duplicate device/OAuth
	 * session. The ref flips in the same tick as the click.
	 *
	 * The state mirror below exists ONLY so the buttons can render `disabled`; it
	 * is never the guard.
	 */
	const submittingRef = useRef(false);
	const [isSubmitting, setIsSubmitting] = useState(false);

	/** Run `submit` at most once at a time (see runGuarded). */
	const guardSubmit = (submit: () => Promise<void>): Promise<void> =>
		runGuarded(submittingRef, setIsSubmitting, submit);

	const stopCodexPolling = () => {
		if (codexPollIntervalRef.current !== null) {
			clearInterval(codexPollIntervalRef.current);
			codexPollIntervalRef.current = null;
		}
	};

	const handleStartQwenAuthInner = async () => {
		if (!newAccount.name) {
			onError("Account name is required");
			return;
		}
		setQwenStep("pending");
		setQwenError("");
		// The pending step is entered before the init call resolves, so clear the
		// previous attempt's link and code rather than showing stale ones.
		setQwenAuthUrl("");
		setQwenUserCode("");
		try {
			const result = await api.initQwenDeviceFlow({
				name: newAccount.name,
				priority: newAccount.priority,
			});
			qwenSessionIdRef.current = result.sessionId;
			setQwenAuthUrl(result.authUrl);
			setQwenUserCode(result.userCode);

			// Poll for status every 3s
			qwenPollIntervalRef.current = setInterval(async () => {
				try {
					const status = await api.getQwenAuthStatus(qwenSessionIdRef.current);
					if (status.status === "complete") {
						stopQwenPolling();
						setQwenStep("complete");
						setTimeout(() => {
							setQwenStep("idle");
							setQwenAuthUrl("");
							setQwenUserCode("");
							setNewAccount({
								name: "",
								mode: "claude-oauth",
								priority: 0,
								apiKey: "",
								customEndpoint: "",
								projectId: "",
								region: "global",
								profile: "",
								awsRegion: "",
								opusModel: "",
								sonnetModel: "",
								haikuModel: "",
							});
							onSuccess();
						}, 1500);
					} else if (status.status === "error") {
						stopQwenPolling();
						setQwenStep("error");
						setQwenError(status.error || "Authentication failed");
					}
				} catch {
					// Network error — keep polling
				}
			}, 3000);
		} catch (err) {
			setQwenStep("error");
			setQwenError(
				err instanceof Error ? err.message : "Failed to start authentication",
			);
		}
	};

	const handleStartCodexAuthInner = async () => {
		if (!newAccount.name) {
			onError("Account name is required");
			return;
		}
		setCodexStep("pending");
		setCodexError("");
		// The pending step is entered before the init call resolves, so clear the
		// previous attempt's link and code rather than showing stale ones.
		setCodexVerificationUrl("");
		setCodexUserCode("");
		try {
			const result = await api.initCodexDeviceFlow({
				name: newAccount.name,
				priority: newAccount.priority,
			});
			codexSessionIdRef.current = result.sessionId;
			setCodexVerificationUrl(result.verificationUrl);
			setCodexUserCode(result.userCode);

			// Poll for status every 3s
			codexPollIntervalRef.current = setInterval(async () => {
				try {
					const status = await api.getCodexAuthStatus(
						codexSessionIdRef.current,
					);
					if (status.status === "complete") {
						stopCodexPolling();
						setCodexStep("complete");
						setTimeout(() => {
							setCodexStep("idle");
							setCodexVerificationUrl("");
							setCodexUserCode("");
							setNewAccount({
								name: "",
								mode: "claude-oauth",
								priority: 0,
								apiKey: "",
								customEndpoint: "",
								projectId: "",
								region: "global",
								profile: "",
								awsRegion: "",
								opusModel: "",
								sonnetModel: "",
								haikuModel: "",
							});
							onSuccess();
						}, 1500);
					} else if (status.status === "error") {
						stopCodexPolling();
						setCodexStep("error");
						setCodexError(status.error || "Authentication failed");
					}
				} catch {
					// Network error — keep polling
				}
			}, 3000);
		} catch (err) {
			setCodexStep("error");
			setCodexError(
				err instanceof Error ? err.message : "Failed to start authentication",
			);
		}
	};

	const handleAddAccountInner = async () => {
		if (!newAccount.name) {
			onError("Account name is required");
			return;
		}

		// Validate custom endpoint if provided
		if (
			newAccount.customEndpoint &&
			!validateCustomEndpoint(newAccount.customEndpoint)
		) {
			onError(
				"Custom endpoint must be a valid URL (e.g., https://api.anthropic.com)",
			);
			return;
		}

		const accountParams = {
			name: newAccount.name,
			mode: newAccount.mode as
				| "claude-oauth"
				| "console"
				| "zai"
				| "minimax"
				| "anthropic-compatible"
				| "openai-compatible"
				| "kilo"
				| "openrouter"
				| "alibaba-coding-plan",
			priority: newAccount.priority,
			...(newAccount.customEndpoint && {
				customEndpoint: newAccount.customEndpoint.trim(),
			}),
		};

		if (newAccount.mode === "devin") {
			if (!newAccount.apiKey.trim()) {
				onError(
					"Devin session token is required; sign in with Devin or import one",
				);
				return;
			}
			const modelMappings: Record<string, string> = {};
			if (newAccount.opusModel) modelMappings.opus = newAccount.opusModel;
			if (newAccount.sonnetModel) modelMappings.sonnet = newAccount.sonnetModel;
			if (newAccount.haikuModel) modelMappings.haiku = newAccount.haikuModel;
			const params = {
				name: newAccount.name,
				apiKey: newAccount.apiKey.trim(),
				priority: newAccount.priority,
				...(Object.keys(modelMappings).length ? { modelMappings } : {}),
			};
			if (onAddDevinAccount) await onAddDevinAccount(params);
			else await api.addDevinAccount(params);
			setNewAccount((prev) => ({ ...prev, apiKey: "" }));
			onSuccess();
			return;
		}
		if (newAccount.mode === "zai") {
			if (!newAccount.apiKey) {
				onError("API key is required for z.ai accounts");
				return;
			}
			// Build model mappings from form fields
			const zaiModelMappings: { [key: string]: string } = {};
			if (newAccount.opusModel) zaiModelMappings.opus = newAccount.opusModel;
			if (newAccount.sonnetModel)
				zaiModelMappings.sonnet = newAccount.sonnetModel;
			if (newAccount.haikuModel) zaiModelMappings.haiku = newAccount.haikuModel;
			// For z.ai accounts, we don't need OAuth flow
			await onAddZaiAccount({
				...accountParams,
				apiKey: newAccount.apiKey,
				...(newAccount.customEndpoint && {
					customEndpoint: newAccount.customEndpoint.trim(),
				}),
				...(Object.keys(zaiModelMappings).length > 0 && {
					modelMappings: zaiModelMappings,
				}),
			});
			// Reset form and signal success
			setNewAccount({
				name: "",
				mode: "claude-oauth",
				priority: 0,
				apiKey: "",
				customEndpoint: "",
				projectId: "",
				region: "global",
				profile: "",
				awsRegion: "",
				opusModel: "",
				sonnetModel: "",
				haikuModel: "",
			});
			onSuccess();
			return;
		}

		if (newAccount.mode === "minimax") {
			if (!newAccount.apiKey) {
				onError("API key is required for Minimax accounts");
				return;
			}
			// For Minimax accounts, we don't need OAuth flow and use default tier
			await onAddMinimaxAccount({
				name: newAccount.name,
				apiKey: newAccount.apiKey,
				priority: newAccount.priority,
			});
			// Reset form and signal success
			setNewAccount({
				name: "",
				mode: "claude-oauth",
				priority: 0,
				apiKey: "",
				customEndpoint: "",
				projectId: "",
				region: "global",
				profile: "",
				awsRegion: "",
				opusModel: "",
				sonnetModel: "",
				haikuModel: "",
			});
			onSuccess();
			return;
		}

		if (newAccount.mode === "kilo") {
			if (!newAccount.apiKey) {
				onError("API key is required for Kilo Gateway accounts");
				return;
			}
			const kiloModelMappings: { [key: string]: string } = {};
			if (newAccount.opusModel) kiloModelMappings.opus = newAccount.opusModel;
			if (newAccount.sonnetModel)
				kiloModelMappings.sonnet = newAccount.sonnetModel;
			if (newAccount.haikuModel)
				kiloModelMappings.haiku = newAccount.haikuModel;
			await onAddKiloAccount({
				name: newAccount.name,
				apiKey: newAccount.apiKey,
				priority: newAccount.priority,
				modelMappings:
					Object.keys(kiloModelMappings).length > 0
						? kiloModelMappings
						: undefined,
			});
			setNewAccount({
				name: "",
				mode: "claude-oauth",
				priority: 0,
				apiKey: "",
				customEndpoint: "",
				projectId: "",
				region: "global",
				profile: "",
				awsRegion: "",
				opusModel: "",
				sonnetModel: "",
				haikuModel: "",
			});
			onSuccess();
			return;
		}

		if (newAccount.mode === "alibaba-coding-plan") {
			if (!newAccount.apiKey) {
				onError("API key is required for Alibaba Coding Plan accounts");
				return;
			}
			const modelMappings: { [key: string]: string } = {};
			if (newAccount.opusModel) modelMappings.opus = newAccount.opusModel;
			if (newAccount.sonnetModel) modelMappings.sonnet = newAccount.sonnetModel;
			if (newAccount.haikuModel) modelMappings.haiku = newAccount.haikuModel;
			await onAddAlibabaCodingPlanAccount({
				name: newAccount.name,
				apiKey: newAccount.apiKey,
				priority: newAccount.priority,
				modelMappings:
					Object.keys(modelMappings).length > 0 ? modelMappings : undefined,
			});
			setNewAccount({
				name: "",
				mode: "claude-oauth",
				priority: 0,
				apiKey: "",
				customEndpoint: "",
				projectId: "",
				region: "global",
				profile: "",
				awsRegion: "",
				opusModel: "",
				sonnetModel: "",
				haikuModel: "",
			});
			onSuccess();
			return;
		}

		if (newAccount.mode === "openrouter") {
			if (!newAccount.apiKey) {
				onError("API key is required for OpenRouter accounts");
				return;
			}
			const modelMappings: { [key: string]: string } = {};
			if (newAccount.opusModel) modelMappings.opus = newAccount.opusModel;
			if (newAccount.sonnetModel) modelMappings.sonnet = newAccount.sonnetModel;
			if (newAccount.haikuModel) modelMappings.haiku = newAccount.haikuModel;
			await onAddOpenRouterAccount({
				name: newAccount.name,
				apiKey: newAccount.apiKey,
				priority: newAccount.priority,
				modelMappings:
					Object.keys(modelMappings).length > 0 ? modelMappings : undefined,
			});
			setNewAccount({
				name: "",
				mode: "claude-oauth",
				priority: 0,
				apiKey: "",
				customEndpoint: "",
				projectId: "",
				region: "global",
				profile: "",
				awsRegion: "",
				opusModel: "",
				sonnetModel: "",
				haikuModel: "",
			});
			onSuccess();
			return;
		}

		if (newAccount.mode === "anthropic-compatible") {
			if (!newAccount.apiKey) {
				onError("API key is required for Anthropic-compatible accounts");
				return;
			}
			// Build model mappings object
			const modelMappings: { [key: string]: string } = {};
			if (newAccount.opusModel) modelMappings.opus = newAccount.opusModel;
			if (newAccount.sonnetModel) modelMappings.sonnet = newAccount.sonnetModel;
			if (newAccount.haikuModel) modelMappings.haiku = newAccount.haikuModel;

			// For Anthropic-compatible accounts, we don't need OAuth flow and use default tier
			await onAddAnthropicCompatibleAccount({
				name: newAccount.name,
				apiKey: newAccount.apiKey,
				priority: newAccount.priority,
				customEndpoint: newAccount.customEndpoint || undefined,
				modelMappings:
					Object.keys(modelMappings).length > 0 ? modelMappings : undefined,
			});
			// Reset form and signal success
			setNewAccount({
				name: "",
				mode: "claude-oauth",
				priority: 0,
				apiKey: "",
				customEndpoint: "",
				projectId: "",
				region: "global",
				profile: "",
				awsRegion: "",
				opusModel: "",
				sonnetModel: "",
				haikuModel: "",
			});
			onSuccess();
			return;
		}

		if (newAccount.mode === "openai-compatible") {
			if (!newAccount.apiKey) {
				onError("API key is required for OpenAI-compatible accounts");
				return;
			}
			if (!newAccount.customEndpoint) {
				onError("Endpoint URL is required for OpenAI-compatible accounts");
				return;
			}

			// Build model mappings object
			const modelMappings: { [key: string]: string } = {};
			if (newAccount.opusModel) modelMappings.opus = newAccount.opusModel;
			if (newAccount.sonnetModel) modelMappings.sonnet = newAccount.sonnetModel;
			if (newAccount.haikuModel) modelMappings.haiku = newAccount.haikuModel;

			// For OpenAI-compatible accounts, we don't need OAuth flow
			await onAddOpenAIAccount({
				name: newAccount.name,
				apiKey: newAccount.apiKey,
				priority: newAccount.priority,
				customEndpoint: newAccount.customEndpoint.trim(),
				modelMappings:
					Object.keys(modelMappings).length > 0 ? modelMappings : undefined,
			});

			// Reset form and signal success
			setNewAccount({
				name: "",
				mode: "claude-oauth",
				priority: 0,
				apiKey: "",
				customEndpoint: "",
				projectId: "",
				region: "global",
				profile: "",
				awsRegion: "",
				opusModel: "",
				sonnetModel: "",
				haikuModel: "",
			});
			onSuccess();
			return;
		}

		if (newAccount.mode === "ollama") {
			const modelMappings: { [key: string]: string } = {};
			if (newAccount.opusModel) modelMappings.opus = newAccount.opusModel;
			if (newAccount.sonnetModel) modelMappings.sonnet = newAccount.sonnetModel;
			if (newAccount.haikuModel) modelMappings.haiku = newAccount.haikuModel;

			await onAddOllamaAccount({
				name: newAccount.name,
				priority: newAccount.priority,
				customEndpoint: newAccount.customEndpoint || undefined,
				modelMappings:
					Object.keys(modelMappings).length > 0 ? modelMappings : undefined,
			});
			setNewAccount({
				name: "",
				mode: "claude-oauth",
				priority: 0,
				apiKey: "",
				customEndpoint: "",
				projectId: "",
				region: "global",
				profile: "",
				awsRegion: "",
				opusModel: "",
				sonnetModel: "",
				haikuModel: "",
			});
			onSuccess();
			return;
		}

		if (newAccount.mode === "ollama-cloud") {
			if (!newAccount.apiKey) {
				onError("API key is required for Ollama Cloud");
				return;
			}
			const modelMappings: { [key: string]: string } = {};
			if (newAccount.opusModel) modelMappings.opus = newAccount.opusModel;
			if (newAccount.sonnetModel) modelMappings.sonnet = newAccount.sonnetModel;
			if (newAccount.haikuModel) modelMappings.haiku = newAccount.haikuModel;

			await onAddOllamaCloudAccount({
				name: newAccount.name,
				apiKey: newAccount.apiKey,
				priority: newAccount.priority,
				modelMappings:
					Object.keys(modelMappings).length > 0 ? modelMappings : undefined,
			});
			setNewAccount({
				name: "",
				mode: "claude-oauth",
				priority: 0,
				apiKey: "",
				customEndpoint: "",
				projectId: "",
				region: "global",
				profile: "",
				awsRegion: "",
				opusModel: "",
				sonnetModel: "",
				haikuModel: "",
			});
			onSuccess();
			return;
		}

		// Step 1: Initialize OAuth flow for Max/Console accounts
		const result = await onAddAccount(accountParams);
		setSessionId(result.sessionId);
		setAuthUrl(result.authUrl);

		// Move to code entry step
		setAuthStep("code");
	};

	const handleCodeSubmitInner = async () => {
		const trimmedCode = authCode.trim();
		if (!trimmedCode) {
			onError("Authorization code is required");
			return;
		}
		// Step 2: Complete OAuth flow
		await onCompleteAccount({
			sessionId,
			code: trimmedCode,
		});

		// Success! Reset form
		setAuthStep("form");
		setAuthCode("");
		setSessionId("");
		setAuthUrl("");
		setNewAccount({
			name: "",
			mode: "claude-oauth",
			priority: 0,
			apiKey: "",
			customEndpoint: "",
			projectId: "",
			region: "global",
			profile: "",
			awsRegion: "",
			opusModel: "",
			sonnetModel: "",
			haikuModel: "",
		});
		onSuccess();
	};

	// Guarded entry points. Every account-creation submit goes through the same
	// latch — Qwen/Codex device-flow starts included, since a duplicate device
	// session is the same bug class as a duplicate account row.
	const handleStartQwenAuth = () => guardSubmit(handleStartQwenAuthInner);
	const handleStartCodexAuth = () => guardSubmit(handleStartCodexAuthInner);
	const handleAddAccount = () => guardSubmit(handleAddAccountInner);
	const handleCodeSubmit = () => guardSubmit(handleCodeSubmitInner);

	const handleCancel = () => {
		stopQwenPolling();
		setQwenStep("idle");
		setQwenAuthUrl("");
		setQwenUserCode("");
		setQwenError("");
		stopCodexPolling();
		setCodexStep("idle");
		setCodexVerificationUrl("");
		setCodexUserCode("");
		setCodexError("");
		setAuthStep("form");
		setAuthCode("");
		setSessionId("");
		setAuthUrl("");
		setNewAccount({
			name: "",
			mode: "claude-oauth",
			priority: 0,
			apiKey: "",
			customEndpoint: "",
			projectId: "",
			region: "global",
			profile: "",
			awsRegion: "",
			opusModel: "",
			sonnetModel: "",
			haikuModel: "",
		});
		onCancel();
	};

	return (
		<div className="space-y-group mb-section p-group border rounded-lg">
			{/* A panel heading playing the CardTitle role, so it needs
			    `.display-face` to pick up the theme's display face and its
			    --display-tracking. It stays an <h4> rather than becoming a
			    CardTitle: that would move it to <h3> and change the heading
			    outline of the page. */}
			<h4 className="display-face font-medium">
				{authStep === "form" ? "Add New Account" : "Enter Authorization Code"}
			</h4>
			{authStep === "form" && (
				<>
					<div className="space-y-item">
						<Label htmlFor="name">Account Name</Label>
						<Input
							id="name"
							value={newAccount.name}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
								setNewAccount({
									...newAccount,
									name: (e.target as HTMLInputElement).value,
								})
							}
							placeholder="e.g., work-account or user@example.com"
						/>
					</div>
					<div className="space-y-item">
						<Label htmlFor="mode">Mode</Label>
						<Select
							value={newAccount.mode}
							onValueChange={(
								value:
									| "claude-oauth"
									| "console"
									| "zai"
									| "minimax"
									| "anthropic-compatible"
									| "openai-compatible"
									| "kilo"
									| "openrouter"
									| "codex"
									| "qwen"
									| "ollama"
									| "ollama-cloud"
									| "devin",
							) => updateAccountSource({ mode: value })}
						>
							<SelectTrigger id="mode">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="claude-oauth">
									Claude CLI OAuth (Recommended)
								</SelectItem>
								<SelectItem value="console">Claude API</SelectItem>
								<SelectItem value="codex">Codex (OpenAI OAuth)</SelectItem>
								<SelectItem value="devin">
									Devin (SWE-2 subscription)
								</SelectItem>
								<SelectItem value="qwen">
									Qwen (Alibaba Cloud OAuth) — Experimental
								</SelectItem>
								<SelectItem value="zai">
									z.ai (API Key) — Experimental
								</SelectItem>
								<SelectItem value="minimax">
									Minimax (API Key) — Experimental
								</SelectItem>
								<SelectItem value="anthropic-compatible">
									Anthropic-Compatible (API Key) — Experimental
								</SelectItem>
								<SelectItem value="openai-compatible">
									OpenAI-Compatible (API Key) — Experimental
								</SelectItem>
								<SelectItem value="kilo">
									Kilo Gateway (API Key) — Experimental
								</SelectItem>
								<SelectItem value="openrouter">
									OpenRouter (API Key) — Experimental
								</SelectItem>
								<SelectItem value="alibaba-coding-plan">
									Alibaba Coding Plan International (API Key) — Experimental
								</SelectItem>
								<SelectItem value="ollama">
									Ollama (v0.14.0+, local) — Experimental
								</SelectItem>
								<SelectItem value="ollama-cloud">
									Ollama Cloud (ollama.com) — Experimental
								</SelectItem>
							</SelectContent>
						</Select>
					</div>
					{!["claude-oauth", "console", "codex"].includes(newAccount.mode) && (
						<Alert title="Experimental provider" tone="warning">
							This integration has not been validated by us with a live account.
							Authentication, usage tracking, and recovery may have issues.
						</Alert>
					)}
					{newAccount.mode === "devin" && (
						<DevinAccountFields
							name={newAccount.name}
							priority={newAccount.priority}
							token={newAccount.apiKey}
							onTokenChange={(value) => {
								updateAccountSource({ apiKey: value });
							}}
							onModelChange={(value) =>
								setNewAccount((prev) => ({
									...prev,
									opusModel: value,
									sonnetModel: value,
									haikuModel: value,
								}))
							}
							onSuccess={onSuccess}
							onError={onError}
						/>
					)}
					{newAccount.mode === "codex" && (
						<div className="space-y-row">
							{codexStep === "idle" && (
								<Alert title="Device Code Authentication">
									<p>
										Click the button below to start Codex authentication. You
										will get an authorization link and a user code to enter in
										your browser.
									</p>
								</Alert>
							)}
							{codexStep === "pending" && (
								<Alert title="Waiting for authorization...">
									{codexVerificationUrl ? (
										<>
											<p>Enter this code on the authorization page:</p>
											<AuthorizationHandoff
												url={codexVerificationUrl}
												userCode={codexUserCode}
											/>
										</>
									) : (
										<p>Requesting a device code…</p>
									)}
								</Alert>
							)}
							{codexStep === "complete" && (
								<Alert
									tone="success"
									title="Authorization successful! Account added."
								/>
							)}
							{codexStep === "error" && (
								<Alert tone="destructive" title="Authentication failed">
									<p>{codexError}</p>
									<Button
										variant="outline"
										size="sm"
										onClick={() => {
											setCodexStep("idle");
											setCodexError("");
										}}
									>
										Try again
									</Button>
								</Alert>
							)}
						</div>
					)}
					{newAccount.mode === "qwen" && (
						<div className="space-y-row">
							{qwenStep === "idle" && (
								<Alert title="Device Code Authentication">
									<p>
										Click the button below to start Qwen authentication. You
										will get an authorization link and a user code to enter in
										your browser.
									</p>
								</Alert>
							)}
							{qwenStep === "pending" && (
								<Alert title="Waiting for authorization...">
									{qwenAuthUrl ? (
										<>
											<p>Enter this code on the authorization page:</p>
											<AuthorizationHandoff
												url={qwenAuthUrl}
												userCode={qwenUserCode}
											/>
										</>
									) : (
										<p>Requesting a device code…</p>
									)}
								</Alert>
							)}
							{qwenStep === "complete" && (
								<Alert
									tone="success"
									title="Authorization successful! Account added."
								/>
							)}
							{qwenStep === "error" && (
								<Alert tone="destructive" title="Authentication failed">
									<p>{qwenError}</p>
									<Button
										variant="outline"
										size="sm"
										onClick={() => {
											setQwenStep("idle");
											setQwenError("");
										}}
									>
										Try again
									</Button>
								</Alert>
							)}
						</div>
					)}
					{newAccount.mode === "zai" && (
						<>
							<div className="space-y-item">
								<Label htmlFor="apiKey">z.ai API Key</Label>
								<Input
									id="apiKey"
									type="password"
									value={newAccount.apiKey}
									onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
										setNewAccount({
											...newAccount,
											apiKey: (e.target as HTMLInputElement).value,
										})
									}
									placeholder="Enter your z.ai API key"
								/>
							</div>
							<div className="space-y-item">
								<Label className="text-sm font-medium">
									Model Mappings (Optional)
								</Label>
								<p className="text-xs text-muted-foreground">
									Map Anthropic model names to z.ai-specific models. Leave empty
									to use Claude models directly.
								</p>
								<div className="space-y-item pl-group">
									<div>
										<Label htmlFor="opusModel" className="text-sm">
											Opus Model
										</Label>
										<Input
											id="opusModel"
											value={newAccount.opusModel}
											onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
												setNewAccount({
													...newAccount,
													opusModel: (e.target as HTMLInputElement).value,
												})
											}
											placeholder="e.g. glm-4.5-flash"
											className="mt-tight"
										/>
									</div>
									<div>
										<Label htmlFor="sonnetModel" className="text-sm">
											Sonnet Model
										</Label>
										<Input
											id="sonnetModel"
											value={newAccount.sonnetModel}
											onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
												setNewAccount({
													...newAccount,
													sonnetModel: (e.target as HTMLInputElement).value,
												})
											}
											placeholder="e.g. glm-4.5-flash"
											className="mt-tight"
										/>
									</div>
									<div>
										<Label htmlFor="haikuModel" className="text-sm">
											Haiku Model
										</Label>
										<Input
											id="haikuModel"
											value={newAccount.haikuModel}
											onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
												setNewAccount({
													...newAccount,
													haikuModel: (e.target as HTMLInputElement).value,
												})
											}
											placeholder="e.g. glm-4.5-air"
											className="mt-tight"
										/>
									</div>
								</div>
							</div>
						</>
					)}
					{newAccount.mode === "minimax" && (
						<div className="space-y-item">
							<Label htmlFor="apiKey">Minimax API Key</Label>
							<Input
								id="apiKey"
								type="password"
								value={newAccount.apiKey}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
									setNewAccount({
										...newAccount,
										apiKey: (e.target as HTMLInputElement).value,
									})
								}
								placeholder="Enter your Minimax API key"
							/>
						</div>
					)}
					{newAccount.mode === "anthropic-compatible" && (
						<>
							<div className="space-y-item">
								<Label htmlFor="apiKey">Anthropic-Compatible API Key</Label>
								<Input
									id="apiKey"
									type="password"
									value={newAccount.apiKey}
									onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
										setNewAccount({
											...newAccount,
											apiKey: (e.target as HTMLInputElement).value,
										})
									}
									placeholder="Enter your Anthropic-Compatible API key"
								/>
							</div>
							<div className="space-y-item">
								<Label htmlFor="customEndpoint">
									Custom Endpoint URL (Optional)
								</Label>
								<Input
									id="customEndpoint"
									type="url"
									value={newAccount.customEndpoint}
									onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
										setNewAccount({
											...newAccount,
											customEndpoint: (e.target as HTMLInputElement).value,
										})
									}
									placeholder="https://api.anthropic-compatible.com"
								/>
							</div>
							<div className="space-y-item">
								<Label>Model Mappings (Optional)</Label>
								<p className="text-xs text-muted-foreground mb-item">
									Map Anthropic model names to provider-specific models. Leave
									empty to use defaults.
								</p>
								<div className="space-y-item pl-group">
									<div>
										<Label htmlFor="opusModel" className="text-sm">
											Opus Model
										</Label>
										<Input
											id="opusModel"
											value={newAccount.opusModel}
											onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
												setNewAccount({
													...newAccount,
													opusModel: (e.target as HTMLInputElement).value,
												})
											}
											placeholder="claude-3-opus-20240229 (default)"
											className="mt-tight"
										/>
									</div>
									<div>
										<Label htmlFor="sonnetModel" className="text-sm">
											Sonnet Model
										</Label>
										<Input
											id="sonnetModel"
											value={newAccount.sonnetModel}
											onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
												setNewAccount({
													...newAccount,
													sonnetModel: (e.target as HTMLInputElement).value,
												})
											}
											placeholder="claude-3-sonnet-20240229 (default)"
											className="mt-tight"
										/>
									</div>
									<div>
										<Label htmlFor="haikuModel" className="text-sm">
											Haiku Model
										</Label>
										<Input
											id="haikuModel"
											value={newAccount.haikuModel}
											onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
												setNewAccount({
													...newAccount,
													haikuModel: (e.target as HTMLInputElement).value,
												})
											}
											placeholder="claude-3-haiku-20240307 (default)"
											className="mt-tight"
										/>
									</div>
								</div>
							</div>
						</>
					)}
					{newAccount.mode === "openai-compatible" && (
						<>
							<div className="space-y-item">
								<Label htmlFor="apiKey">API Key</Label>
								<Input
									id="apiKey"
									type="password"
									value={newAccount.apiKey}
									onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
										updateAccountSource({
											apiKey: (e.target as HTMLInputElement).value,
										})
									}
									placeholder="Enter your API key"
								/>
							</div>
							<div className="space-y-item">
								<Label htmlFor="endpoint">Endpoint URL</Label>
								<Input
									id="endpoint"
									value={newAccount.customEndpoint}
									onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
										updateAccountSource({
											customEndpoint: (e.target as HTMLInputElement).value,
										})
									}
									placeholder="https://api.openrouter.ai/api/v1"
								/>
								<p className="text-xs text-muted-foreground">
									Enter the base URL for the OpenAI-compatible API
								</p>
							</div>
							<OpenAIModelMappings
								apiKey={newAccount.apiKey}
								endpoint={newAccount.customEndpoint}
								mappings={newAccount}
								onChange={(field, value) =>
									setNewAccount((prev) => ({ ...prev, [field]: value }))
								}
							/>
						</>
					)}
					{newAccount.mode === "ollama" && (
						<>
							<div className="space-y-item">
								<Label htmlFor="customEndpoint">
									Ollama Endpoint URL (Optional)
								</Label>
								<Input
									id="customEndpoint"
									type="url"
									value={newAccount.customEndpoint}
									onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
										setNewAccount({
											...newAccount,
											customEndpoint: (e.target as HTMLInputElement).value,
										})
									}
									placeholder="http://localhost:11434"
								/>
								<p className="text-xs text-muted-foreground">
									Leave empty to use default http://localhost:11434. Requires
									Ollama v0.14.0+.
								</p>
							</div>
							<div className="space-y-item">
								<Label>Model Mappings (Optional)</Label>
								<p className="text-xs text-muted-foreground mb-item">
									Map Anthropic model names to Ollama model names (e.g.
									qwen3-coder, llama3.3).
								</p>
								<div className="space-y-item pl-group">
									<div>
										<Label htmlFor="opusModel" className="text-sm">
											Opus Model
										</Label>
										<Input
											id="opusModel"
											value={newAccount.opusModel}
											onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
												setNewAccount({
													...newAccount,
													opusModel: (e.target as HTMLInputElement).value,
												})
											}
											placeholder="qwen3-coder (example)"
											className="mt-tight"
										/>
									</div>
									<div>
										<Label htmlFor="sonnetModel" className="text-sm">
											Sonnet Model
										</Label>
										<Input
											id="sonnetModel"
											value={newAccount.sonnetModel}
											onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
												setNewAccount({
													...newAccount,
													sonnetModel: (e.target as HTMLInputElement).value,
												})
											}
											placeholder="qwen3-coder (example)"
											className="mt-tight"
										/>
									</div>
									<div>
										<Label htmlFor="haikuModel" className="text-sm">
											Haiku Model
										</Label>
										<Input
											id="haikuModel"
											value={newAccount.haikuModel}
											onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
												setNewAccount({
													...newAccount,
													haikuModel: (e.target as HTMLInputElement).value,
												})
											}
											placeholder="llama3.3 (example)"
											className="mt-tight"
										/>
									</div>
								</div>
							</div>
						</>
					)}
					{newAccount.mode === "ollama-cloud" && (
						<>
							<div className="space-y-item">
								<Label htmlFor="apiKey">Ollama Cloud API Key</Label>
								<Input
									id="apiKey"
									type="password"
									value={newAccount.apiKey}
									onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
										setNewAccount({
											...newAccount,
											apiKey: (e.target as HTMLInputElement).value,
										})
									}
									placeholder="Enter your Ollama Cloud API key"
								/>
							</div>
							<div className="space-y-item">
								<Label>Model Mappings (Optional)</Label>
								<p className="text-xs text-muted-foreground mb-item">
									Map Anthropic model names to Ollama model names (e.g.
									qwen3-coder, llama3.3).
								</p>
								<div className="space-y-item pl-group">
									<div>
										<Label htmlFor="opusModel" className="text-sm">
											Opus Model
										</Label>
										<Input
											id="opusModel"
											value={newAccount.opusModel}
											onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
												setNewAccount({
													...newAccount,
													opusModel: (e.target as HTMLInputElement).value,
												})
											}
											placeholder="qwen3-coder (example)"
											className="mt-tight"
										/>
									</div>
									<div>
										<Label htmlFor="sonnetModel" className="text-sm">
											Sonnet Model
										</Label>
										<Input
											id="sonnetModel"
											value={newAccount.sonnetModel}
											onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
												setNewAccount({
													...newAccount,
													sonnetModel: (e.target as HTMLInputElement).value,
												})
											}
											placeholder="qwen3-coder (example)"
											className="mt-tight"
										/>
									</div>
									<div>
										<Label htmlFor="haikuModel" className="text-sm">
											Haiku Model
										</Label>
										<Input
											id="haikuModel"
											value={newAccount.haikuModel}
											onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
												setNewAccount({
													...newAccount,
													haikuModel: (e.target as HTMLInputElement).value,
												})
											}
											placeholder="llama3.3 (example)"
											className="mt-tight"
										/>
									</div>
								</div>
							</div>
						</>
					)}
					{newAccount.mode === "openrouter" && (
						<>
							<div className="space-y-item">
								<Label htmlFor="apiKey">OpenRouter API Key</Label>
								<Input
									id="apiKey"
									type="password"
									value={newAccount.apiKey}
									onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
										updateAccountSource({
											apiKey: (e.target as HTMLInputElement).value,
										})
									}
									placeholder="Enter your OpenRouter API key"
								/>
							</div>
							<ModelMappingFields
								mappings={newAccount}
								onChange={(field, value) =>
									setNewAccount((prev) => ({ ...prev, [field]: value }))
								}
								description="OpenRouter model IDs are namespaced (anthropic/claude-sonnet-4.5). Any family left blank is sent upstream unchanged."
								placeholders={{
									opusModel: "anthropic/claude-opus-4.1 (example)",
									sonnetModel: "anthropic/claude-sonnet-4.5 (example)",
									haikuModel: "anthropic/claude-haiku-4.5 (example)",
								}}
							/>
						</>
					)}
					{newAccount.mode === "kilo" && (
						<>
							<div className="space-y-item">
								<Label htmlFor="apiKey">Kilo Gateway API Key</Label>
								<Input
									id="apiKey"
									type="password"
									value={newAccount.apiKey}
									onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
										updateAccountSource({
											apiKey: (e.target as HTMLInputElement).value,
										})
									}
									placeholder="Enter your Kilo Gateway API key"
								/>
							</div>
							<ModelMappingFields
								mappings={newAccount}
								onChange={(field, value) =>
									setNewAccount((prev) => ({ ...prev, [field]: value }))
								}
								description="Map Anthropic model names to gateway model IDs. Families left blank forward the original model ID unchanged."
								placeholders={{
									opusModel: "provider/model-id (example)",
									sonnetModel: "provider/model-id (example)",
									haikuModel: "provider/model-id (example)",
								}}
							/>
						</>
					)}
					{newAccount.mode === "alibaba-coding-plan" && (
						<>
							<div className="space-y-item">
								<Label htmlFor="apiKey">Alibaba Coding Plan API Key</Label>
								<Input
									id="apiKey"
									type="password"
									value={newAccount.apiKey}
									onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
										updateAccountSource({
											apiKey: (e.target as HTMLInputElement).value,
										})
									}
									placeholder="Enter your Alibaba Coding Plan API key"
								/>
							</div>
							<ModelMappingFields
								mappings={newAccount}
								onChange={(field, value) =>
									setNewAccount((prev) => ({ ...prev, [field]: value }))
								}
								description="Map Anthropic model names to provider-specific models. Families left blank forward the original model ID unchanged."
								placeholders={{
									opusModel: "model-id (example)",
									sonnetModel: "model-id (example)",
									haikuModel: "model-id (example)",
								}}
							/>
						</>
					)}
					{(newAccount.mode === "claude-oauth" ||
						newAccount.mode === "console") && (
						<div className="space-y-item">
							<Label htmlFor="customEndpoint">
								Custom Endpoint URL (Optional)
							</Label>
							<Input
								id="customEndpoint"
								type="url"
								value={newAccount.customEndpoint}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
									setNewAccount({
										...newAccount,
										customEndpoint: (e.target as HTMLInputElement).value,
									})
								}
								placeholder="https://api.anthropic.com"
							/>
							<p className="text-xs text-muted-foreground">
								Leave empty to use default Anthropic endpoint. Must be a valid
								URL.
							</p>
						</div>
					)}
					<div className="space-y-item">
						<Label htmlFor="priority">Priority</Label>
						<Select
							value={String(newAccount.priority)}
							onValueChange={(value: string) =>
								setNewAccount({ ...newAccount, priority: parseInt(value, 10) })
							}
						>
							<SelectTrigger id="priority">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="0">0 (Highest)</SelectItem>
								<SelectItem value="25">25 (High)</SelectItem>
								<SelectItem value="50">50 (Medium)</SelectItem>
								<SelectItem value="75">75 (Low)</SelectItem>
								<SelectItem value="100">100 (Lowest)</SelectItem>
							</SelectContent>
						</Select>
					</div>
				</>
			)}
			{authStep === "form" ? (
				<div className="flex gap-item">
					{newAccount.mode === "qwen" ? (
						<>
							{(qwenStep === "idle" || qwenStep === "error") && (
								<Button onClick={handleStartQwenAuth} disabled={isSubmitting}>
									Start Qwen Authentication
								</Button>
							)}
							<Button variant="outline" onClick={handleCancel}>
								Cancel
							</Button>
						</>
					) : newAccount.mode === "codex" ? (
						<>
							{(codexStep === "idle" || codexStep === "error") && (
								<Button onClick={handleStartCodexAuth} disabled={isSubmitting}>
									Start Codex Authentication
								</Button>
							)}
							<Button variant="outline" onClick={handleCancel}>
								Cancel
							</Button>
						</>
					) : (
						<>
							<Button onClick={handleAddAccount} disabled={isSubmitting}>
								Continue
							</Button>
							<Button variant="outline" onClick={handleCancel}>
								Cancel
							</Button>
						</>
					)}
				</div>
			) : (
				<>
					<div className="space-y-item">
						<p className="text-sm text-muted-foreground">
							Open the authorization link in the browser that is signed in to
							the account you are adding, or copy it there. After authorizing,
							copy the code and paste it below.
						</p>
						{authUrl && <AuthorizationHandoff url={authUrl} />}
						<Label htmlFor="code">Authorization Code</Label>
						<Input
							id="code"
							autoComplete="off"
							autoCorrect="off"
							autoCapitalize="none"
							spellCheck={false}
							value={authCode}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
								setAuthCode((e.target as HTMLInputElement).value)
							}
							placeholder="Paste authorization code here"
						/>
					</div>
					<div className="flex gap-item">
						<Button onClick={handleCodeSubmit} disabled={isSubmitting}>
							Complete Setup
						</Button>
						<Button variant="outline" onClick={handleCancel}>
							Cancel
						</Button>
					</div>
				</>
			)}
		</div>
	);
}
