import type { ClientView } from "@clankermux/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Plus, Settings2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { useAccounts } from "../hooks/queries";
import { CopyButton } from "./CopyButton";
import { clientRequest } from "./clients/api";
import { ClientWizard } from "./clients/ClientWizard";
import { APPLICATIONS, clientSetup, preferredFormat } from "./clients/setup";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "./ui/dialog";

export function ClientsTab() {
	const queryClient = useQueryClient();
	const {
		data: clients = [],
		isPending,
		error,
	} = useQuery({
		queryKey: ["clients"],
		queryFn: () => clientRequest<ClientView[]>(""),
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
	const format = setup ? preferredFormat(setup.client.application) : "openai";
	const recipe = setup
		? clientSetup(
				setup.client.application,
				typeof window === "undefined"
					? "http://localhost:8080"
					: window.location.origin,
				setup.apiKey ?? "YOUR_CLIENT_API_KEY",
				setup.client.catalogues[format].defaultModel,
				setup.client.catalogues[format].models,
			)
		: null;
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
			<div className="grid gap-group xl:grid-cols-2">
				{clients.map((client) => (
					<Card key={client.apiKeyId}>
						<CardHeader>
							<div className="flex items-start justify-between gap-group">
								<div>
									<CardTitle>{client.key.name}</CardTitle>
									<p className="text-sm text-muted-foreground mt-1">
										{APPLICATIONS[client.application]} ·{" "}
										{client.key.isActive ? "Enabled" : "Disabled"}
									</p>
								</div>
								<Button
									variant="outline"
									size="sm"
									onClick={() => setEditing(client)}
								>
									<Settings2 className="h-4 w-4 mr-2" />
									Configure
								</Button>
							</div>
						</CardHeader>
						<CardContent className="space-y-group">
							<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
								<dt className="text-muted-foreground">Destinations</dt>
								<dd>
									{client.key.pinnedAccountId
										? (accounts.find((a) => a.id === client.key.pinnedAccountId)
												?.name ?? "Unavailable account")
										: (client.key.pinnedProviders?.join(", ") ??
											"All accounts")}
								</dd>
								<dt className="text-muted-foreground">Models</dt>
								<dd>
									{client.catalogues.anthropic.models.length} Anthropic ·{" "}
									{client.catalogues.openai.models.length} OpenAI ·{" "}
									{client.catalogues.codex.models.length} Codex
								</dd>
								<dt className="text-muted-foreground">Last request</dt>
								<dd>
									{client.key.lastUsed
										? formatDistanceToNow(new Date(client.key.lastUsed), {
												addSuffix: true,
											})
										: "No requests yet"}
								</dd>
								<dt className="text-muted-foreground">Key</dt>
								<dd className="font-mono">…{client.key.prefixLast8}</dd>
							</dl>
							{client.notices.map((n) => (
								<p key={n} className="text-xs text-muted-foreground">
									{n}
								</p>
							))}
							<div className="flex flex-wrap gap-2">
								<Button
									variant="outline"
									size="sm"
									onClick={() => setSetup({ client })}
								>
									Setup instructions
								</Button>
								{(
									[
										"rotate",
										client.key.isActive ? "disable" : "enable",
										"delete",
									] as const
								).map((kind) => (
									<Button
										key={kind}
										variant="ghost"
										size="sm"
										onClick={() => {
											setAction({ client, kind });
											setActionError(null);
										}}
									>
										{kind === "rotate"
											? "Rotate key"
											: kind === "disable"
												? "Disable"
												: kind === "enable"
													? "Enable"
													: "Delete"}
									</Button>
								))}
							</div>
						</CardContent>
					</Card>
				))}
			</div>
			<p className="text-xs text-muted-foreground">
				<Link className="underline" to="/clients/defaults">
					Unauthenticated catalogue
				</Link>{" "}
				applies when API key authentication is not configured. Existing clients
				keep independent catalogue copies.
			</p>
			<Dialog
				open={!!setup}
				onOpenChange={(open) => {
					if (!open) setSetup(null);
				}}
			>
				<DialogContent className="max-w-3xl max-h-[90vh] overflow-auto">
					<DialogHeader>
						<DialogTitle>{setup?.client.key.name} setup</DialogTitle>
						<DialogDescription>
							{setup?.apiKey
								? "Save this key now. It will not be shown again."
								: "Use the key you saved for this client, or rotate it to obtain a new one."}
						</DialogDescription>
					</DialogHeader>
					{setup?.apiKey && (
						<div className="rounded border p-3 flex items-start gap-2">
							<code className="text-sm break-all flex-1">{setup.apiKey}</code>
							<CopyButton value={setup.apiKey}>Copy key</CopyButton>
						</div>
					)}
					{recipe && (
						<>
							<div className="flex items-center justify-between gap-2">
								<h3 className="text-sm font-medium">{recipe.label}</h3>
								<CopyButton value={recipe.snippet}>Copy settings</CopyButton>
							</div>
							<pre className="text-xs overflow-auto max-h-96 rounded bg-muted p-4">
								{recipe.snippet}
							</pre>
							{recipe.environment && (
								<div className="space-y-2">
									<div className="flex items-center justify-between">
										<h3 className="text-sm font-medium">Shell environment</h3>
										<CopyButton value={recipe.environment}>
											Copy environment
										</CopyButton>
									</div>
									<pre className="text-xs overflow-auto rounded bg-muted p-4">
										{recipe.environment}
									</pre>
								</div>
							)}
							{recipe.command && (
								<div className="space-y-2">
									<div className="flex items-center justify-between">
										<h3 className="text-sm font-medium">Launch client</h3>
										<CopyButton value={recipe.command}>Copy command</CopyButton>
									</div>
									<pre className="text-xs overflow-auto rounded bg-muted p-4">
										{recipe.command}
									</pre>
								</div>
							)}
							<p className="text-sm text-muted-foreground">{recipe.note}</p>
						</>
					)}
					<DialogFooter>
						<Button onClick={() => setSetup(null)}>Done</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
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
