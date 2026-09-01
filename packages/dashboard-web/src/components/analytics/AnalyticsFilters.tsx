import type { AnalyticsFilterOption } from "@clankermux/types";
import { Filter } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import { Separator } from "../ui/separator";

/**
 * Analytics filter selection.
 *
 * `accounts` and `apiKeys` hold stable IDs, not display names: a name changes
 * under a rename and disappears under a hard delete, so a name-keyed filter
 * silently orphaned that history. `models` and `projects` ARE their own
 * identity and stay plain values.
 *
 * The two NULL buckets have dedicated flags rather than in-band sentinels, so a
 * project literally named "no-project" stays selectable as a normal name.
 */
export interface FilterState {
	/** Account IDs. */
	accounts: string[];
	models: string[];
	/** api_key_id values. */
	apiKeys: string[];
	projects: string[];
	/** Select requests with no account (SQL NULL account_used). */
	noAccount: boolean;
	noProject: boolean;
	status: "all" | "success" | "error";
}

/** A cleared filter selection — the single definition of "no filters". */
export const EMPTY_FILTERS: FilterState = {
	accounts: [],
	models: [],
	apiKeys: [],
	projects: [],
	noAccount: false,
	noProject: false,
	status: "all",
};

interface AnalyticsFiltersProps {
	filters: FilterState;
	setFilters: (filters: FilterState) => void;
	/** Accounts as {value: id, label: current name}. */
	availableAccounts: AnalyticsFilterOption[];
	availableModels: string[];
	/** API keys as {value: api_key_id, label: current or snapshot name}. */
	availableApiKeys: AnalyticsFilterOption[];
	availableProjects: string[];
	/** Some requests have no account — drives the "(no account)" checkbox. */
	hasNoAccountBucket: boolean;
	/** Some requests have no project — drives the "(no project)" checkbox. */
	hasNoProjectBucket: boolean;
	activeFilterCount: number;
	filterOpen: boolean;
	setFilterOpen: (open: boolean) => void;
}

export function AnalyticsFilters({
	filters,
	setFilters,
	availableAccounts,
	availableModels,
	availableApiKeys,
	availableProjects,
	hasNoAccountBucket,
	hasNoProjectBucket,
	activeFilterCount,
	filterOpen,
	setFilterOpen,
}: AnalyticsFiltersProps) {
	return (
		<Popover open={filterOpen} onOpenChange={setFilterOpen}>
			<PopoverTrigger asChild>
				<Button variant="outline" size="sm">
					<Filter className="h-4 w-4 mr-item" />
					Filters
					{activeFilterCount > 0 && (
						<Badge variant="secondary" className="ml-item h-5 px-tight">
							{activeFilterCount}
						</Badge>
					)}
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-80" align="start">
				<div className="space-y-group">
					<div className="flex items-center justify-between">
						<h4 className="font-medium leading-none">Filters</h4>
						{activeFilterCount > 0 && (
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setFilters(EMPTY_FILTERS)}
							>
								Clear all
							</Button>
						)}
					</div>

					<Separator />

					{/* Status Filter */}
					<div className="space-y-item">
						<Label>Status</Label>
						<Select
							value={filters.status}
							onValueChange={(value) =>
								setFilters({
									...filters,
									status: value as FilterState["status"],
								})
							}
						>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">All Requests</SelectItem>
								<SelectItem value="success">Success Only</SelectItem>
								<SelectItem value="error">Errors Only</SelectItem>
							</SelectContent>
						</Select>
					</div>

					{/* Account Filter — also shown when only the no-account bucket
					    exists (or noAccount is already applied), so it stays
					    reachable/clearable with zero named accounts. */}
					{(availableAccounts.length > 0 ||
						hasNoAccountBucket ||
						filters.noAccount) && (
						<div className="space-y-item">
							<Label>
								Accounts (
								{filters.accounts.length + (filters.noAccount ? 1 : 0)}{" "}
								selected)
							</Label>
							<div className="border rounded-md p-item max-h-32 overflow-y-auto space-y-tight">
								{(hasNoAccountBucket || filters.noAccount) && (
									<label className="flex items-center space-x-item cursor-pointer hover:bg-muted/50 p-tight rounded">
										<input
											type="checkbox"
											className="rounded border-input"
											checked={filters.noAccount}
											onChange={(e) =>
												setFilters({ ...filters, noAccount: e.target.checked })
											}
										/>
										<span className="text-sm italic">(no account)</span>
									</label>
								)}
								{availableAccounts.map((account) => (
									<label
										key={account.value}
										className="flex items-center space-x-item cursor-pointer hover:bg-muted/50 p-tight rounded"
									>
										<input
											type="checkbox"
											className="rounded border-input"
											checked={filters.accounts.includes(account.value)}
											onChange={(e) => {
												if (e.target.checked) {
													setFilters({
														...filters,
														accounts: [...filters.accounts, account.value],
													});
												} else {
													setFilters({
														...filters,
														accounts: filters.accounts.filter(
															(a) => a !== account.value,
														),
													});
												}
											}}
										/>
										<span className="text-sm truncate">{account.label}</span>
									</label>
								))}
							</div>
						</div>
					)}

					{/* Model Filter */}
					{availableModels.length > 0 && (
						<div className="space-y-item">
							<Label>Models ({filters.models.length} selected)</Label>
							<div className="border rounded-md p-item max-h-32 overflow-y-auto space-y-tight">
								{availableModels.map((model) => (
									<label
										key={model}
										className="flex items-center space-x-item cursor-pointer hover:bg-muted/50 p-tight rounded"
									>
										<input
											type="checkbox"
											className="rounded border-input"
											checked={filters.models.includes(model)}
											onChange={(e) => {
												if (e.target.checked) {
													setFilters({
														...filters,
														models: [...filters.models, model],
													});
												} else {
													setFilters({
														...filters,
														models: filters.models.filter((m) => m !== model),
													});
												}
											}}
										/>
										<span className="text-sm truncate">{model}</span>
									</label>
								))}
							</div>
						</div>
					)}

					{/* API Key Filter */}
					{availableApiKeys.length > 0 && (
						<div className="space-y-item">
							<Label>API Keys ({filters.apiKeys.length} selected)</Label>
							<div className="border rounded-md p-item max-h-32 overflow-y-auto space-y-tight">
								{availableApiKeys.map((apiKey) => (
									<label
										key={apiKey.value}
										className="flex items-center space-x-item cursor-pointer hover:bg-muted/50 p-tight rounded"
									>
										<input
											type="checkbox"
											className="rounded border-input"
											checked={filters.apiKeys.includes(apiKey.value)}
											onChange={(e) => {
												if (e.target.checked) {
													setFilters({
														...filters,
														apiKeys: [...filters.apiKeys, apiKey.value],
													});
												} else {
													setFilters({
														...filters,
														apiKeys: filters.apiKeys.filter(
															(k) => k !== apiKey.value,
														),
													});
												}
											}}
										/>
										<span className="text-sm truncate">{apiKey.label}</span>
									</label>
								))}
							</div>
						</div>
					)}

					{/* Project Filter — also shown when only the NULL bucket exists in
					    range (or noProject is already applied), so "(no project)" stays
					    reachable/clearable even with zero named projects. */}
					{(availableProjects.length > 0 ||
						hasNoProjectBucket ||
						filters.noProject) && (
						<div className="space-y-item">
							<Label>
								Projects (
								{filters.projects.length + (filters.noProject ? 1 : 0)}{" "}
								selected)
							</Label>
							<div className="border rounded-md p-item max-h-32 overflow-y-auto space-y-tight">
								{(hasNoProjectBucket || filters.noProject) && (
									<label className="flex items-center space-x-item cursor-pointer hover:bg-muted/50 p-tight rounded">
										<input
											type="checkbox"
											className="rounded border-input"
											checked={filters.noProject}
											onChange={(e) =>
												setFilters({ ...filters, noProject: e.target.checked })
											}
										/>
										<span className="text-sm italic">(no project)</span>
									</label>
								)}
								{availableProjects.map((project) => (
									<label
										key={project}
										className="flex items-center space-x-item cursor-pointer hover:bg-muted/50 p-tight rounded"
									>
										<input
											type="checkbox"
											className="rounded border-input"
											checked={filters.projects.includes(project)}
											onChange={(e) => {
												if (e.target.checked) {
													setFilters({
														...filters,
														projects: [...filters.projects, project],
													});
												} else {
													setFilters({
														...filters,
														projects: filters.projects.filter(
															(p) => p !== project,
														),
													});
												}
											}}
										/>
										<span className="text-sm truncate">{project}</span>
									</label>
								))}
							</div>
						</div>
					)}

					<Separator />

					<div className="flex justify-end">
						<Button size="sm" onClick={() => setFilterOpen(false)}>
							Done
						</Button>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
}
