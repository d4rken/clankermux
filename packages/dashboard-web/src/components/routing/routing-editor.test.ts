import { expect, it } from "bun:test";
import { validateRoutingRule } from "@clankermux/core";
import {
	changeRulePool,
	changeRuleTarget,
	newRoutingRule,
} from "./routing-editor";

it("switching editor modes removes hidden fields before saving", () => {
	const r = {
		...newRoutingRule(0),
		id: "r",
		name: "Example",
		pool_kind: "accounts" as const,
		pool_account_ids: ["a"],
		target_kind: "literal" as const,
		target_model: "target",
	};
	const changed = changeRuleTarget(changeRulePool(r, "inherit"), "requested");
	expect(() => validateRoutingRule(changed)).not.toThrow();
	expect(changed.pool_account_ids).toBeNull();
	expect(changed.target_model).toBeNull();
});
