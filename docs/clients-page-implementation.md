# Clients page implementation

Release candidate: `2026.9.52`. Implemented on `feat/clients-page` from `0e745588`, then integrated with `2694ce1b` before deployment validation.

## Behaviour

Clients replaces API Keys and Client Models in navigation. `/api-keys` and `/models` redirect to `/clients`. A client is one named installation, script, or integration with one existing API-key identity. Application presets cover Claude Code, Codex, OpenCode, Pi Agent, Oh My Pi, and generic clients.

Setup selects the application, upstream destinations, advertised models and default, then reviews the result before atomically creating the client. The last screen reveals its key once and supplies copyable configuration. Existing clients can edit names, catalogues and destinations, rotate keys, enable/disable access, and delete their configuration. Activity means the last authenticated request, not an installation or connection status.

The six agreed decisions are implemented:

- Catalogue selections affect discovery only. Unlisted model requests continue through existing routing and account-permission checks.
- Compatible aliases get ordinary client-scoped routing rules after review. Review identifies earlier matching rules; the new exact aliases take precedence. Hiding an alias retains its route. Deleting a client removes its setup-owned rules, while manually owned routing references block deletion.
- Pins restrict upstream destinations only. All ingress protocols remain available. The existing choices remain unrestricted, a provider list, or one account.
- Discovery adds suggestions, never automatically expands a saved catalogue. Unknown, empty, and failed account discovery remain distinct, with account provenance.
- Existing keys receive independent catalogue copies without credential rotation, identity changes or runtime inheritance.
- Rich Codex entries require known metadata for their actual target. Browser-supplied metadata is ignored. Unknown custom entries cannot borrow another model's instructions or capabilities.

Each client stores separate selections for Anthropic-style discovery, the plain OpenAI models list, and the rich Codex catalogue. The latter two share a mount but have different envelopes and historically different contents. The application chooses the initial editing view and setup recipe; it does not authorize or restrict a protocol. Narrowing destinations flags incompatible selections across all formats at once. The model editor allows removing excluded accounts. Hidden aliases retain their routes; incompatible retained rules are named with a link to Routing, rather than silently deleted. Manually created client-scoped routing rules are validated when reviewing the configuration; they can produce a named conflict at that step because the wizard only previews its setup-owned alias rules.

Known Codex metadata is stored with its capture time and account-scope fingerprint. Serving prefers current known metadata without adding model IDs. A changed destination scope invalidates the saved metadata. If no selected entry has valid metadata, the response contains only the client's selected IDs in the generic list shape; Codex may use its built-in list in this case. Explicit empty catalogues are supported, although a harness may choose its own fallback.

The separate unauthenticated catalogue retains global overrides for deployments without API-key authentication. Its page states that it does not configure named clients.

## Migration and atomicity

The additive schema adds `client_profiles` and `client_alias_rules`. Schema-floor fixtures include both tables. Startup resolves the legacy wire catalogues after proxy context initialization and before accepting requests, then writes every existing key's independent profile and `backfill:client-catalogues-v1` in one transaction. Disabled keys are included. Repeated startup does not copy again.

Metadata reads are bounded and concurrent across pin scopes. Unavailable or malformed upstream catalogues use the existing bundled/generic fallback and record migration provenance. Database errors still fail the migration instead of claiming success. Rich custom entries that lacked actual target metadata are omitted with a notice; their plain OpenAI entries remain independently preserved.

The existing API-key creation facade initializes client profiles within its insert transaction once the server service is installed. New client review tokens are short-lived, bounded, server-held records. Commit rechecks routing rules, key destinations and account identities inside the same transaction, and uses an optimistic profile revision. Missing profile rows are shown as needing configuration without taking down the Clients page. Saving a reviewed configuration recreates only that profile and preserves its key. Until then, discovery for the affected key returns 503. Codex rendering and review share one account snapshot per operation, with cached scope fingerprints. Secret generation occurs before the transaction. Routing inserts reuse the existing validation and use temporary negative positions to preserve unique ordering.

## Setup and acceptance

OpenCode, Pi, and Oh My Pi use local model definitions, so their setup instructions explain when to recopy them. Pi/Oh My Pi get a launch command for the selected default. Codex's environment export is separate from its TOML. Claude Code's recipe enables gateway discovery and explains its base-URL model cache.

Focused validation passed 79 tests across seven files, including independent migration, disabled keys, restart idempotence, rollback, stale reviews, alias precedence, hide-only behaviour, metadata isolation, and malformed upstream fallback. Final lint, typecheck and dashboard build passed. The full backend run passed 10,443 tests across 667 files, with one environment failure because a subprocess could not find `bun` on PATH. That test passed separately with PATH corrected. The final complete DOM lane passed 176 tests across 25 files. After partner feedback, lint and typecheck passed again, plus 51 tests across five files, including missing-profile repair and one account snapshot for a 20-model catalogue. The final UI pass also passed six tests across two files, covering HTTP key lifecycle operations, rotation conflicts, and manual routing deletion conflicts; the dashboard build passed again.

A fresh isolated Chromium profile passed `/models` redirection, the setup wizard, destination pinning, automatic Claude-compatible aliases, select/deselect all, reviewed creation, one-time key reveal, authenticated model discovery, and mobile horizontal-overflow checks. A final run against the rebuilt dashboard also passed existing-entry display-name editing, the separate Codex environment block, and Pi/Oh My Pi launch-command blocks. This browser run preceded the destination-conflict warning addition, which is covered by the DOM lane. The DOM lane caught an edit activation problem caused by placing its button inside the checkbox label; the controls now have separate activation targets.

Real CLI acceptance ran on `ssh cnc` against a temporary gateway and synthetic OpenAI-compatible upstream:

| Harness | Version | Result |
| --- | --- | --- |
| Claude Code | 2.1.266 | Generated environment; alias resolved from `claude-gpt-lab` to `gpt-lab`; successful response |
| Codex | 0.153.4 | Generated Responses provider config; empty rich catalogue with built-in `gpt-6-astra` selected explicitly; successful unlisted-model request |
| OpenCode | 1.18.30 | Generated Responses provider and local model definition; successful response |
| Pi Agent | 0.85.1 | Generated `models.json`; successful Responses request |
| Oh My Pi | 18.1.16 | Generated `models.yml`; successful Responses request |

All five exited 0 and returned the mock response. Gateway routing records showed HTTP 200 and the expected requested/resolved/outgoing model IDs. These checks validate harness integration and configuration, not live upstream inference or rich Codex metadata discovery. Rich metadata selection, refresh and isolation are covered by service and wire tests. Permanent CNC configurations were not changed. The isolated CNC configuration directory was removed after acceptance and no task-owned harness processes remained.

## Deployment candidate validation

After integrating `2694ce1b`, release candidate `2026.9.52` passed lint, typecheck, all 10,460 backend tests across 668 files, all 184 DOM tests, and the dashboard build. The integration preserves the newer `/usage` route and navigation while adding Clients.
