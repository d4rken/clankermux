// MUST be the first import: `react-dom/client` inspects the DOM globals when it
// loads, and this module installs them (see test-utils/happy-dom).
import "../../test-utils/happy-dom";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import type { ComponentType } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Account } from "../../api";
import { unregisterDom } from "../../test-utils/happy-dom";
import { AnthropicReauthDialog } from "./AnthropicReauthDialog";
import { CodexReauthDialog } from "./CodexReauthDialog";
import { QwenReauthDialog } from "./QwenReauthDialog";

/**
 * Wiring test: `AccountIdentity.test.tsx` proves the panel renders, not that the
 * re-auth dialogs mount it — and mounting it is the entire point of the change.
 * Radix renders `DialogContent` through a portal, so `renderToStaticMarkup`
 * cannot see it; these dialogs have to be mounted for real against a DOM.
 *
 * No `api` mocking: nothing is fetched until "Start Re-authentication" is
 * clicked, and these tests never click it.
 */

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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
		identityExternalId: EXTERNAL_ID,
		identityEmail: "ops@example.com",
		identityOrganizationName: "Acme Inc",
		identityPlanTier: "max",
		identityRateLimitTier: "20x",
		identityCapturedAt: 1_700_000_000_000,
		identityProfileFetchedAt: 1_700_000_000_000,
		isDuplicateAccount: false,
		duplicateAccountIds: [],
		...overrides,
	};
}

interface ReauthDialogProps {
	account: Account | null;
	isOpen: boolean;
	onClose: () => void;
	onSuccess: () => void;
}

const DIALOGS: Array<[string, ComponentType<ReauthDialogProps>, string]> = [
	["AnthropicReauthDialog", AnthropicReauthDialog, "anthropic"],
	["CodexReauthDialog", CodexReauthDialog, "codex"],
	["QwenReauthDialog", QwenReauthDialog, "qwen"],
];

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(
	Dialog: ComponentType<ReauthDialogProps>,
	account: Account | null,
): Promise<void> {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(
			<Dialog
				account={account}
				isOpen={true}
				onClose={() => {}}
				onSuccess={() => {}}
			/>,
		);
	});
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	host?.remove();
	host = null;
});

afterAll(async () => {
	await unregisterDom();
});

describe.each(DIALOGS)("%s — account identity", (_name, Dialog, provider) => {
	it("shows the identity of the account being re-authenticated", async () => {
		await mount(Dialog, makeAccount({ provider }));
		const text = document.body.textContent ?? "";

		expect(text).toContain("Backup1");
		expect(text).toContain("ops@example.com");
		expect(text).toContain("Acme Inc");
		expect(text).toContain("Max 20x");
		// Full id, not the 8-char prefix: a hover tooltip is unreachable by
		// keyboard and touch, and this dialog exists to identify the account.
		expect(text).toContain(`#${EXTERNAL_ID}`);
		expect(text).toContain(
			"All account metadata (usage stats, priority, settings) will be preserved.",
		);
	});

	it("keeps the description sentence when there is no account", async () => {
		await mount(Dialog, null);
		const text = document.body.textContent ?? "";

		expect(text).toContain(
			"All account metadata (usage stats, priority, settings) will be preserved.",
		);
		expect(text).not.toContain("ops@example.com");
	});
});
