import type { ApiKeyResponse } from "./api-key";
import type { RoutingRule } from "./routing";

export type ClientApplication =
	| "generic"
	| "claude-code"
	| "codex"
	| "opencode"
	| "oh-my-pi"
	| "pi";
export type ClientFormat = "anthropic" | "openai" | "codex";
export interface ClientModel {
	id: string;
	displayName: string;
	targetModel: string;
	accountIds: string[] | null;
	createdAt?: string;
	codexMetadata?: Record<string, unknown>;
	metadataCapturedAt?: number;
	metadataScope?: string;
}
export interface ClientCatalogue {
	models: ClientModel[];
	defaultModel: string | null;
	envelope?: Record<string, unknown>;
}
export interface ClientProfile {
	apiKeyId: string;
	application: ClientApplication;
	revision: number;
	catalogues: Record<ClientFormat, ClientCatalogue>;
	notices: string[];
}
export interface ClientDestinations {
	accountId: string | null;
	providers: string[] | null;
}
export interface ClientDraft {
	id?: string;
	revision?: number;
	name: string;
	application: ClientApplication;
	destinations: ClientDestinations;
	catalogues: Record<ClientFormat, ClientCatalogue>;
}
export interface ClientView extends ClientProfile {
	key: ApiKeyResponse;
	aliasRules: RoutingRule[];
}
export interface ClientSuggestion {
	id: string;
	displayName: string;
	accountIds: string[];
	codexMetadataAvailable: boolean;
}
export interface ClientSuggestions {
	models: ClientSuggestion[];
	accounts: Array<{
		id: string;
		name: string;
		provider: string;
		completeness: "unknown" | "known-complete" | "known-empty";
		error: string | null;
	}>;
}
export interface ClientReview {
	token: string;
	draft: ClientDraft;
	aliasRules: RoutingRule[];
	precedingRules: string[];
	notices: string[];
}
