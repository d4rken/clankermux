import { parseHttpError } from "@clankermux/errors";
import {
	Activity,
	BarChart3,
	FileText,
	GitBranch,
	Key,
	LayoutDashboard,
	Menu,
	RefreshCw,
	Settings,
	Users,
	X,
	Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { cn } from "../lib/utils";
import { version } from "../lib/version";
import logoUrl from "../logo.png";
import { CopyButton } from "./CopyButton";
import { SidebarStatus } from "./overview/system-status/SidebarStatus";
import { ThemeToggle } from "./theme-toggle";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";

// ClankerMux is build-from-source + systemd only, so "updating" means pulling
// main and rebuilding — there is no npm/bun/binary install to detect.
const UPDATE_COMMAND =
	"git pull --ff-only && bun run build && sudo systemctl restart clankermux";

interface NavItem {
	label: string;
	icon: React.ComponentType<{ className?: string }>;
	path: string;
	badge?: string;
}

const NAV_ITEMS: NavItem[] = [
	{ label: "Overview", icon: LayoutDashboard, path: "/" },
	{ label: "Analytics", icon: BarChart3, path: "/analytics" },
	{ label: "Requests", icon: Activity, path: "/requests" },
	{ label: "Accounts", icon: Users, path: "/accounts" },
	{ label: "Combos", icon: Zap, path: "/combos" },
	{ label: "API Keys", icon: Key, path: "/api-keys" },
	{ label: "Logs", icon: FileText, path: "/logs" },
	{ label: "Settings", icon: Settings, path: "/settings" },
];

export function Navigation() {
	const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
	const [updateStatus, setUpdateStatus] = useState<
		"idle" | "checking" | "available" | "current" | "unknown" | "error"
	>("idle");
	const [updateInfo, setUpdateInfo] = useState<{
		currentSha: string | null;
		latestSha: string;
		latestUrl: string | null;
		dirty: boolean;
		behindBy: number | null;
	} | null>(null);
	const [updateError, setUpdateError] = useState<string | null>(null);
	const location = useLocation();
	const isMountedRef = useRef(true);

	// Cleanup on unmount to prevent memory leaks
	useEffect(() => {
		return () => {
			isMountedRef.current = false;
		};
	}, []);

	/**
	 * Check whether the running checkout is behind the repo's main branch.
	 *
	 * The backend (`/api/version/check`) compares the deployed commit (local
	 * `git HEAD`) against the latest commit on GitHub's main branch and returns
	 * the decision directly — there is no npm/registry version to compare.
	 * Called on mount and then hourly. The backend caches the GitHub lookup for
	 * an hour, so re-checks are cheap.
	 */
	const checkForUpdates = useCallback(async () => {
		if (!isMountedRef.current) return;

		setUpdateStatus("checking");
		setUpdateError(null);
		try {
			const response = await fetch("/api/version/check");
			if (!response.ok) {
				throw await parseHttpError(response);
			}

			const data = await response.json();

			// Only update state if component is still mounted
			if (!isMountedRef.current) return;

			const status: "available" | "current" | "unknown" = data.status;
			setUpdateInfo({
				currentSha: data.current?.shortSha ?? null,
				latestSha: data.latest?.shortSha ?? "",
				latestUrl: data.latest?.url ?? null,
				dirty: data.current?.dirty ?? false,
				behindBy: typeof data.behindBy === "number" ? data.behindBy : null,
			});
			setUpdateStatus(status);

			if (status === "available") {
				console.log(
					`🚀 Update available: ${data.current?.shortSha ?? "?"} → ${data.latest?.shortSha} (${data.repo}@${data.branch})\nRun: ${UPDATE_COMMAND}`,
				);
			} else if (status === "current") {
				console.log(`✅ Up to date (${data.current?.shortSha ?? "?"})`);
			}
		} catch (error) {
			// Only update state if component is still mounted
			if (!isMountedRef.current) return;

			setUpdateStatus("error");
			setUpdateError(error instanceof Error ? error.message : String(error));
			console.error("❌ Failed to check for updates:", error);
		}
	}, []);

	// Automatic update check: run on mount and every hour
	// biome-ignore lint/correctness/useExhaustiveDependencies: checkForUpdates is stable via useCallback
	useEffect(() => {
		// Check immediately on mount (when dashboard loads)
		checkForUpdates();

		// Set up hourly check
		const intervalId = setInterval(
			() => {
				checkForUpdates();
			},
			60 * 60 * 1000,
		); // 1 hour in milliseconds

		// Cleanup interval on unmount
		return () => {
			clearInterval(intervalId);
		};
	}, []);

	return (
		<>
			{/* Mobile header */}
			<div className="lg:hidden fixed top-0 left-0 right-0 z-50 h-16 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border-b px-4 flex items-center justify-between">
				<div className="flex items-center gap-3">
					<img
						src={logoUrl}
						alt="ClankerMux logo"
						className="h-6 w-6 rounded"
					/>
					<span className="font-semibold text-lg">ClankerMux</span>
				</div>
				<div className="flex items-center gap-2">
					<ThemeToggle />
					<Button
						variant="ghost"
						size="sm"
						onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
					>
						{isMobileMenuOpen ? (
							<X className="h-5 w-5" />
						) : (
							<Menu className="h-5 w-5" />
						)}
					</Button>
				</div>
			</div>

			{/* Mobile menu overlay */}
			{isMobileMenuOpen && (
				<button
					type="button"
					className="lg:hidden fixed inset-0 z-40 bg-background/80 backdrop-blur-sm cursor-default"
					onClick={() => setIsMobileMenuOpen(false)}
					aria-label="Close menu"
				/>
			)}

			{/* Sidebar */}
			<aside
				className={cn(
					"fixed left-0 top-0 z-40 h-screen w-64 bg-card border-r transition-transform duration-300 lg:translate-x-0",
					isMobileMenuOpen
						? "translate-x-0"
						: "-translate-x-full lg:translate-x-0",
				)}
			>
				<div className="flex h-full flex-col">
					{/* Logo */}
					<div className="p-6 pb-4">
						<div className="flex items-center gap-3">
							<img
								src={logoUrl}
								alt="ClankerMux logo"
								className="h-10 w-10 rounded-lg"
							/>
							<div>
								<h1 className="font-semibold text-lg">ClankerMux</h1>
								<p className="text-xs text-muted-foreground">Rate-Unlimiter</p>
							</div>
						</div>
					</div>

					<Separator />

					{/* Navigation */}
					<nav className="flex-1 space-y-1 p-4">
						{NAV_ITEMS.map((item) => {
							const Icon = item.icon;
							const isActive = location.pathname === item.path;
							return (
								<Link
									key={item.path}
									to={item.path}
									onClick={() => setIsMobileMenuOpen(false)}
								>
									<Button
										variant={isActive ? "secondary" : "ghost"}
										className={cn(
											"w-full justify-start gap-3 transition-all",
											isActive &&
												"bg-primary/10 text-primary hover:bg-primary/20",
										)}
									>
										<Icon className="h-4 w-4" />
										{item.label}
										{item.badge && (
											<span className="ml-auto rounded-full bg-primary/20 px-2 py-0.5 text-xs font-medium">
												{item.badge}
											</span>
										)}
									</Button>
								</Link>
							);
						})}
					</nav>

					<Separator />

					{/* Footer */}
					<div className="p-4 space-y-4">
						<SidebarStatus />

						{/* Update Check */}
						<div
							className={cn(
								"rounded-lg bg-muted/50 p-3",
								updateStatus === "checking" && "opacity-50",
							)}
						>
							<button
								type="button"
								onClick={checkForUpdates}
								disabled={updateStatus === "checking"}
								className="w-full transition-colors hover:bg-muted/50 -m-3 p-3 rounded-lg"
							>
								<div className="flex items-center gap-2 text-sm">
									<RefreshCw
										className={cn(
											"h-4 w-4",
											updateStatus === "checking" && "animate-spin",
											updateStatus === "available" && "text-green-500",
											updateStatus === "current" && "text-primary",
											updateStatus === "unknown" && "text-muted-foreground",
											updateStatus === "error" && "text-red-500",
										)}
									/>
									<span className="font-medium">
										{updateStatus === "idle" && "Check for Updates"}
										{updateStatus === "checking" && "Checking..."}
										{updateStatus === "available" && "Update Available"}
										{updateStatus === "current" && "Up to Date"}
										{updateStatus === "unknown" && "Status Unknown"}
										{updateStatus === "error" && "Check Failed"}
									</span>
								</div>
							</button>
							{updateStatus === "available" && (
								<div className="mt-2 space-y-1">
									<p className="text-xs text-muted-foreground text-left font-mono">
										{updateInfo?.currentSha ?? "?"} → {updateInfo?.latestSha}
									</p>
									{typeof updateInfo?.behindBy === "number" &&
										updateInfo.behindBy > 0 && (
											<p className="text-xs text-muted-foreground text-left">
												{updateInfo.behindBy} commit
												{updateInfo.behindBy === 1 ? "" : "s"} behind
											</p>
										)}
									<div className="flex items-center gap-1">
										<code className="text-xs bg-background px-1 py-0.5 rounded font-mono flex-1 truncate">
											{UPDATE_COMMAND}
										</code>
										<CopyButton
											value={UPDATE_COMMAND}
											size="sm"
											variant="ghost"
											className="h-6 w-6 p-0"
											title="Copy update command"
										/>
									</div>
									{updateInfo?.latestUrl && (
										<a
											href={updateInfo.latestUrl}
											target="_blank"
											rel="noopener noreferrer"
											className="text-xs text-muted-foreground hover:text-foreground underline text-left block"
										>
											View latest commit
										</a>
									)}
								</div>
							)}
							{updateStatus === "current" && (
								<p className="mt-1 text-xs text-muted-foreground text-left font-mono">
									{updateInfo?.currentSha
										? `${updateInfo.currentSha}${updateInfo.dirty ? " (modified)" : ""}`
										: version.replace(/^v/, "")}
								</p>
							)}
							{updateStatus === "unknown" && (
								<p className="mt-1 text-xs text-muted-foreground text-left">
									Could not determine the deployed commit (not a git checkout?).
								</p>
							)}
							{updateStatus === "error" && updateError && (
								<p className="mt-1 text-xs text-destructive text-left break-words">
									{updateError}
								</p>
							)}
						</div>

						<div className="hidden lg:flex items-center justify-between">
							<div className="flex items-center gap-2 text-xs text-muted-foreground">
								<GitBranch className="h-3 w-3" />
								<span>{version}</span>
							</div>
							<ThemeToggle />
						</div>
					</div>
				</div>
			</aside>
		</>
	);
}
