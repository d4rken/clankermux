/** A concrete backend and its optional account restriction. */
export interface ModelAliasTarget {
	model: string;
	/** Null inherits the request's eligible destinations; an array restricts them. */
	accountIds: string[] | null;
}

/** An explicitly variable model choice with ordered exhaustion fallbacks. */
export interface ModelAlias {
	/** Stable public identity in the reserved `alias:` namespace. */
	id: string;
	displayName: string;
	targets: ModelAliasTarget[];
	/** Optimistic edit precondition; use zero to create an alias. */
	revision: number;
}
