import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Account } from "../../api";
import {
	AccountIdentityLine,
	AccountIdentityPanel,
	formatIdentityPlanLabel,
} from "./AccountIdentity";

const EXTERNAL_ID = "a1b2c3d4-5e6f-7890-abcd-ef0123456789";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "a1",
		name: "Backup1",
		provider: "anthropic",
		requestCount: 0,
		totalRequests: 0,
		lastUsed: null,
		created: "2024-01-01T00:00:00Z",
		paused: false,
		tokenStatus: "valid",
		tokenExpiresAt: null,
		rateLimitStatus: "OK",
		rateLimitReset: null,
		rateLimitRemaining: null,
		rateLimitedUntil: null,
		rateLimitedReason: null,
		rateLimitedAt: null,
		sessionInfo: "No active session",
		priority: 0,
		autoFallbackEnabled: false,
		autoRefreshEnabled: false,
		customEndpoint: null,
		modelMappings: null,
		usageUtilization: null,
		usageWindow: null,
		usageData: null,
		usageRateLimitedUntil: null,
		usageThrottledUntil: null,
		usageThrottledWindows: [],
		hasRefreshToken: true,
		notes: null,
		sessionStats: null,
		isPrimary: false,
		identityExternalId: null,
		identityEmail: null,
		identityOrganizationName: null,
		identityPlanTier: null,
		identityRateLimitTier: null,
		identityCapturedAt: null,
		identityProfileFetchedAt: null,
		isDuplicateAccount: false,
		duplicateAccountIds: [],
		...overrides,
	};
}

describe("formatIdentityPlanLabel", () => {
	it("joins a Title-cased plan tier with the rate-limit multiplier", () => {
		expect(
			formatIdentityPlanLabel(
				makeAccount({ identityPlanTier: "max", identityRateLimitTier: "20x" }),
			),
		).toBe("Max 20x");
	});

	it("Title-cases a plan tier on its own", () => {
		expect(
			formatIdentityPlanLabel(makeAccount({ identityPlanTier: "max" })),
		).toBe("Max");
	});

	it("shows the multiplier alone when the plan tier is unknown", () => {
		expect(
			formatIdentityPlanLabel(makeAccount({ identityRateLimitTier: "20x" })),
		).toBe("20x");
	});

	it("returns null when neither is captured", () => {
		expect(formatIdentityPlanLabel(makeAccount())).toBeNull();
	});
});

describe("AccountIdentityLine", () => {
	it("joins email, organization and plan in that order", () => {
		const html = renderToStaticMarkup(
			<AccountIdentityLine
				account={makeAccount({
					identityEmail: "ops@example.com",
					identityOrganizationName: "Acme Inc",
					identityPlanTier: "max",
					identityRateLimitTier: "20x",
				})}
			/>,
		);
		expect(html).toContain("ops@example.com · Acme Inc · Max 20x");
	});

	it("puts separators only between the parts that are present", () => {
		const html = renderToStaticMarkup(
			<AccountIdentityLine
				account={makeAccount({
					identityEmail: "ops@example.com",
					identityPlanTier: "pro",
				})}
			/>,
		);
		expect(html).toContain("ops@example.com · Pro");
		expect(html).not.toContain("· ·");
		expect(html).not.toContain(">·");
	});

	it("renders the id alone when only the external id was captured", () => {
		const html = renderToStaticMarkup(
			<AccountIdentityLine
				account={makeAccount({ identityExternalId: EXTERNAL_ID })}
			/>,
		);
		expect(html).toContain("#a1b2c3d4");
		expect(html).not.toContain("·");
	});

	it("renders nothing when no identity field is captured", () => {
		expect(
			renderToStaticMarkup(<AccountIdentityLine account={makeAccount()} />),
		).toBe("");
	});

	it("shortens the external id and exposes the full id as a title by default", () => {
		const html = renderToStaticMarkup(
			<AccountIdentityLine
				account={makeAccount({
					identityEmail: "ops@example.com",
					identityExternalId: EXTERNAL_ID,
				})}
			/>,
		);
		expect(html).toContain("#a1b2c3d4<");
		expect(html).not.toContain(`#${EXTERNAL_ID}`);
		expect(html).toContain(`title="Account ID: ${EXTERNAL_ID}"`);
	});

	it("renders the full external id and no title in full mode", () => {
		const html = renderToStaticMarkup(
			<AccountIdentityLine
				account={makeAccount({
					identityEmail: "ops@example.com",
					identityExternalId: EXTERNAL_ID,
				})}
				externalIdDisplay="full"
			/>,
		);
		expect(html).toContain(`#${EXTERNAL_ID}`);
		expect(html).not.toContain("title=");
	});

	it("keeps the base classes and merges the caller className", () => {
		const html = renderToStaticMarkup(
			<AccountIdentityLine
				account={makeAccount({ identityEmail: "ops@example.com" })}
				className="truncate"
			/>,
		);
		expect(html).toContain("text-xs");
		expect(html).toContain("text-muted-foreground");
		expect(html).toContain("truncate");
	});
});

describe("AccountIdentityPanel", () => {
	it("renders the account name above the identity line", () => {
		const html = renderToStaticMarkup(
			<AccountIdentityPanel
				account={makeAccount({
					name: "Backup1",
					identityEmail: "ops@example.com",
					identityExternalId: EXTERNAL_ID,
				})}
			/>,
		);
		expect(html).toContain("Backup1");
		expect(html).toContain("ops@example.com");
		// The dialog is the surface whose purpose is identification: the id is
		// shown in full rather than hidden behind a hover-only tooltip.
		expect(html).toContain(`#${EXTERNAL_ID}`);
		expect(html).not.toContain("title=");
	});

	it("renders the name even for an account with no captured identity", () => {
		const html = renderToStaticMarkup(
			<AccountIdentityPanel account={makeAccount({ name: "QwenBox" })} />,
		);
		expect(html).toContain("QwenBox");
	});

	it("renders nothing without an account", () => {
		expect(renderToStaticMarkup(<AccountIdentityPanel account={null} />)).toBe(
			"",
		);
	});
});
