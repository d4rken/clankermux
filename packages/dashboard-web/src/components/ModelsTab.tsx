import type { ModelDialect } from "@clankermux/types";
import { useState } from "react";
import { ModelDialectPanel } from "./models/ModelDialectPanel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

/**
 * The models each mount advertises on `GET /v1/models`, and what to change
 * about them.
 *
 * Curated PER DIALECT, and the tabs say so rather than presenting one list with
 * a filter: the two mounts serve different clients different shapes from
 * different upstreams, and an entry hidden for the Codex CLI has no bearing on
 * what Claude Code is shown. A single merged list would have to invent a rule
 * for that, and any rule it invented would be wrong for one of them.
 *
 * The page renders no heading of its own — the app shell prints the route's
 * title above it.
 */
export function ModelsTab() {
	const [dialect, setDialect] = useState<ModelDialect>("anthropic");

	return (
		<div className="space-y-section">
			<Tabs
				value={dialect}
				onValueChange={(value) => setDialect(value as ModelDialect)}
			>
				<TabsList>
					<TabsTrigger value="anthropic">/wire/anthropic</TabsTrigger>
					<TabsTrigger value="openai">/wire/openai</TabsTrigger>
				</TabsList>
				<TabsContent value="anthropic" className="mt-group">
					<ModelDialectPanel dialect="anthropic" />
				</TabsContent>
				<TabsContent value="openai" className="mt-group">
					<ModelDialectPanel dialect="openai" />
				</TabsContent>
			</Tabs>
		</div>
	);
}
