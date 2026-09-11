import type { ApiKeyResponse, RoutingRule } from "@clankermux/types";
import { PROVIDER_NAMES } from "@clankermux/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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
import {
	changeRulePool,
	changeRuleTarget,
	newRoutingRule,
} from "./routing-editor";

const control = "w-full rounded-md border bg-background p-2 text-sm";
const rulesKey = ["routing-rules"];
export function RoutingTab() {
	const client = useQueryClient();
	const rules = useQuery({
		queryKey: rulesKey,
		queryFn: () => api.get<{ data: RoutingRule[] }>("/api/routing-rules"),
	});
	const accounts = useAccounts();
	const keys = useQuery({
		queryKey: ["api-keys"],
		queryFn: () => api.get<{ data: ApiKeyResponse[] }>("/api/api-keys"),
	});
	const [draft, setDraft] = useState<RoutingRule | null>(null);
	const mutate = useMutation({
		mutationFn: async (op: {
			method: "save" | "delete" | "order";
			rule?: RoutingRule;
			ids?: string[];
		}) => {
			if (op.method === "order")
				return api.put("/api/routing-rules/reorder", { ids: op.ids });
			if (!op.rule) throw new Error("Missing rule");
			if (op.method === "delete")
				return api.delete(
					`/api/routing-rules/${encodeURIComponent(op.rule.id)}`,
				);
			return op.rule.id
				? api.put(
						`/api/routing-rules/${encodeURIComponent(op.rule.id)}`,
						op.rule,
					)
				: api.post("/api/routing-rules", op.rule);
		},
		onSuccess: () => {
			setDraft(null);
			client.invalidateQueries({ queryKey: rulesKey });
		},
	});
	const rows = rules.data?.data ?? [];
	const move = (index: number, delta: number) => {
		const ids = rows.map((r) => r.id);
		const next = index + delta;
		const current = ids[index];
		const other = ids[next];
		if (current === undefined || other === undefined) return;
		ids[index] = other;
		ids[next] = current;
		mutate.mutate({ method: "order", ids });
	};
	const patch = (value: Partial<RoutingRule>) =>
		setDraft(draft ? { ...draft, ...value } : null);
	return (
		<div className="space-y-section">
			<div className="flex items-center justify-between">
				<SectionHeading
					title="Routing"
					description="The first enabled rule matching the API key and requested model wins. API key destinations always constrain the result."
				/>
				<Button
					onClick={() => {
						mutate.reset();
						setDraft(
							newRoutingRule(Math.max(-1, ...rows.map((r) => r.position)) + 1),
						);
					}}
				>
					Add rule
				</Button>
			</div>
			<div className="rounded-lg border p-4 space-y-2 text-sm">
				<p>
					Without a matching rule, API key destinations apply and the requested
					model is sent unchanged.
				</p>
				<p>
					Nothing else rewrites a model ID. To send a different model, add a
					rule with a literal target.
				</p>
				<p>Each account must permit the model it is sent.</p>
			</div>
			{rules.isPending ? (
				<p>Loading routing rules…</p>
			) : rules.error ? (
				<p role="alert">{rules.error.message}</p>
			) : rows.length === 0 ? (
				<p>No routing rules yet. Requested models are sent unchanged.</p>
			) : (
				<ol className="space-y-3">
					{rows.map((r, i) => (
						<li
							key={r.id}
							className="rounded-lg border p-4 flex flex-wrap items-center gap-3"
						>
							<div className="grow">
								<strong>
									{i + 1}. {r.name}
								</strong>
								<p className="text-sm text-muted-foreground">
									{r.enabled ? "Enabled" : "Disabled"} ·{" "}
									{r.match_api_key_id
										? (keys.data?.data.find((k) => k.id === r.match_api_key_id)
												?.name ?? "Missing key")
										: "Any API key"}{" "}
									·{" "}
									{r.match_model_kind === "any"
										? "Any model"
										: r.match_model_value}
								</p>
								<p className="text-sm">
									{r.pool_kind === "inherit"
										? "Inherit allowed destinations"
										: r.pool_kind === "provider"
											? r.pool_provider
											: r.pool_account_ids
													?.map(
														(id) =>
															accounts.data?.find((a) => a.id === id)?.name ??
															"Missing account",
													)
													.join(", ")}{" "}
									→{" "}
									{r.target_kind === "literal"
										? r.target_model
										: "Requested model"}
								</p>
							</div>
							<Button
								variant="outline"
								disabled={i === 0 || mutate.isPending}
								onClick={() => move(i, -1)}
								aria-label={`Move ${r.name} up`}
							>
								↑
							</Button>
							<Button
								variant="outline"
								disabled={i === rows.length - 1 || mutate.isPending}
								onClick={() => move(i, 1)}
								aria-label={`Move ${r.name} down`}
							>
								↓
							</Button>
							<Button
								variant="outline"
								onClick={() => {
									mutate.reset();
									setDraft({ ...r });
								}}
							>
								Edit
							</Button>
							<Button
								variant="outline"
								disabled={mutate.isPending}
								onClick={() =>
									mutate.mutate({
										method: "save",
										rule: { ...r, enabled: !r.enabled },
									})
								}
							>
								{r.enabled ? "Disable" : "Enable"}
							</Button>
							<Button
								variant="destructive"
								disabled={mutate.isPending}
								onClick={() => mutate.mutate({ method: "delete", rule: r })}
							>
								Delete
							</Button>
						</li>
					))}
				</ol>
			)}
			{mutate.error && !draft && <p role="alert">{mutate.error.message}</p>}
			<Dialog
				open={draft !== null}
				onOpenChange={(open) => {
					if (!open) setDraft(null);
				}}
			>
				<DialogContent className="max-h-[90vh] overflow-auto">
					<DialogHeader>
						<DialogTitle>
							{draft?.id ? "Edit routing rule" : "Add routing rule"}
						</DialogTitle>
						<DialogDescription>
							Rules narrow allowed destinations. An empty eligible pool fails;
							it never falls through to a later rule.
						</DialogDescription>
					</DialogHeader>
					{draft && (
						<form
							className="space-y-4"
							onSubmit={(e) => {
								e.preventDefault();
								mutate.mutate({ method: "save", rule: draft });
							}}
						>
							<label className="block" htmlFor="route-name">
								Name
								<Input
									id="route-name"
									required
									value={draft.name}
									onChange={(e) => patch({ name: e.target.value })}
								/>
							</label>
							<label className="block">
								API key
								<select
									className={control}
									value={draft.match_api_key_id ?? ""}
									onChange={(e) =>
										patch({ match_api_key_id: e.target.value || null })
									}
								>
									<option value="">Any API key</option>
									{keys.data?.data.map((k) => (
										<option value={k.id} key={k.id}>
											{k.name}
										</option>
									))}
								</select>
							</label>
							<label className="block">
								Requested model
								<select
									className={control}
									value={draft.match_model_kind}
									onChange={(e) => {
										const kind = e.target
											.value as RoutingRule["match_model_kind"];
										patch({
											match_model_kind: kind,
											match_model_value:
												kind === "any"
													? null
													: kind === "family"
														? "anthropic:fable"
														: "",
										});
									}}
								>
									<option value="any">Any model</option>
									<option value="exact">Exact model ID</option>
									<option value="family">Claude family</option>
								</select>
							</label>
							{draft.match_model_kind === "exact" && (
								<label className="block" htmlFor="route-exact-model">
									Exact model ID
									<Input
										id="route-exact-model"
										required
										value={draft.match_model_value ?? ""}
										onChange={(e) =>
											patch({ match_model_value: e.target.value })
										}
									/>
								</label>
							)}
							{draft.match_model_kind === "family" && (
								<label className="block">
									Family
									<select
										className={control}
										value={draft.match_model_value ?? ""}
										onChange={(e) =>
											patch({ match_model_value: e.target.value })
										}
									>
										{["fable", "opus", "sonnet", "haiku"].map((f) => (
											<option key={f} value={`anthropic:${f}`}>
												{f === "fable" ? "Fable / Mythos" : f}
											</option>
										))}
									</select>
								</label>
							)}
							<label className="block">
								Destination pool
								<select
									className={control}
									value={draft.pool_kind}
									onChange={(e) =>
										setDraft(
											changeRulePool(
												draft,
												e.target.value as RoutingRule["pool_kind"],
											),
										)
									}
								>
									<option value="inherit">Inherit API key destinations</option>
									<option value="provider">One provider</option>
									<option value="accounts">Specific accounts</option>
								</select>
							</label>
							{draft.pool_kind === "provider" && (
								<label className="block">
									Provider
									<select
										className={control}
										value={draft.pool_provider ?? ""}
										onChange={(e) => patch({ pool_provider: e.target.value })}
									>
										{Object.values(PROVIDER_NAMES).map((p) => (
											<option key={p} value={p}>
												{p}
											</option>
										))}
									</select>
								</label>
							)}
							{draft.pool_kind === "accounts" && (
								<fieldset>
									<legend>Accounts</legend>
									{(accounts.data ?? []).map((a) => (
										<label key={a.id} className="flex gap-2">
											<input
												type="checkbox"
												checked={
													draft.pool_account_ids?.includes(a.id) ?? false
												}
												onChange={(e) =>
													patch({
														pool_account_ids: e.target.checked
															? [...(draft.pool_account_ids ?? []), a.id]
															: (draft.pool_account_ids ?? []).filter(
																	(id) => id !== a.id,
																),
													})
												}
											/>
											{a.name} ({a.provider})
										</label>
									))}
								</fieldset>
							)}
							<label className="block">
								Target model
								<select
									className={control}
									value={draft.target_kind}
									onChange={(e) =>
										setDraft(
											changeRuleTarget(
												draft,
												e.target.value as RoutingRule["target_kind"],
											),
										)
									}
								>
									<option value="literal">Literal model ID</option>
									<option value="requested">Keep requested model</option>
								</select>
							</label>
							{draft.target_kind === "literal" && (
								<label className="block" htmlFor="route-target-model">
									Upstream model ID
									<Input
										id="route-target-model"
										required
										value={draft.target_model ?? ""}
										onChange={(e) => patch({ target_model: e.target.value })}
									/>
								</label>
							)}
							{draft.pool_kind === "accounts" &&
								draft.target_kind === "literal" && (
									<p className="text-sm text-muted-foreground">
										This explicitly asserts the selected account/model pairs
										while discovery is unknown. A known model list still takes
										precedence.
									</p>
								)}
							{mutate.error && <p role="alert">{mutate.error.message}</p>}
							<Button type="submit" disabled={mutate.isPending}>
								{mutate.isPending ? "Saving…" : "Save rule"}
							</Button>
						</form>
					)}
				</DialogContent>
			</Dialog>
		</div>
	);
}
