import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
	AlertTriangle,
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
import { fetchApiKeys, useAccounts } from "../hooks/queries";
import { describePinTarget } from "../lib/api-key-pin-label";
import { invalidateCapacityQueries, queryKeys } from "../lib/query-keys";
import { cn } from "../lib/utils";
import { CopyButton } from "./CopyButton";
import { Alert } from "./ui/alert";
import { Badge } from "./ui/badge";
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
import { PanelEmptyState } from "./ui/panel-empty-state";
import { SectionHeading } from "./ui/section-heading";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "./ui/select";
import { Skeleton } from "./ui/skeleton";

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

/**
 * One of the three key-count tiles at the top of the page.
 *
 * Local and deliberately not `overview/MetricCard`: that one requires an `icon`
 * and carries trend, sub-row and popover machinery none of these three use, so
 * adopting it would mean inventing three icons to satisfy a required prop.
 */
function StatCard({
	label,
	value,
	valueClassName,
}: {
	label: string;
	value: number;
	valueClassName?: string;
}) {
	return (
		<Card>
			<CardHeader className="pb-item">
				<CardTitle className="text-base font-medium">{label}</CardTitle>
			</CardHeader>
			<CardContent>
				<div className={cn("figure-xl", valueClassName)}>{value}</div>
			</CardContent>
		</Card>
	);
}

/**
 * Stable keys for the API-key list skeleton.
 *
 * Exactly three, so the loading list and the loaded list occupy the same box
 * and QA can measure one selector across both with a three-key stub.
 *
 * `h-[7.625rem]` is a real key row: 1px of border top and bottom (2), `p-group`
 * top and bottom (32), and a left column of a 24px name line, a `text-sm`
 * "key ends with" line at `mt-tight` (24) and two `text-xs` lines at `mt-tight`
 * (20 each) = 88. The six `size="sm"` action buttons opposite are 32px, so the
 * left column sets the height. 2 + 32 + 88 = 122px.
 */
const API_KEY_SKELETON_ROWS = ["key-1", "key-2", "key-3"] as const;

type PinMode = "unpinned" | "account" | "provider";

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

	// Fetch API keys - only when not showing the generated key dialog.
	// Shares `queryKeys.apiKeys()` and the shared fetcher with `useApiKeys`: two
	// caches for one resource drift. Every mutation below goes through
	// `invalidateCapacityQueries`, which also refreshes the server-computed
	// runway — it embeds the key set and their routing pins, so a create /
	// enable / disable / delete / rename / re-pin here changes it.
	const {
		data: apiKeysList,
		isLoading: isLoadingKeys,
		error: keysError,
	} = useQuery({
		queryKey: queryKeys.apiKeys(),
		queryFn: fetchApiKeys,
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
			invalidateCapacityQueries(queryClient);
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
			invalidateCapacityQueries(queryClient);
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
			invalidateCapacityQueries(queryClient);
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
			invalidateCapacityQueries(queryClient);
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
			invalidateCapacityQueries(queryClient);
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
			invalidateCapacityQueries(queryClient);
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

	const stats = statsResponse?.data;
	const apiKeys = apiKeysList ?? [];
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
				<CardContent className="p-group">
					<Alert
						size="md"
						tone="destructive"
						icon={<AlertTriangle className="h-5 w-5" />}
						title="Failed to load API keys. Please try again."
					/>
				</CardContent>
			</Card>
		);
	}

	return (
		<div className="space-y-section">
			{/* Statistics Cards */}
			<div className="grid grid-cols-1 md:grid-cols-3 gap-group">
				<StatCard label="Total Keys" value={stats?.total || 0} />
				<StatCard
					label="Active Keys"
					value={stats?.active || 0}
					valueClassName="text-success-strong"
				/>
				<StatCard
					label="Inactive Keys"
					value={stats?.inactive || 0}
					valueClassName="text-muted-foreground"
				/>
			</div>

			{/* Header with Create Button */}
			<div className="flex items-center justify-between">
				<SectionHeading
					title="API Keys"
					description="Manage API keys for authentication. When at least one key is active, all API requests must include a valid API key."
				/>
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
						<div className="space-y-group py-group">
							<div className="space-y-item">
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
					<div className="flex items-start justify-between gap-group">
						<div>
							<CardTitle>Your API Keys</CardTitle>
							{/* No `mt-1.5`: the [data-slot="title"] + [data-slot="subtitle"]
						    base rule already supplies 0.5rem, and this utility outranked
						    it — so this one card header rendered 0.375rem where every
						    other renders 0.5rem. */}
							<CardDescription>
								{apiKeys.length === 0
									? "No API keys have been created yet."
									: `You have ${apiKeys.length} API key${apiKeys.length === 1 ? "" : "s"}.`}
							</CardDescription>
						</div>
						{apiKeys.length > 1 && (
							<div className="flex items-center gap-item shrink-0">
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
						<div
							data-slot="api-key-list"
							aria-busy="true"
							className="space-y-group"
						>
							<span className="sr-only" role="status">
								Loading API keys
							</span>
							{API_KEY_SKELETON_ROWS.map((rowKey) => (
								<Skeleton
									key={rowKey}
									className="h-[7.625rem] w-full rounded-lg"
								/>
							))}
						</div>
					) : apiKeys.length === 0 ? (
						<PanelEmptyState icon={<Shield className="h-12 w-12" />}>
							<span>
								No API keys configured. API authentication will be disabled
								until you create your first key.
							</span>
						</PanelEmptyState>
					) : (
						<div data-slot="api-key-list" className="space-y-group">
							{sortedApiKeys.map((key) => (
								<div
									key={key.id}
									className="flex flex-col gap-row p-group border rounded-lg"
								>
									<div className="flex items-center justify-between">
										<div className="flex-1">
											<div className="flex items-center gap-item">
												<h3 className="font-medium">{key.name}</h3>
												{/* The shared Badge, not a one-off `bg-success/15` tint: the
												    active pill is a solid fill like every other status
												    badge in the app. */}
												<Badge variant={key.isActive ? "success" : "secondary"}>
													{key.isActive ? "Active" : "Disabled"}
												</Badge>
											</div>
											<div className="text-sm text-muted-foreground mt-tight">
												Key ends with:{" "}
												<code className="bg-muted px-tight rounded">
													{key.prefixLast8}
												</code>
											</div>
											<div className="text-xs text-muted-foreground mt-tight flex items-center gap-tight">
												<Route className="h-3 w-3" />
												<span>
													{describePinTarget(
														{
															accountId: key.pinnedAccountId,
															providers: key.pinnedProviders,
														},
														accounts,
													)}
												</span>
											</div>
											<div className="text-xs text-muted-foreground mt-tight">
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
										<div className="flex items-center gap-item">
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
											<CopyButton
												variant="outline"
												size="sm"
												value={key.prefixLast8}
												title="Copy key prefix"
											/>
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
												<Trash2 className="h-4 w-4 text-destructive-strong" />
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
					<div className="space-y-group py-group">
						<div className="space-y-item">
							<Label>API Key</Label>
							<div className="flex items-center gap-item">
								<code className="flex-1 p-row bg-muted rounded text-sm font-mono break-all">
									{generatedKey?.apiKey}
								</code>
								<CopyButton
									variant="outline"
									size="sm"
									value={generatedKey?.apiKey ?? ""}
									title="Copy API key"
								/>
							</div>
						</div>
						<Alert
							size="md"
							tone="warning"
							icon={<AlertTriangle className="h-5 w-5" />}
							title="Important:"
						>
							Save this API key in a secure location. You won't be able to see
							it again after closing this dialog.
						</Alert>
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
					<div className="py-group space-y-row">
						<p className="text-sm text-muted-foreground">
							Use this when the original key has been lost. Any application or
							script still using the old secret will start failing with 401
							until you update it.
						</p>
						{regenerateKeyMutation.isError && (
							<Alert
								size="sm"
								tone="destructive"
								// No `mt-0.5` on the icon: that hairline nudge only made sense
								// against the old `items-start` shell. Alert's header row is
								// `items-center`, where it would push the icon BELOW centre.
								icon={<AlertTriangle className="h-4 w-4 shrink-0" />}
								title={
									regenerateKeyMutation.error?.message ??
									"Failed to regenerate API key."
								}
							/>
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
						<div className="grid gap-group py-group">
							<div className="grid gap-item">
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
									<p className="text-sm text-destructive-strong">
										{renameError}
									</p>
								)}
							</div>
							{renameKeyMutation.isError && (
								<Alert
									size="sm"
									tone="destructive"
									icon={<AlertTriangle className="h-4 w-4 shrink-0" />}
									title={
										renameKeyMutation.error?.message ??
										"Failed to rename API key."
									}
								/>
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
					<div className="py-group">
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
		<div className="border-t pt-row space-y-row">
			<div className="space-y-item">
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
				<div className="space-y-item">
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
										<span className="ml-item text-xs text-muted-foreground">
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
				<div className="space-y-item">
					<Label className="text-xs">Provider classes</Label>
					{availableProviders.length === 0 ? (
						<p className="text-xs text-muted-foreground">
							No providers configured.
						</p>
					) : (
						<div className="flex flex-wrap gap-row">
							{availableProviders.map((provider) => (
								<label
									key={provider}
									className="flex items-center gap-item text-sm cursor-pointer"
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
				<Alert
					size="sm"
					tone="destructive"
					icon={<AlertTriangle className="h-4 w-4 shrink-0" />}
					title={error}
				/>
			)}

			<div className="flex items-center gap-item">
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
