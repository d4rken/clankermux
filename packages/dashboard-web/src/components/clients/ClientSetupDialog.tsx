import type { ClientView } from "@clankermux/types";
import { useEffect, useState } from "react";
import { CopyButton } from "../CopyButton";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { clientRequest } from "./api";
import { clientSetupExports, preferredFormat } from "./setup";

export function ClientSetupDialog({
	client,
	initialApiKey,
	onClose,
}: {
	client: ClientView;
	initialApiKey?: string;
	onClose: () => void;
}) {
	const [apiKey, setApiKey] = useState<string | null>(initialApiKey ?? null);
	const [loading, setLoading] = useState(!initialApiKey);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const [existingKey, setExistingKey] = useState("");
	const [saving, setSaving] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries the same setup-key URL.
	useEffect(() => {
		if (initialApiKey) return;
		let ignore = false;
		setLoading(true);
		setError(null);
		void clientRequest<{ apiKey: string | null }>(
			`/${encodeURIComponent(client.apiKeyId)}/setup-key`,
		)
			.then((result) => {
				if (!ignore) setApiKey(result.apiKey);
			})
			.catch((e) => {
				if (!ignore) setError(e instanceof Error ? e.message : String(e));
			})
			.finally(() => {
				if (!ignore) setLoading(false);
			});
		return () => {
			ignore = true;
		};
	}, [client.apiKeyId, initialApiKey, attempt]);
	const saveKey = async () => {
		setSaving(true);
		setError(null);
		try {
			const result = await clientRequest<{ apiKey: string }>(
				`/${encodeURIComponent(client.apiKeyId)}/setup-key`,
				{ apiKey: existingKey.trim() },
			);
			setApiKey(result.apiKey);
			setExistingKey("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	};
	const catalogue = client.catalogues[preferredFormat(client.application)];
	const exports = apiKey
		? clientSetupExports(
				client.application,
				typeof window === "undefined"
					? "http://localhost:8080"
					: window.location.origin,
				apiKey,
				catalogue.defaultModel,
				catalogue.models,
			)
		: [];
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="max-w-3xl max-h-[90dvh] overflow-auto gap-5">
				<DialogHeader className="space-y-2">
					<DialogTitle>{client.key.name} setup</DialogTitle>
					<DialogDescription>
						Copy the configuration for this installation. Its saved API key is
						filled in whenever you open setup.
					</DialogDescription>
				</DialogHeader>
				{loading && (
					<p role="status" className="text-sm text-muted-foreground">
						Loading API key…
					</p>
				)}
				{error && (
					<div
						role="alert"
						className="text-sm text-destructive flex items-center justify-between gap-3"
					>
						<span>{error}</span>
						{!apiKey && (
							<Button
								variant="outline"
								size="sm"
								disabled={loading}
								onClick={() => setAttempt((a) => a + 1)}
							>
								Retry
							</Button>
						)}
					</div>
				)}
				{!loading && !apiKey && (
					<form
						className="rounded-lg border bg-muted/20 p-4 space-y-3"
						onSubmit={(e) => {
							e.preventDefault();
							void saveKey();
						}}
					>
						<p className="text-sm text-muted-foreground">
							Paste the existing key once to prefill and remember it. If you no
							longer have it, close this dialog and use Rotate key in the client
							menu.
						</p>
						<label
							htmlFor="existing-client-key"
							className="block text-sm font-medium"
						>
							Existing API key
						</label>
						<div className="flex flex-wrap gap-2">
							<Input
								id="existing-client-key"
								className="flex-1 min-w-0 font-mono"
								type="password"
								autoComplete="off"
								maxLength={512}
								value={existingKey}
								onChange={(e) => setExistingKey(e.target.value)}
							/>
							<Button type="submit" disabled={saving || !existingKey.trim()}>
								{saving ? "Saving…" : "Save key"}
							</Button>
						</div>
					</form>
				)}
				{apiKey && (
					<>
						<div className="rounded-md border bg-muted/20 p-3 flex items-center gap-3">
							<code className="text-xs break-all flex-1">{apiKey}</code>
							<CopyButton value={apiKey}>Copy key</CopyButton>
						</div>
						<Tabs defaultValue={exports[0]?.id}>
							{exports.length > 1 && (
								<TabsList
									aria-label="Setup export format"
									className="h-auto flex flex-wrap justify-start w-fit mb-4"
								>
									{exports.map((e) => (
										<TabsTrigger key={e.id} value={e.id}>
											{e.tab}
										</TabsTrigger>
									))}
								</TabsList>
							)}
							{exports.map((recipe) => (
								<TabsContent
									key={recipe.id}
									value={recipe.id}
									className="space-y-4 mt-0"
								>
									<div className="space-y-2">
										<div className="flex items-center justify-between gap-3">
											<h3 className="text-sm font-medium">{recipe.label}</h3>
											<CopyButton value={recipe.snippet}>
												Copy settings
											</CopyButton>
										</div>
										<pre className="text-xs leading-relaxed overflow-auto max-h-[50dvh] rounded-md bg-muted p-4">
											{recipe.snippet}
										</pre>
									</div>
									{recipe.environment && (
										<div className="space-y-2">
											<div className="flex items-center justify-between gap-3">
												<h3 className="text-sm font-medium">
													Also required: shell environment
												</h3>
												<CopyButton value={recipe.environment}>
													Copy environment
												</CopyButton>
											</div>
											<pre className="text-xs overflow-auto rounded-md bg-muted p-4">
												{recipe.environment}
											</pre>
										</div>
									)}
									{recipe.command && (
										<div className="space-y-2">
											<div className="flex items-center justify-between gap-3">
												<h3 className="text-sm font-medium">Launch client</h3>
												<CopyButton value={recipe.command}>
													Copy command
												</CopyButton>
											</div>
											<pre className="text-xs overflow-auto rounded-md bg-muted p-4">
												{recipe.command}
											</pre>
										</div>
									)}
									<p className="text-sm leading-relaxed text-muted-foreground">
										{recipe.note}
									</p>
								</TabsContent>
							))}
						</Tabs>
					</>
				)}
				<DialogFooter>
					<Button onClick={onClose}>Done</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
