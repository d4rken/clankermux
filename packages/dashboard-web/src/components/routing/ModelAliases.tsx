import type {
	ClientSuggestions,
	ModelAlias,
	ModelAliasTarget,
} from "@clankermux/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { api } from "../../api";
import { useAccounts } from "../../hooks/queries";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { SectionHeading } from "../ui/section-heading";

export const modelAliasesKey = ["model-aliases"];
export function useModelAliases() {
	return useQuery({
		queryKey: modelAliasesKey,
		queryFn: () => api.get<{ data: ModelAlias[] }>("/api/model-aliases"),
		select: ({ data }) => ({
			data: [...data].sort(
				(a, b) =>
					a.displayName.localeCompare(b.displayName) ||
					a.id.localeCompare(b.id),
			),
		}),
	});
}
export function ModelAliases() {
	const client = useQueryClient();
	const aliases = useModelAliases();
	const accounts = useAccounts();
	const [draft, setDraft] = useState<ModelAlias | null>(null);
	const suggestionsId = useId();
	const suggestions = useQuery({
		queryKey: ["model-alias-suggestions"],
		queryFn: () =>
			api.post<{ data: ClientSuggestions }>("/api/clients/suggestions", {
				destinations: { accountId: null, providers: null },
				refresh: false,
			}),
		enabled: draft !== null,
	});
	const mutation = useMutation({
		mutationFn: async ({
			alias,
			remove,
		}: {
			alias: ModelAlias;
			remove?: boolean;
		}) => {
			const path = `/api/model-aliases/${encodeURIComponent(alias.id)}`;
			if (remove)
				return api.delete(path, {
					body: JSON.stringify({ revision: alias.revision }),
					headers: { "Content-Type": "application/json" },
				});
			return alias.revision
				? api.put(path, alias)
				: api.post("/api/model-aliases", alias);
		},
		onError: () => {
			client.invalidateQueries({ queryKey: modelAliasesKey });
		},
		onSuccess: () => {
			setDraft(null);
			client.invalidateQueries({ queryKey: modelAliasesKey });
			client.invalidateQueries({ queryKey: ["clients"] });
		},
	});
	const edit = (alias: ModelAlias) => {
		mutation.reset();
		setDraft(structuredClone(alias));
	};
	const patchTarget = (index: number, value: Partial<ModelAliasTarget>) => {
		if (draft)
			setDraft({
				...draft,
				targets: draft.targets.map((target, i) =>
					i === index ? { ...target, ...value } : target,
				),
			});
	};
	const move = (index: number, delta: number) => {
		if (!draft) return;
		const targets = [...draft.targets];
		const target = targets[index];
		const other = targets[index + delta];
		if (!target || !other) return;
		targets[index] = other;
		targets[index + delta] = target;
		setDraft({ ...draft, targets });
	};
	return (
		<section className="space-y-4" aria-label="Model aliases">
			<div className="flex items-center justify-between gap-4">
				<SectionHeading
					title="Model aliases"
					description="Reusable model choices with ordered fallbacks. Publish them through the Clients model editor or select them in a routing rule."
				/>
				<Button
					onClick={() =>
						edit({
							id: "alias:",
							displayName: "",
							targets: [{ model: "", accountIds: null }],
							revision: 0,
						})
					}
				>
					Add alias
				</Button>
			</div>
			<p className="text-sm text-muted-foreground">
				Each target exhausts its eligible accounts before the next model is
				tried for quota exhaustion or temporary unavailability. Client and
				routing destination restrictions always apply. Fallback stops once
				output begins.
			</p>
			{aliases.isPending ? (
				<p>Loading model aliases…</p>
			) : aliases.error ? (
				<p role="alert">{aliases.error.message}</p>
			) : !aliases.data?.data.length ? (
				<p>No model aliases yet.</p>
			) : (
				<ul className="space-y-3">
					{aliases.data.data.map((alias) => (
						<li
							key={alias.id}
							className="rounded-lg border p-4 flex flex-wrap items-center gap-3"
						>
							<div className="grow">
								<strong>{alias.displayName}</strong>
								<p className="text-sm">
									<code>{alias.id}</code>
								</p>
								<ol className="list-decimal pl-5 text-sm text-muted-foreground">
									{alias.targets.map((target) => (
										<li key={target.model}>
											{target.model} ·{" "}
											{target.accountIds === null
												? "All eligible accounts"
												: target.accountIds
														.map(
															(id) =>
																accounts.data?.find((a) => a.id === id)?.name ??
																id,
														)
														.join(", ")}
										</li>
									))}
								</ol>
							</div>
							<Button
								variant="outline"
								disabled={mutation.isPending}
								aria-label={`Edit ${alias.displayName}`}
								onClick={() => edit(alias)}
							>
								Edit
							</Button>
							<Button
								variant="destructive"
								disabled={mutation.isPending}
								aria-label={`Delete ${alias.displayName}`}
								onClick={() => mutation.mutate({ alias, remove: true })}
							>
								Delete
							</Button>
						</li>
					))}
				</ul>
			)}
			{mutation.error && !draft && <p role="alert">{mutation.error.message}</p>}
			<Dialog
				open={draft !== null}
				onOpenChange={(open) => {
					if (!open && !mutation.isPending) setDraft(null);
				}}
			>
				<DialogContent className="max-h-[90vh] overflow-auto">
					<DialogHeader>
						<DialogTitle>
							{draft?.revision ? "Edit model alias" : "Add model alias"}
						</DialogTitle>
						<DialogDescription>
							Targets must be concrete model IDs. Their order controls fallback.
							Changes affect every client publishing this alias.
						</DialogDescription>
					</DialogHeader>
					{draft && (
						<form
							className="space-y-4"
							onSubmit={(e) => {
								e.preventDefault();
								mutation.mutate({ alias: draft });
							}}
						>
							<fieldset disabled={mutation.isPending} className="space-y-4">
								<label className="block" htmlFor="alias-id">
									Alias ID
									<Input
										id="alias-id"
										required
										pattern="alias:[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}"
										disabled={draft.revision > 0}
										value={draft.id}
										onChange={(e) => setDraft({ ...draft, id: e.target.value })}
										placeholder="alias:good-model"
									/>
								</label>
								<label className="block" htmlFor="alias-name">
									Display name
									<Input
										id="alias-name"
										required
										maxLength={256}
										value={draft.displayName}
										onChange={(e) =>
											setDraft({ ...draft, displayName: e.target.value })
										}
									/>
								</label>
								{suggestions.isPending ? (
									<p role="status" className="text-sm text-muted-foreground">
										Loading model suggestions…
									</p>
								) : suggestions.isError ? (
									<p role="status" className="text-sm text-muted-foreground">
										Model suggestions unavailable. You can still enter a model
										ID.
									</p>
								) : null}
								{draft.targets.map((target, index) => (
									<fieldset
										// biome-ignore lint/suspicious/noArrayIndexKey: controlled rows represent positions in the target order
										key={index}
										className="space-y-3 rounded-md border p-3"
									>
										<legend>
											{index === 0 ? "Preferred target" : `Fallback ${index}`}
										</legend>
										<label className="block" htmlFor={`alias-target-${index}`}>
											Concrete model ID
											<Input
												id={`alias-target-${index}`}
												list={`${suggestionsId}-${index}`}
												autoComplete="off"
												required
												maxLength={256}
												pattern="(?!alias:).*"
												value={target.model}
												onChange={(e) =>
													patchTarget(index, { model: e.target.value })
												}
											/>
										</label>
										<datalist id={`${suggestionsId}-${index}`}>
											{suggestions.data?.data.models
												.filter(
													(model) =>
														!model.id.startsWith("alias:") &&
														(target.accountIds === null ||
															model.accountIds.some((id) =>
																target.accountIds?.includes(id),
															)),
												)
												.map((model) => (
													<option key={model.id} value={model.id}>
														{model.displayName}
													</option>
												))}
										</datalist>
										<label className="flex gap-2 text-sm">
											<input
												type="checkbox"
												checked={target.accountIds === null}
												onChange={(e) =>
													patchTarget(index, {
														accountIds: e.target.checked ? null : [],
													})
												}
											/>
											All eligible accounts
										</label>
										{target.accountIds !== null && (
											<div className="space-y-1">
												{accounts.error && (
													<p role="alert">{accounts.error.message}</p>
												)}
												{[
													...(accounts.data ?? []).map((a) => ({
														id: a.id,
														name: `${a.name} (${a.provider})`,
													})),
													...target.accountIds
														.filter(
															(id) => !accounts.data?.some((a) => a.id === id),
														)
														.map((id) => ({
															id,
															name: `${id} (missing account)`,
														})),
												].map((a) => (
													<label key={a.id} className="flex gap-2 text-sm">
														<input
															type="checkbox"
															checked={target.accountIds?.includes(a.id)}
															onChange={(e) =>
																patchTarget(index, {
																	accountIds: e.target.checked
																		? [...(target.accountIds ?? []), a.id]
																		: (target.accountIds?.filter(
																				(id) => id !== a.id,
																			) ?? []),
																})
															}
														/>
														{a.name}
													</label>
												))}
												{target.accountIds.length === 0 && (
													<p className="text-sm">
														Select at least one account.
													</p>
												)}
											</div>
										)}
										<div className="flex gap-2">
											<Button
												type="button"
												variant="outline"
												aria-label={`Move target ${index + 1} up`}
												disabled={index === 0}
												onClick={() => move(index, -1)}
											>
												↑
											</Button>
											<Button
												type="button"
												variant="outline"
												aria-label={`Move target ${index + 1} down`}
												disabled={index === draft.targets.length - 1}
												onClick={() => move(index, 1)}
											>
												↓
											</Button>
											<Button
												type="button"
												variant="outline"
												aria-label={`Remove target ${index + 1}`}
												disabled={draft.targets.length === 1}
												onClick={() =>
													setDraft({
														...draft,
														targets: draft.targets.filter(
															(_, i) => i !== index,
														),
													})
												}
											>
												Remove
											</Button>
										</div>
									</fieldset>
								))}
								<Button
									type="button"
									variant="outline"
									disabled={draft.targets.length >= 16}
									onClick={() =>
										setDraft({
											...draft,
											targets: [
												...draft.targets,
												{ model: "", accountIds: null },
											],
										})
									}
								>
									Add fallback
								</Button>
							</fieldset>
							{mutation.error && (
								<p role="alert">
									{mutation.error.message} Close and reopen the editor to load
									the latest saved version.
								</p>
							)}
							<Button
								type="submit"
								disabled={
									mutation.isPending ||
									draft.targets.some((t) => t.accountIds?.length === 0)
								}
							>
								{mutation.isPending ? "Saving…" : "Save alias"}
							</Button>
						</form>
					)}
				</DialogContent>
			</Dialog>
		</section>
	);
}
