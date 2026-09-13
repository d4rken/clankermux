import type { ClientView } from "@clankermux/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { MoreHorizontal, Plus, Settings2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { useAccounts } from "../hooks/queries";
import { clientRequest } from "./clients/api";
import { ClientSetupDialog } from "./clients/ClientSetupDialog";
import { ClientWizard } from "./clients/ClientWizard";
import { APPLICATIONS } from "./clients/setup";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "./ui/dialog";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";

export function ClientsTab() {
	const queryClient = useQueryClient();
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 60000);
		return () => clearInterval(timer);
	}, []);
	const {
		data: clients = [],
		isPending,
		error,
	} = useQuery({
		queryKey: ["clients"],
		queryFn: () => clientRequest<ClientView[]>(""),
		refetchInterval: 60000,
	});
	const { data: accounts = [] } = useAccounts();
	const [editing, setEditing] = useState<ClientView | "new" | null>(null);
	const [setup, setSetup] = useState<{
		client: ClientView;
		apiKey?: string;
	} | null>(null);
	const [action, setAction] = useState<{
		client: ClientView;
		kind: "rotate" | "delete" | "enable" | "disable";
	} | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const reload = () => {
		void queryClient.invalidateQueries({ queryKey: ["clients"] });
		void queryClient.invalidateQueries({ queryKey: ["apiKeys"] });
	};
	const finish = (result: { client: ClientView; apiKey?: string }) => {
		setEditing(null);
		setSetup(result);
		reload();
	};
	const confirm = async () => {
		if (!action) return;
		setBusy(true);
		setActionError(null);
		try {
			const result = await clientRequest<{ apiKey?: string }>(
				`/${encodeURIComponent(action.client.apiKeyId)}${action.kind === "delete" ? "" : `/${action.kind}`}`,
				undefined,
				action.kind === "delete" ? "DELETE" : "POST",
			);
			if (result.apiKey)
				setSetup({ client: action.client, apiKey: result.apiKey });
			setAction(null);
			reload();
		} catch (e) {
			setActionError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	const sortedClients = useMemo(
		() =>
			[...clients].sort(
				(a, b) =>
					a.key.name.localeCompare(b.key.name, undefined, {
						numeric: true,
						sensitivity: "base",
					}) ||
					a.key.name.localeCompare(b.key.name) ||
					a.apiKeyId.localeCompare(b.apiKeyId),
			),
		[clients],
	);
	if (editing)
		return (
			<ClientWizard
				key={editing === "new" ? "new" : editing.apiKeyId}
				client={editing === "new" ? undefined : editing}
				accounts={accounts}
				onCancel={() => setEditing(null)}
				onSaved={finish}
			/>
		);
	return (
		<div className="space-y-section">
			<div className="flex flex-wrap justify-between gap-group">
				<p className="text-sm text-muted-foreground max-w-prose">
					Each installation or integration has its own key, allowed upstream
					destinations, and advertised model catalogue.
				</p>
				<Button onClick={() => setEditing("new")}>
					<Plus className="h-4 w-4 mr-2" />
					Add client
				</Button>
			</div>
			{error && (
				<p role="alert" className="text-destructive">
					{error.message}
				</p>
			)}
			{isPending && <p className="text-muted-foreground">Loading clients…</p>}
			{!isPending && !error && !clients.length && (
				<Card>
					<CardContent className="p-6 text-center">
						<h2 className="font-semibold">Add your first client</h2>
						<p className="text-sm text-muted-foreground mt-2">
							Choose an application, review its destinations and models, then
							copy its configuration.
						</p>
					</CardContent>
				</Card>
			)}

			{sortedClients.length > 0 && (
				<div className="overflow-hidden rounded-lg border bg-card">
					<div
						aria-hidden="true"
						className="hidden xl:grid xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1fr)_10rem_15.5rem] gap-4 border-b bg-muted/30 px-5 py-2.5 text-xs font-medium text-muted-foreground"
					>
						<span>Client</span>
						<span>Destinations</span>
						<span>Catalogue models</span>
						<span>Last request</span>
						<span className="text-right">Actions</span>
					</div>
					<ul aria-label="Clients" className="divide-y">
						{sortedClients.map((client) => (
							<li
								key={client.apiKeyId}
								className="px-4 py-4 sm:px-5 hover:bg-muted/20 transition-colors"
							>
								<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1fr)_10rem_15.5rem] xl:items-center xl:gap-4">
									<div className="min-w-0">
										<div className="flex items-center gap-2">
											<h2 className="font-semibold text-sm break-words min-w-0">
												{client.key.name}
											</h2>
											{!client.key.isActive && (
												<span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
													Disabled
												</span>
											)}
										</div>
										<p className="text-xs text-muted-foreground mt-1">
											{APPLICATIONS[client.application]}{" "}
											<span className="mx-1">·</span>{" "}
											<span className="font-mono">
												…{client.key.prefixLast8}
											</span>
										</p>
									</div>
									<div className="min-w-0 text-sm">
										<p className="xl:sr-only text-xs text-muted-foreground mb-1">
											Destinations
										</p>
										<p className="break-words">
											{client.key.pinnedAccountId
												? (accounts.find(
														(a) => a.id === client.key.pinnedAccountId,
													)?.name ?? "Unavailable account")
												: (client.key.pinnedProviders?.join(", ") ??
													"All accounts")}
										</p>
									</div>
									<div className="text-xs leading-5 text-muted-foreground">
										<p className="xl:sr-only mb-1">Catalogue models</p>
										<span className="text-foreground tabular-nums">
											{client.catalogues.anthropic.models.length}
										</span>{" "}
										Anthropic ·{" "}
										<span className="text-foreground tabular-nums">
											{client.catalogues.openai.models.length}
										</span>{" "}
										OpenAI ·{" "}
										<span className="text-foreground tabular-nums">
											{client.catalogues.codex.models.length}
										</span>{" "}
										Codex
									</div>
									<div className="text-xs text-muted-foreground">
										<p className="xl:sr-only mb-1">Last request</p>
										<span
											className={
												client.key.lastUsed &&
												now - new Date(client.key.lastUsed).getTime() >= 0 &&
												now - new Date(client.key.lastUsed).getTime() < 86400000
													? "text-green-600 dark:text-green-400"
													: undefined
											}
										>
											{client.key.lastUsed
												? formatDistanceToNow(new Date(client.key.lastUsed), {
														addSuffix: true,
													})
												: "No requests yet"}
										</span>
									</div>
									<div className="flex items-center gap-1.5 sm:col-span-2 xl:col-span-1 xl:justify-end">
										<Button
											variant="outline"
											size="sm"
											onClick={() => setEditing(client)}
										>
											<Settings2 className="h-3.5 w-3.5 mr-1.5" />
											Configure
										</Button>
										<Button
											variant="ghost"
											size="sm"
											onClick={() => setSetup({ client })}
										>
											Setup instructions
										</Button>
										<DropdownMenu>
											<DropdownMenuTrigger asChild>
												<Button
													variant="ghost"
													size="icon"
													className="h-8 w-8 shrink-0"
													aria-label={`Actions for ${client.key.name}`}
												>
													<MoreHorizontal className="h-4 w-4" />
												</Button>
											</DropdownMenuTrigger>
											<DropdownMenuContent align="end">
												{(
													[
														"rotate",
														client.key.isActive ? "disable" : "enable",
														"delete",
													] as const
												).map((kind) => (
													<DropdownMenuItem
														key={kind}
														onSelect={() => {
															setAction({ client, kind });
															setActionError(null);
														}}
														className={
															kind === "delete" ? "text-destructive" : undefined
														}
													>
														{kind === "rotate"
															? "Rotate key"
															: kind === "disable"
																? "Disable"
																: kind === "enable"
																	? "Enable"
																	: "Delete"}
													</DropdownMenuItem>
												))}
											</DropdownMenuContent>
										</DropdownMenu>
									</div>
								</div>
								{client.notices.length > 0 && (
									<details className="mt-2 text-xs text-muted-foreground">
										<summary className="cursor-pointer w-fit">
											{client.notices.length} catalogue{" "}
											{client.notices.length === 1 ? "notice" : "notices"}
										</summary>
										<div className="mt-2 space-y-1 max-w-prose">
											{client.notices.map((n) => (
												<p key={n}>{n}</p>
											))}
										</div>
									</details>
								)}
							</li>
						))}
					</ul>
				</div>
			)}

			<p className="text-xs text-muted-foreground">
				<Link className="underline" to="/clients/defaults">
					Unauthenticated catalogue
				</Link>{" "}
				applies when API key authentication is not configured. Existing clients
				keep independent catalogue copies.
			</p>
			{setup && (
				<ClientSetupDialog
					key={setup.client.apiKeyId}
					client={setup.client}
					initialApiKey={setup.apiKey}
					onClose={() => setSetup(null)}
				/>
			)}

			<Dialog
				open={!!action}
				onOpenChange={(open) => {
					if (!open && !busy) setAction(null);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							{action?.kind === "rotate"
								? "Rotate client key"
								: action?.kind === "delete"
									? "Delete client"
									: action?.kind === "disable"
										? "Disable client"
										: "Enable client"}
						</DialogTitle>
						<DialogDescription>
							{action?.kind === "rotate"
								? `Replace the key for ${action.client.key.name}. Update that installation with the new key; the old key stops working immediately.`
								: action?.kind === "delete"
									? `Delete ${action.client.key.name}, its catalogue and setup-owned alias rules. Manually created routing references must be removed first.`
									: `${action?.kind === "disable" ? "Block" : "Allow"} requests using ${action?.client.key.name}'s key.`}
						</DialogDescription>
					</DialogHeader>
					{actionError && (
						<p role="alert" className="text-destructive text-sm">
							{actionError}
						</p>
					)}
					<DialogFooter>
						<Button
							variant="outline"
							disabled={busy}
							onClick={() => setAction(null)}
						>
							Cancel
						</Button>
						<Button disabled={busy} onClick={confirm}>
							{busy ? "Working…" : "Confirm"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
