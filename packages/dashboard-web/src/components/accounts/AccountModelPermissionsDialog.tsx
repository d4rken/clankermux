import type { AccountModelPermissions } from "@clankermux/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Account, api } from "../../api";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";

type PermissionView = Omit<AccountModelPermissions, "scope">;
export function AccountModelPermissionsDialog({
	isOpen,
	account,
	onOpenChange,
}: {
	isOpen: boolean;
	account: Account | null;
	onOpenChange: (open: boolean) => void;
}) {
	const client = useQueryClient();
	const key = ["account-model-permissions", account?.id];
	const path = `/api/accounts/${encodeURIComponent(account?.id ?? "")}/model-permissions`;
	const query = useQuery({
		queryKey: key,
		queryFn: () => api.get<{ data: PermissionView }>(path),
		enabled: isOpen && !!account,
	});
	const [draft, setDraft] = useState<{
		text: string;
		generation: number;
	} | null>(null);
	const [declareEmpty, setDeclareEmpty] = useState(false);
	const mutation = useMutation({
		mutationFn: async (refresh: boolean) => {
			if (refresh) return api.post(path, {});
			const data = query.data?.data;
			if (!data) throw new Error("Load model permissions first");
			return api.put(path, {
				manual_ids: (draft?.text ?? data.manual_ids.join("\n"))
					.split("\n")
					.map((s) => s.trim())
					.filter(Boolean),
				generation: draft?.generation ?? data.generation,
				declare_empty: declareEmpty,
			});
		},
		onSuccess: () => {
			setDraft(null);
			setDeclareEmpty(false);
			client.invalidateQueries({ queryKey: key });
		},
	});
	const data = query.data?.data;
	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90vh] overflow-auto">
				<DialogHeader>
					<DialogTitle>Permitted models · {account?.name}</DialogTitle>
					<DialogDescription>
						Discovered models and explicit manual additions authorize this
						account. Routing rules choose which permitted model a request uses.
					</DialogDescription>
				</DialogHeader>
				{query.isPending ? (
					<p>Loading permissions…</p>
				) : query.error ? (
					<p role="alert">{query.error.message}</p>
				) : (
					data && (
						<div className="space-y-4">
							<p className="text-sm">
								Discovery:{" "}
								{data.completeness === "unknown"
									? "Unknown"
									: data.completeness === "known-empty"
										? "Known empty"
										: "Complete"}
								. Last success:{" "}
								{data.last_success_at
									? new Date(data.last_success_at).toLocaleString()
									: "Never"}
								.
							</p>
							{data.last_error && (
								<p role="status" className="text-sm text-muted-foreground">
									{data.last_error}
								</p>
							)}
							<div>
								<h3 className="font-medium">Discovered models</h3>
								{data.discovered_ids.length ? (
									<ul className="max-h-40 overflow-auto text-sm font-mono">
										{data.discovered_ids.map((id) => (
											<li key={id}>{id}</li>
										))}
									</ul>
								) : (
									<p className="text-sm text-muted-foreground">
										No discovered models.
									</p>
								)}
								<p className="text-sm text-muted-foreground">
									Refresh replaces this list. Manual additions remain separate.
								</p>
							</div>
							<label className="block">
								Manual additions
								<textarea
									className="w-full rounded-md border bg-background p-2 font-mono text-sm"
									rows={5}
									placeholder="One exact upstream model ID per line"
									value={draft?.text ?? data.manual_ids.join("\n")}
									onChange={(e) =>
										setDraft({
											text: e.target.value,
											generation: draft?.generation ?? data.generation,
										})
									}
								/>
							</label>
							<p className="text-sm text-muted-foreground">
								Removing a manual addition does not remove a model still
								advertised by discovery. Unknown discovery allows only manual
								additions or an explicit account-and-literal routing rule.
							</p>
							{data.last_success_at === null &&
								!(draft?.text ?? data.manual_ids.join("\n")).trim() && (
									<label className="flex gap-2 text-sm">
										<input
											type="checkbox"
											checked={declareEmpty}
											onChange={(e) => setDeclareEmpty(e.target.checked)}
										/>
										Declare this account's permitted model set empty
									</label>
								)}
							{mutation.error && <p role="alert">{mutation.error.message}</p>}
							<div className="flex gap-2">
								<Button
									variant="outline"
									disabled={mutation.isPending}
									onClick={() => mutation.mutate(true)}
								>
									Refresh discovery
								</Button>
								<Button
									disabled={mutation.isPending}
									onClick={() => mutation.mutate(false)}
								>
									Save manual models
								</Button>
							</div>
						</div>
					)
				)}
			</DialogContent>
		</Dialog>
	);
}
