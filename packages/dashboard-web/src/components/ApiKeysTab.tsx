import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
	AlertTriangle,
	Copy,
	Pencil,
	Plus,
	RefreshCw,
	Route,
	Shield,
	ToggleLeft,
	ToggleRight,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { type Account, api } from "../api";
import { useAccounts } from "../hooks/queries";
import { Button } from "./ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "./ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "./ui/select";

interface ApiKey {
	id: string;
	name: string;
	prefixLast8: string;
	createdAt: string;
	lastUsed: string | null;
	usageCount: number;
	isActive: boolean;
	pinnedAccountId: string | null;
	pinnedProviders: string[] | null;
}

/**
 * Human-readable summary of a key's routing pin, shown in the key row. Pure and
 * exported so it can be unit-tested without mounting the whole tab.
 *   - pinned account  -> "Pinned → <accountName>" (falls back to the id when the
 *     account no longer exists)
 *   - pinned providers -> "Pinned → <providers joined with ', '>"
 *   - neither          -> "Unpinned" (normal load-balancing)
 */
export function describePinTarget(
	key: Pick<ApiKey, "pinnedAccountId" | "pinnedProviders">,
	accounts: Pick<Account, "id" | "name">[],
): string {
	if (key.pinnedAccountId) {
		const account = accounts.find((a) => a.id === key.pinnedAccountId);
		return `Pinned → ${account?.name ?? key.pinnedAccountId}`;
	}
	if (key.pinnedProviders && key.pinnedProviders.length > 0) {
		return `Pinned → ${key.pinnedProviders.join(", ")}`;
	}
	return "Unpinned";
}

/**
 * Client-side validation for the rename-key dialog. Pure and exported so it can
 * be unit-tested without mounting the tab (mirrors `describePinTarget`). Returns
 * an inline error message to show, or `null` when the trimmed name is a valid,
 * changed name that may be submitted. Mirrors the server contract: non-empty
 * after trim, ≤100 chars, and renaming to the current name is a no-op (blocked
 * client-side so we never fire a pointless request).
 */
export function validateRenameKey(
	rawName: string,
	currentName: string,
): string | null {
	const trimmed = rawName.trim();
	if (!trimmed) {
		return "Name cannot be empty";
	}
	if (trimmed.length > 100) {
		return "Name cannot exceed 100 characters";
	}
	if (trimmed === currentName) {
		return "Name is unchanged";
	}
	return null;
}

export type ApiKeySortMode = "created" | "name" | "requests" | "lastUsed";

const API_KEY_SORT_STORAGE_KEY = "clankermux-api-keys-sort";

const API_KEY_SORT_MODES: ApiKeySortMode[] = [
	"created",
	"name",
	"requests",
	"lastUsed",
];

const API_KEY_SORT_LABELS: Record<ApiKeySortMode, string> = {
	created: "Newest first",
	name: "Name",
	requests: "Request count",
	lastUsed: "Last used",
};

/**
 * Validate a persisted sort mode (from localStorage). Anything unknown falls
 * back to "created", which mirrors the server's default ordering
 * (created_at DESC), so a missing or corrupt preference changes nothing.
 */
export function parseApiKeySortMode(value: string | null): ApiKeySortMode {
	return API_KEY_SORT_MODES.includes(value as ApiKeySortMode)
		? (value as ApiKeySortMode)
		: "created";
}

/**
 * Return the keys sorted per the selected mode (input untouched). Pure and
 * exported so it can be unit-tested without mounting the whole tab.
 *   - created  -> newest first (the server's default order)
 *   - name     -> alphabetical, case-insensitive
 *   - requests -> highest usage count first
 *   - lastUsed -> most recently used first; never-used keys last
 * Ties fall back to name so equal rows keep a deterministic order.
 */
export function sortApiKeys<
	T extends Pick<ApiKey, "name" | "createdAt" | "lastUsed" | "usageCount">,
>(keys: T[], mode: ApiKeySortMode): T[] {
	const byName = (a: T, b: T) =>
		a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
	return [...keys].sort((a, b) => {
		if (mode === "name") {
			return byName(a, b);
		}
		if (mode === "requests") {
			return b.usageCount - a.usageCount || byName(a, b);
		}
		if (mode === "lastUsed") {
			// null = never used → sorts after every real timestamp. When both are
			// never-used the subtraction is NaN (falsy), so the name tiebreak kicks in.
			const aTime = a.lastUsed
				? new Date(a.lastUsed).getTime()
				: Number.NEGATIVE_INFINITY;
			const bTime = b.lastUsed
				? new Date(b.lastUsed).getTime()
				: Number.NEGATIVE_INFINITY;
			return bTime - aTime || byName(a, b);
		}
		// "created" — newest first, the server's default order
		return (
			new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ||
			byName(a, b)
		);
	});
}

type PinMode = "unpinned" | "account" | "provider";

interface ApiKeysResponse {
	success: boolean;
	data: ApiKey[];
	count: number;
}

interface ApiKeyStatsResponse {
	success: boolean;
	data: {
		total: number;
		active: number;
		inactive: number;
	};
}

interface ApiKeyGenerationResponse {
	success: boolean;
	data: {
		id: string;
		name: string;
		apiKey: string; // Full API key shown only once
		prefixLast8: string;
		createdAt: string;
	};
}

export function ApiKeysTab() {
	const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
	const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
	const [isRegenerateDialogOpen, setIsRegenerateDialogOpen] = useState(false);
	const [isRenameDialogOpen, setIsRenameDialogOpen] = useState(false);
	const [newKeyName, setNewKeyName] = useState("");
	const [renameValue, setRenameValue] = useState("");
	const [selectedKey, setSelectedKey] = useState<ApiKey | null>(null);
	const [generatedKey, setGeneratedKey] = useState<{
		apiKey: string;
		source: "created" | "regenerated";
	} | null>(null);
	// Id of the key whose Routing editor is currently expanded (only one at a
	// time). The editor's draft state lives in the <PinEditor> child so opening
	// a row starts from that key's current pin.
	const [editingPinKeyId, setEditingPinKeyId] = useState<string | null>(null);
	// List sort order, persisted so the choice survives reloads. localStorage
	// can throw (e.g. Safari private mode) — degrade to the in-memory default.
	const [sortMode, setSortMode] = useState<ApiKeySortMode>(() => {
		if (typeof window === "undefined") return "created";
		try {
			return parseApiKeySortMode(
				window.localStorage.getItem(API_KEY_SORT_STORAGE_KEY),
			);
		} catch {
			return "created";
		}
	});

	const handleSortModeChange = (value: string) => {
		const mode = parseApiKeySortMode(value);
		setSortMode(mode);
		try {
			window.localStorage.setItem(API_KEY_SORT_STORAGE_KEY, mode);
		} catch {
			// ignore — degrade to in-memory
		}
	};

	const queryClient = useQueryClient();

	// Accounts power the pin dropdown (pin to a specific account) and the
	// distinct-provider list (pin to a provider class). Shared hook used across
	// the dashboard.
	const { data: accounts = [] } = useAccounts();

	// Fetch API key statistics - only when not showing the generated key dialog
	const { data: statsResponse, error: statsError } =
		useQuery<ApiKeyStatsResponse>({
			queryKey: ["api-keys-stats"],
			queryFn: async () => {
				return api.get<ApiKeyStatsResponse>("/api/api-keys/stats");
			},
			enabled: !generatedKey, // Don't fetch while showing generated key
		});

	// Fetch API keys - only when not showing the generated key dialog
	const {
		data: apiKeysResponse,
		isLoading: isLoadingKeys,
		error: keysError,
	} = useQuery<ApiKeysResponse>({
		queryKey: ["api-keys"],
		queryFn: async () => {
			return api.get<ApiKeysResponse>("/api/api-keys");
		},
		enabled: !generatedKey, // Don't fetch while showing generated key
	});

	// Generate API key mutation
	const generateKeyMutation = useMutation({
		mutationFn: async (params: { name: string }) => {
			const result = await api.post<ApiKeyGenerationResponse>("/api/api-keys", {
				name: params.name,
			});
			return result.data;
		},
		onSuccess: (data) => {
			setGeneratedKey({ apiKey: data.apiKey, source: "created" });
			setNewKeyName("");
			setIsCreateDialogOpen(false);
			queryClient.invalidateQueries({ queryKey: ["api-keys"] });
			queryClient.invalidateQueries({ queryKey: ["api-keys-stats"] });
		},
		onError: (error: Error) => {
			console.error("Failed to generate API key:", error);
		},
	});

	const handleSavedKey = () => {
		setGeneratedKey(null);
	};

	// Toggle API key status mutation
	const toggleKeyMutation = useMutation({
		mutationFn: async ({ name, enable }: { name: string; enable: boolean }) => {
			const endpoint = enable
				? `/api/api-keys/${encodeURIComponent(name)}/enable`
				: `/api/api-keys/${encodeURIComponent(name)}/disable`;
			return api.post(endpoint);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["api-keys"] });
			queryClient.invalidateQueries({ queryKey: ["api-keys-stats"] });
		},
	});

	// Delete API key mutation
	const deleteKeyMutation = useMutation({
		mutationFn: async (name: string) => {
			return api.delete(`/api/api-keys/${encodeURIComponent(name)}`);
		},
		onSuccess: () => {
			setSelectedKey(null);
			setIsDeleteDialogOpen(false);
			queryClient.invalidateQueries({ queryKey: ["api-keys"] });
			queryClient.invalidateQueries({ queryKey: ["api-keys-stats"] });
		},
	});

	// Regenerate API key mutation: mints a new secret for an existing key,
	// preserving id, name, createdAt, usageCount, isActive. The aggregate
	// counts in `api-keys-stats` don't change on regenerate (row stays, stays
	// active), so we intentionally don't invalidate that query.
	const regenerateKeyMutation = useMutation({
		mutationFn: async (name: string) => {
			const result = await api.post<ApiKeyGenerationResponse>(
				`/api/api-keys/${encodeURIComponent(name)}/regenerate`,
			);
			return result.data;
		},
		onSuccess: (data) => {
			setSelectedKey(null);
			setIsRegenerateDialogOpen(false);
			setGeneratedKey({ apiKey: data.apiKey, source: "regenerated" });
			queryClient.invalidateQueries({ queryKey: ["api-keys"] });
		},
		onError: (error: Error) => {
			// Inline error UI shows mutation.error in the regenerate dialog body;
			// log for parity with generateKeyMutation so console-based debugging
			// surfaces both flows consistently.
			console.error("Failed to regenerate API key:", error);
		},
	});

	// Rename an existing key. Keyed by id (not name) since the name is exactly
	// what's changing. A rename leaves the row count and active/inactive split
	// untouched, so we intentionally don't invalidate api-keys-stats. The server
	// returns 409 when the new name is held by a different key — surfaced inline
	// in the dialog via renameKeyMutation.error.
	const renameKeyMutation = useMutation({
		mutationFn: async ({ id, name }: { id: string; name: string }) => {
			return api.post(`/api/api-keys/${encodeURIComponent(id)}/rename`, {
				name,
			});
		},
		onSuccess: () => {
			setIsRenameDialogOpen(false);
			setSelectedKey(null);
			setRenameValue("");
			queryClient.invalidateQueries({ queryKey: ["api-keys"] });
			// counts don't change on rename → intentionally NOT invalidating
			// ["api-keys-stats"]
		},
		onError: (error: Error) => {
			console.error("Failed to rename API key:", error);
		},
	});

	// Set / clear a key's routing pin. Body shape mirrors the backend contract:
	//   {}                        -> clear (normal load-balancing)
	//   { accountId }             -> pin to a specific account
	//   { providers: [...] }      -> pin to a provider class
	// accountId and providers are mutually exclusive (enforced server-side; the
	// editor never submits both). Doesn't touch api-keys-stats — pinning doesn't
	// change active/inactive counts.
	const setPinMutation = useMutation({
		mutationFn: async ({
			id,
			body,
		}: {
			id: string;
			body: { accountId?: string | null; providers?: string[] | null };
		}) => {
			return api.put(`/api/api-keys/${encodeURIComponent(id)}/pin`, body);
		},
		onSuccess: () => {
			setEditingPinKeyId(null);
			queryClient.invalidateQueries({ queryKey: ["api-keys"] });
		},
		onError: (error: Error) => {
			// Inline error UI surfaces mutation.error next to the editor's Save
			// button; log for parity with the other mutations in this tab.
			console.error("Failed to update API key routing:", error);
		},
	});

	const handleGenerateKey = () => {
		if (!newKeyName.trim()) return;
		generateKeyMutation.mutate({ name: newKeyName.trim() });
	};

	const handleSavePin = (
		key: ApiKey,
		body: { accountId?: string | null; providers?: string[] | null },
	) => {
		setPinMutation.mutate({ id: key.id, body });
	};

	const togglePinEditor = (key: ApiKey) => {
		setPinMutation.reset();
		setEditingPinKeyId((current) => (current === key.id ? null : key.id));
	};

	const handleToggleKey = (key: ApiKey, enable: boolean) => {
		toggleKeyMutation.mutate({ name: key.name, enable });
	};

	const handleDeleteKey = (key: ApiKey) => {
		setSelectedKey(key);
		setIsDeleteDialogOpen(true);
	};

	const confirmDeleteKey = () => {
		if (selectedKey) {
			deleteKeyMutation.mutate(selectedKey.name);
		}
	};

	const handleRegenerateKey = (key: ApiKey) => {
		setSelectedKey(key);
		setIsRegenerateDialogOpen(true);
	};

	const confirmRegenerateKey = () => {
		if (selectedKey) {
			regenerateKeyMutation.mutate(selectedKey.name);
		}
	};

	const handleRenameKey = (key: ApiKey) => {
		setSelectedKey(key);
		setRenameValue(key.name);
		renameKeyMutation.reset();
		setIsRenameDialogOpen(true);
	};

	const confirmRenameKey = () => {
		// Single source of truth for validity: reuse validateRenameKey rather than
		// re-deriving the empty/unchanged rules inline (the Save button is gated by
		// the same helper, so they can't drift).
		if (
			!selectedKey ||
			validateRenameKey(renameValue, selectedKey.name) !== null
		) {
			return;
		}
		renameKeyMutation.mutate({ id: selectedKey.id, name: renameValue.trim() });
	};

	const copyToClipboard = (text: string) => {
		navigator.clipboard.writeText(text).catch((err) => {
			console.error("Failed to copy to clipboard:", err);
		});
	};

	const stats = statsResponse?.data;
	const apiKeys = apiKeysResponse?.data || [];
	const sortedApiKeys = sortApiKeys(apiKeys, sortMode);

	// Client-side rename validation, computed once for both the inline error
	// message and the Save-button disabled state. `null` means the trimmed name
	// is valid and changed (safe to submit).
	const renameError = validateRenameKey(renameValue, selectedKey?.name ?? "");
	const canRenameSubmit = renameError === null;

	// Distinct providers actually configured, so the operator can only pin to a
	// provider class they have an account for. Sorted for a stable list.
	const availableProviders = Array.from(
		new Set(accounts.map((a) => a.provider)),
	).sort();

	if (keysError || statsError) {
		return (
			<Card>
				<CardContent className="p-6">
					<div className="flex items-center gap-2 text-destructive">
						<AlertTriangle className="h-5 w-5" />
						<span>Failed to load API keys. Please try again.</span>
					</div>
				</CardContent>
			</Card>
		);
	}

	return (
		<div className="space-y-6">
			{/* Statistics Cards */}
			<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
				<Card>
					<CardHeader className="pb-2">
						<CardTitle className="text-base font-medium">Total Keys</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold">{stats?.total || 0}</div>
					</CardContent>
				</Card>
				<Card>
					<CardHeader className="pb-2">
						<CardTitle className="text-base font-medium">Active Keys</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold text-green-600">
							{stats?.active || 0}
						</div>
					</CardContent>
				</Card>
				<Card>
					<CardHeader className="pb-2">
						<CardTitle className="text-base font-medium">
							Inactive Keys
						</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="text-2xl font-bold text-muted-foreground">
							{stats?.inactive || 0}
						</div>
					</CardContent>
				</Card>
			</div>

			{/* Header with Create Button */}
			<div className="flex items-center justify-between">
				<div>
					<h2 className="text-xl font-semibold">API Keys</h2>
					<p className="text-muted-foreground">
						Manage API keys for authentication. When at least one key is active,
						all API requests must include a valid API key.
					</p>
				</div>
				<Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
					<DialogTrigger asChild>
						<Button>
							<Plus className="h-4 w-4 mr-2" />
							Generate API Key
						</Button>
					</DialogTrigger>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>Generate New API Key</DialogTitle>
							<DialogDescription>
								Create a new API key for authentication. The key will be shown
								only once, so save it securely.
							</DialogDescription>
						</DialogHeader>
						<div className="space-y-4 py-4">
							<div className="space-y-2">
								<Label htmlFor="name">Key Name</Label>
								<Input
									id="name"
									placeholder="e.g., Production App, Development Key"
									value={newKeyName}
									onChange={(e) => setNewKeyName(e.target.value)}
								/>
							</div>
						</div>
						<DialogFooter>
							<Button
								onClick={() => setIsCreateDialogOpen(false)}
								variant="outline"
							>
								Cancel
							</Button>
							<Button
								onClick={handleGenerateKey}
								disabled={!newKeyName.trim() || generateKeyMutation.isPending}
							>
								{generateKeyMutation.isPending
									? "Generating..."
									: "Generate Key"}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</div>

			{/* API Keys List */}
			<Card>
				<CardHeader>
					<div className="flex items-start justify-between gap-4">
						<div>
							<CardTitle>Your API Keys</CardTitle>
							<CardDescription className="mt-1.5">
								{apiKeys.length === 0
									? "No API keys have been created yet."
									: `You have ${apiKeys.length} API key${apiKeys.length === 1 ? "" : "s"}.`}
							</CardDescription>
						</div>
						{apiKeys.length > 1 && (
							<div className="flex items-center gap-2 shrink-0">
								<Label
									htmlFor="api-key-sort"
									className="text-xs text-muted-foreground whitespace-nowrap"
								>
									Sort by
								</Label>
								<Select value={sortMode} onValueChange={handleSortModeChange}>
									<SelectTrigger id="api-key-sort" className="h-9 w-[160px]">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{API_KEY_SORT_MODES.map((mode) => (
											<SelectItem key={mode} value={mode}>
												{API_KEY_SORT_LABELS[mode]}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						)}
					</div>
				</CardHeader>
				<CardContent>
					{isLoadingKeys ? (
						<div className="text-center py-8">Loading API keys...</div>
					) : apiKeys.length === 0 ? (
						<div className="text-center py-8 text-muted-foreground">
							<Shield className="h-12 w-12 mx-auto mb-4 opacity-50" />
							<p>No API keys configured</p>
							<p className="text-sm">
								API authentication will be disabled until you create your first
								key.
							</p>
						</div>
					) : (
						<div className="space-y-4">
							{sortedApiKeys.map((key) => (
								<div
									key={key.id}
									className="flex flex-col gap-3 p-4 border rounded-lg"
								>
									<div className="flex items-center justify-between">
										<div className="flex-1">
											<div className="flex items-center gap-2">
												<h3 className="font-medium">{key.name}</h3>
												<div
													className={`px-2 py-1 rounded text-xs font-medium ${
														key.isActive
															? "bg-green-100 text-green-800"
															: "bg-gray-100 text-gray-600"
													}`}
												>
													{key.isActive ? "Active" : "Disabled"}
												</div>
											</div>
											<div className="text-sm text-muted-foreground mt-1">
												Key ends with:{" "}
												<code className="bg-muted px-1 rounded">
													{key.prefixLast8}
												</code>
											</div>
											<div className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
												<Route className="h-3 w-3" />
												<span>{describePinTarget(key, accounts)}</span>
											</div>
											<div className="text-xs text-muted-foreground mt-1">
												Created{" "}
												{formatDistanceToNow(new Date(key.createdAt), {
													addSuffix: true,
												})}
												{key.lastUsed && (
													<>
														{" • "}Last used{" "}
														{formatDistanceToNow(new Date(key.lastUsed), {
															addSuffix: true,
														})}
													</>
												)}
												{" • "}Used {key.usageCount} time
												{key.usageCount !== 1 ? "s" : ""}
											</div>
										</div>
										<div className="flex items-center gap-2">
											<Button
												variant="outline"
												size="sm"
												onClick={() => togglePinEditor(key)}
												title="Change request routing for this key"
												aria-label="Change routing"
												aria-expanded={editingPinKeyId === key.id}
											>
												<Route className="h-4 w-4" />
											</Button>
											<Button
												variant="outline"
												size="sm"
												onClick={() => copyToClipboard(key.prefixLast8)}
											>
												<Copy className="h-4 w-4" />
											</Button>
											<Button
												variant="outline"
												size="sm"
												onClick={() => handleRenameKey(key)}
												disabled={renameKeyMutation.isPending}
												title="Rename API key"
												aria-label="Rename API key"
											>
												<Pencil className="h-4 w-4" />
											</Button>
											<Button
												variant="outline"
												size="sm"
												onClick={() => handleToggleKey(key, !key.isActive)}
												disabled={toggleKeyMutation.isPending}
											>
												{key.isActive ? (
													<ToggleLeft className="h-4 w-4" />
												) : (
													<ToggleRight className="h-4 w-4" />
												)}
											</Button>
											<Button
												variant="outline"
												size="sm"
												onClick={() => handleRegenerateKey(key)}
												disabled={
													!key.isActive || regenerateKeyMutation.isPending
												}
												title={
													key.isActive
														? "Regenerate API key"
														: "Enable the key first to regenerate it"
												}
												aria-label="Regenerate API key"
											>
												<RefreshCw className="h-4 w-4" />
											</Button>
											<Button
												variant="outline"
												size="sm"
												onClick={() => handleDeleteKey(key)}
												disabled={deleteKeyMutation.isPending}
											>
												<Trash2 className="h-4 w-4 text-destructive" />
											</Button>
										</div>
									</div>
									{editingPinKeyId === key.id && (
										<PinEditor
											apiKey={key}
											accounts={accounts}
											availableProviders={availableProviders}
											isPending={setPinMutation.isPending}
											error={
												setPinMutation.isError
													? (setPinMutation.error?.message ??
														"Failed to update routing.")
													: null
											}
											onSave={(body) => handleSavePin(key, body)}
											onCancel={() => {
												setPinMutation.reset();
												setEditingPinKeyId(null);
											}}
										/>
									)}
								</div>
							))}
						</div>
					)}
				</CardContent>
			</Card>

			{/* Generated Key Dialog */}
			<Dialog
				open={!!generatedKey}
				onOpenChange={(open) => {
					if (!open) {
						setGeneratedKey(null);
					}
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							{generatedKey?.source === "regenerated"
								? "API Key Regenerated"
								: "API Key Generated"}
						</DialogTitle>
						<DialogDescription>
							{generatedKey?.source === "regenerated"
								? "A new secret has been minted for this key. Save it securely now - it won't be shown again."
								: "Your API key has been generated. Save it securely now - it won't be shown again."}
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-4 py-4">
						<div className="space-y-2">
							<Label>API Key</Label>
							<div className="flex items-center gap-2">
								<code className="flex-1 p-3 bg-muted rounded text-sm font-mono break-all">
									{generatedKey?.apiKey}
								</code>
								<Button
									variant="outline"
									size="sm"
									onClick={() =>
										generatedKey && copyToClipboard(generatedKey.apiKey)
									}
								>
									<Copy className="h-4 w-4" />
								</Button>
							</div>
						</div>
						<div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
							<div className="flex items-center gap-2 text-yellow-800">
								<AlertTriangle className="h-5 w-5" />
								<span className="font-medium">Important:</span>
							</div>
							<p className="text-sm text-yellow-700 mt-1">
								Save this API key in a secure location. You won't be able to see
								it again after closing this dialog.
							</p>
						</div>
					</div>
					<DialogFooter>
						<Button onClick={handleSavedKey} variant="outline">
							I've saved the key
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Regenerate Confirmation Dialog */}
			<Dialog
				open={isRegenerateDialogOpen}
				onOpenChange={(open) => {
					setIsRegenerateDialogOpen(open);
					if (!open) {
						setSelectedKey(null);
						regenerateKeyMutation.reset();
					}
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Regenerate API Key</DialogTitle>
						<DialogDescription>
							Mint a new secret for "{selectedKey?.name}". The existing secret
							will stop working immediately, but the key's stats and usage
							history will be preserved.
						</DialogDescription>
					</DialogHeader>
					<div className="py-4 space-y-3">
						<p className="text-sm text-muted-foreground">
							Use this when the original key has been lost. Any application or
							script still using the old secret will start failing with 401
							until you update it.
						</p>
						{regenerateKeyMutation.isError && (
							<div className="p-3 bg-destructive/10 border border-destructive/30 rounded-lg">
								<div className="flex items-start gap-2 text-destructive">
									<AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
									<span className="text-sm">
										{regenerateKeyMutation.error?.message ??
											"Failed to regenerate API key."}
									</span>
								</div>
							</div>
						)}
					</div>
					<DialogFooter>
						<Button
							onClick={() => setIsRegenerateDialogOpen(false)}
							variant="outline"
						>
							Cancel
						</Button>
						<Button
							onClick={confirmRegenerateKey}
							variant="destructive"
							disabled={regenerateKeyMutation.isPending}
						>
							{regenerateKeyMutation.isPending
								? "Regenerating..."
								: "Regenerate Key"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Rename Dialog */}
			<Dialog
				open={isRenameDialogOpen}
				onOpenChange={(open) => {
					setIsRenameDialogOpen(open);
					if (!open) {
						setSelectedKey(null);
						setRenameValue("");
						renameKeyMutation.reset();
					}
				}}
			>
				<DialogContent>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							confirmRenameKey();
						}}
					>
						<DialogHeader>
							<DialogTitle>Rename API Key</DialogTitle>
							<DialogDescription>
								Enter a new name for the API key "{selectedKey?.name}".
							</DialogDescription>
						</DialogHeader>
						<div className="grid gap-4 py-4">
							<div className="grid gap-2">
								<Label htmlFor="rename-key-name">New Name</Label>
								<Input
									id="rename-key-name"
									value={renameValue}
									onChange={(e) => setRenameValue(e.target.value)}
									placeholder="Enter new key name"
									autoFocus
									maxLength={100}
									disabled={renameKeyMutation.isPending}
								/>
								{renameError && (
									<p className="text-sm text-destructive">{renameError}</p>
								)}
							</div>
							{renameKeyMutation.isError && (
								<div className="p-3 bg-destructive/10 border border-destructive/30 rounded-lg">
									<div className="flex items-start gap-2 text-destructive">
										<AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
										<span className="text-sm">
											{renameKeyMutation.error?.message ??
												"Failed to rename API key."}
										</span>
									</div>
								</div>
							)}
						</div>
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => setIsRenameDialogOpen(false)}
								disabled={renameKeyMutation.isPending}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								disabled={!canRenameSubmit || renameKeyMutation.isPending}
							>
								{renameKeyMutation.isPending ? "Renaming..." : "Rename"}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>

			{/* Delete Confirmation Dialog */}
			<Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Delete API Key</DialogTitle>
						<DialogDescription>
							Are you sure you want to delete the API key "{selectedKey?.name}"?
							This action cannot be undone.
						</DialogDescription>
					</DialogHeader>
					<div className="py-4">
						<p className="text-sm text-muted-foreground">
							Deleting this API key will immediately invalidate it, and any
							applications using it will no longer be able to authenticate.
						</p>
					</div>
					<DialogFooter>
						<Button
							onClick={() => setIsDeleteDialogOpen(false)}
							variant="outline"
						>
							Cancel
						</Button>
						<Button
							onClick={confirmDeleteKey}
							variant="destructive"
							disabled={deleteKeyMutation.isPending}
						>
							{deleteKeyMutation.isPending ? "Deleting..." : "Delete Key"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

interface PinEditorProps {
	apiKey: ApiKey;
	accounts: Pick<Account, "id" | "name" | "provider">[];
	availableProviders: string[];
	isPending: boolean;
	error: string | null;
	onSave: (body: {
		accountId?: string | null;
		providers?: string[] | null;
	}) => void;
	onCancel: () => void;
}

/**
 * Inline editor for a single key's routing pin. Local draft state is seeded from
 * the key's current pin so opening the editor reflects what's live; nothing is
 * persisted until Save. The three modes are mutually exclusive (the backend also
 * enforces this), so we only ever submit one of accountId / providers.
 */
function PinEditor({
	apiKey,
	accounts,
	availableProviders,
	isPending,
	error,
	onSave,
	onCancel,
}: PinEditorProps) {
	const initialMode: PinMode = apiKey.pinnedAccountId
		? "account"
		: apiKey.pinnedProviders && apiKey.pinnedProviders.length > 0
			? "provider"
			: "unpinned";

	const [mode, setMode] = useState<PinMode>(initialMode);
	const [accountId, setAccountId] = useState<string>(
		apiKey.pinnedAccountId ?? "",
	);
	const [providers, setProviders] = useState<string[]>(
		apiKey.pinnedProviders ?? [],
	);

	const toggleProvider = (provider: string) => {
		setProviders((current) =>
			current.includes(provider)
				? current.filter((p) => p !== provider)
				: [...current, provider],
		);
	};

	const handleSave = () => {
		if (mode === "account") {
			onSave({ accountId });
		} else if (mode === "provider") {
			onSave({ providers });
		} else {
			onSave({});
		}
	};

	// Block Save on incomplete selections so we never POST an empty pin that the
	// operator didn't intend as "clear".
	const saveDisabled =
		isPending ||
		(mode === "account" && !accountId) ||
		(mode === "provider" && providers.length === 0);

	return (
		<div className="border-t pt-3 space-y-3">
			<div className="space-y-2">
				<Label className="text-xs">Routing mode</Label>
				<Select value={mode} onValueChange={(v) => setMode(v as PinMode)}>
					<SelectTrigger className="h-9">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="unpinned">Unpinned (load-balanced)</SelectItem>
						<SelectItem value="account">Pin to account</SelectItem>
						<SelectItem value="provider">Pin to provider class</SelectItem>
					</SelectContent>
				</Select>
			</div>

			{mode === "account" && (
				<div className="space-y-2">
					<Label className="text-xs">Account</Label>
					{accounts.length === 0 ? (
						<p className="text-xs text-muted-foreground">
							No accounts configured.
						</p>
					) : (
						<Select value={accountId} onValueChange={setAccountId}>
							<SelectTrigger className="h-9">
								<SelectValue placeholder="Select an account" />
							</SelectTrigger>
							<SelectContent>
								{accounts.map((account) => (
									<SelectItem key={account.id} value={account.id}>
										{account.name}
										<span className="ml-2 text-xs text-muted-foreground">
											{account.provider}
										</span>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
				</div>
			)}

			{mode === "provider" && (
				<div className="space-y-2">
					<Label className="text-xs">Provider classes</Label>
					{availableProviders.length === 0 ? (
						<p className="text-xs text-muted-foreground">
							No providers configured.
						</p>
					) : (
						<div className="flex flex-wrap gap-3">
							{availableProviders.map((provider) => (
								<label
									key={provider}
									className="flex items-center gap-2 text-sm cursor-pointer"
								>
									<input
										type="checkbox"
										className="h-4 w-4"
										checked={providers.includes(provider)}
										onChange={() => toggleProvider(provider)}
									/>
									{provider}
								</label>
							))}
						</div>
					)}
				</div>
			)}

			{error && (
				<div className="p-3 bg-destructive/10 border border-destructive/30 rounded-lg">
					<div className="flex items-start gap-2 text-destructive">
						<AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
						<span className="text-sm">{error}</span>
					</div>
				</div>
			)}

			<div className="flex items-center gap-2">
				<Button size="sm" onClick={handleSave} disabled={saveDisabled}>
					{isPending ? "Saving..." : "Save"}
				</Button>
				<Button size="sm" variant="outline" onClick={onCancel}>
					Cancel
				</Button>
			</div>
		</div>
	);
}
