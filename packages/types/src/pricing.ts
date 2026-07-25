/**
 * Why a pricing lookup failed for a model.
 *
 * - `model_missing` — the model id is not in the pricing catalogue at all
 *   (bundled table + models.dev), e.g. a brand-new model released before its
 *   entry was added.
 * - `cost_missing` — the model IS in the catalogue but the rate the request
 *   needed (input/output/cache_read/cache_write) is absent, so the entry is
 *   present but incomplete.
 *
 * Both collapse the whole request cost to 0 (persisted as NULL), so both are
 * reported. They differ only in remediation: add the entry vs. complete it.
 */
export type PricingGapReason = "model_missing" | "cost_missing";

/**
 * A model whose cost could not be computed, aggregated per (provider, model).
 *
 * Cumulative since process start: an entry is never retracted after a later
 * successful lookup, because a successful input-only estimate does not prove
 * that e.g. `cache_write` is present. The normal remediation (add pricing,
 * redeploy) restarts the process, which clears the registry.
 *
 * `modelId` originates from client-controlled request bodies, so it is
 * sanitized (control characters stripped) and truncated before it is recorded.
 */
export interface PricingGap {
	/**
	 * Stable identity of this entry: the full sha256 digest of the ORIGINAL,
	 * untruncated `(provider, modelId)` pair.
	 *
	 * `modelId` and `provider` are display labels — sanitized and clipped — so two
	 * genuinely different entries can carry an identical-looking pair. This is the
	 * only field guaranteed unique across the list, so it is what a UI keys rows
	 * on.
	 */
	key: string;
	/**
	 * Short, human-comparable form of {@link key} (its leading hex characters).
	 *
	 * Server-derived from the entry digest and carried in its OWN field so a UI can
	 * render it as its own element, structurally separate from the labels. That
	 * separation is the point: the fingerprint used to be appended into
	 * {@link modelId}, and because that string is client-controlled, a client could
	 * read an altered row and submit its rendered text (` #<hex>` and all) as its
	 * own model id — producing a second row that LOOKED identically fingerprinted.
	 * A value the client cannot write, rendered in a node the label cannot reach,
	 * cannot be impersonated by any model text.
	 */
	fingerprint: string;
	/**
	 * Sanitized, truncated model id as seen on the request — a pure display label.
	 *
	 * Never doctored: whatever distinguishes two rows lives in {@link fingerprint}
	 * and {@link key}, never inside this client-controlled text.
	 */
	modelId: string;
	/** Account provider the request was served by (`unknown` if unattributed). */
	provider: string;
	reason: PricingGapReason;
	/** How many pricing failures were observed for this (provider, model). */
	occurrences: number;
	/** Epoch ms of the first observed failure. */
	firstSeenAt: number;
	/** Epoch ms of the most recent observed failure. */
	lastSeenAt: number;
}
