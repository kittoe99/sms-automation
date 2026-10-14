# Development and verification

Use the synthetic demo for UI exploration, the static preview for authenticated CRM work, and offline tests for isolated behavior checks. These modes have different data and credential boundaries.

## Prerequisites

- Node.js `>=20.9` and npm, as declared in [package.json](../package.json). Use `npm ci` with the committed lockfile.
- Deno is needed for Edge type checking; Supabase CLI is needed for operator deployment/migration work. Neither is required for a static preview.
- A sibling `E2local-main` checkout is needed for E2 cross-project tests. Its Node requirements are independent; consult its package manifest.

Examples use PowerShell from the `opek-sms` root.

## Synthetic demo

```powershell
npm ci
npm run demo
```

Browse `http://127.0.0.1:8081`; `DEMO_PORT` overrides the port. This mode uses sample businesses without Clerk, Supabase, Twilio or AI clients. Writes, webhooks and WebSockets are blocked. It supports layout inspection, not validation of real permissions, provider delivery or production tenancy.

## Static frontend preview

Create or edit the ignored `.env` using the public settings in the [README](../README.md#quick-start). The broad [.env.example](../.env.example) mixes current operator and legacy variables; copying all of it is unnecessary for a preview.

```powershell
npm start
```

`start` builds `dist/` and serves it at `127.0.0.1:8080`; `PORT` changes the port. `dev` runs the same command and does not hot reload. Restart after source/configuration edits. The builder reads the reviewed environment manifest selected by `CRM_ENVIRONMENT` (default `production`) and requires a key beginning `sb_publishable_`. Unknown environments, mismatched destination overrides and legacy anon/service-role keys fail the build. It replaces only this checkout's generated `dist/` after validating the configuration.

Sign in through the independent CRM Clerk application. The browser origin must pass Edge and Clerk authorized-party checks. Signup still requires explicit staff or business permission; an account with no grants is not evidence of a failed install.

This is a **local frontend using shared services**, not a disposable database sandbox. Use the demo or offline tests when work must not touch real data. Local API/webhook routes intentionally return 404; `dist/config.js` shows public browser API destinations.

## Local preview with Clerk test login

For development sign-in without touching the shared backend, create ignored `.env.local`:

```dotenv
CRM_PREVIEW_MODE=development
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_REPLACE_ME
CLERK_SECRET_KEY=sk_test_REPLACE_ME
```

Run `npm start` and open `http://localhost:8080`. The preview server reads this file, derives the development issuer from the publishable key, and verifies Clerk sessions against the matching secret key and local origins. Only the publishable key reaches the browser. The existing `.env` public settings are still needed to build the frontend.

This mode requires sign-in and displays read-only synthetic CRM records. Changes, provider calls, webhooks and live database subscriptions are disabled. Test users do not have access to production records. Remove `CRM_PREVIEW_MODE=development` to restore the shared-service preview. `.env.local` is not read by the static frontend builder or deployed to Supabase.

Google sign-in must be enabled separately on the **E2 Local CRM development
instance**. It was enabled and verified on October 1, 2026: local sign-in reaches
Google's account chooser using Clerk's shared development OAuth credentials.
Use Chrome or another regular browser for this flow; Google does not support
OAuth inside embedded WebViews. Development identities and sample records remain
separate from production administrator accounts and grants. The login CSS and
logo match production; Clerk's development label remains visible. See
[Clerk's Google setup](https://clerk.com/docs/guides/configure/auth-strategies/social-connections/google).

## Command reference

| Command | Purpose and effects |
| --- | --- |
| `npm ci` | Install locked dependencies |
| `npm start`, `npm run dev` | Build and start loopback static preview |
| `npm run build:frontend` | Build ignored `dist/`; no deployment |
| `npm run demo` | Synthetic read-only preview |
| `npm test` | All checked-in Node tests |
| `npm run check` | Offline source syntax, generated static headers, Edge dependency closure and current SQL consistency checks; not a full type checker |
| `npm run headers:generate` | Regenerate the reviewed static policy in `render.yaml` after inline script/environment changes |
| `npm run test:paired` | Verify migration/hosting fingerprints, then run selected E2 contract tests from the paired checkout |
| `npm run baseline:record` | Explicitly record reviewed CRM/E2 migration and hosting hashes; does not apply SQL |
| `npm run verify:release` | Checks, CRM tests, paired checks/tests, static build and secret-free Edge bundle; no deployment |
| `npm run test:workers` | Worker architecture and Edge worker tests |
| `npm run test:inbound-ai` | Isolated inbound worker/database checks |
| `npm run test:inbound-concurrency` | Disposable local PostgreSQL concurrency tests; see INBOUND_AI.md prerequisites |
| `npm run eval:inbound-ai` | Paid real-model evaluation with synthetic data; requires injected credentials; never activates live mode |
| `npm run start:legacy`, `npm run dev:legacy` | Isolated legacy Express; see [legacy reference](LEGACY.md) |
| `npm run worker:sms`, `npm run worker:automation`, `npm run worker:ai` | Long-running consumers using `WORKER_DATABASE_URL`; can process real work |
| `npm run voice-sync` | Provider-backed legacy voice synchronization; not an offline test |
| `npm run db:assemble` | Retired; fails rather than assembling obsolete SQL definitions |

## Offline test strategy

```powershell
npm run check
npm test
```

`npm run test:workers` is a focused alternative; it need not be repeated after the full suite passes unchanged. `check` parses source and checks release invariants; it does not replace semantic TypeScript/Deno checks or provide a project-wide lint pass.

PGlite tests create isolated databases, apply local SMS migrations and supply test doubles for Vault, queues, Cron and HTTP. Vector-specific SQL is replaced. Provider tests inject mocks. These tests do not prove live delivery, real vector similarity quality, deployed grants or maximum capacity.

| Change | Existing test names |
| --- | --- |
| Auth and shared sessions | `authModule`, `authRedirect`, `separateLogins`, `platformApi`, `workspaceCacheAuth` |
| Workers and provisioning | `workerArchitecture`, `edgeWorkers`, `twilioTenancy`, `complianceWorker` |
| Intake, scheduling, context | `fixedAutomationIntake`, `groupAutomationAiContext`, `automationAiDraft`, `appointmentRemindersSequence` |
| Forms and embeds | `webFormBuilder`, `webFormSubmissions`, `websiteEmbed` |
| Knowledge and inbound replies | `knowledgeWorker`, `inboundAgent`, `inboundAgentDatabase`, `inboundCoordination` |
| Current template sequences/reporting | `formSequences`, `formLifecycle`, `directAutomations`, `directAutomationsApi`, `automationActivity` |
| Voice library/customer release | `voiceSetup`, `staffVoice`, `customerVoice` |
| Shared Twilio routing | `sharedTwilioWebhooks`, `twilioMigration`, `twilioConnections` |
| Email | `emailWorker`, `emailGroupAutomation` |
| Voice and booking | `voiceAgentBridge`, `soniInbound`, `bookingApi`, `smsBooking` |
| Frontend and uploads | `frontendLifecycle`, `tabWorkspace`, `pagePerformance`, `dashboardTheme`, `dashboardFollowups`, `hostingUpload`, `websiteDeployments`, `demo` |

Names correspond to `test/<name>.test.js`. Example:

```powershell
node --test test/webFormBuilder.test.js test/webFormSubmissions.test.js test/websiteEmbed.test.js
```

Check Edge entrypoints with an installed Deno runtime:

```powershell
Get-ChildItem supabase/functions -Filter index.ts -Recurse | ForEach-Object {
    deno check --import-map=supabase/functions/import_map.json $_.FullName
    if ($LASTEXITCODE -ne 0) { throw "Edge check failed: $($_.FullName)" }
}
```

Deno may download dependencies. A static build validates asset bundling, not backend behavior. Browser checks cover login, responsive layout, editing and uploads beyond synthetic fixtures.

## Cross-project verification

E2 enquiry and booking tests load SMS migrations from the sibling checkout. Run `npm run test:enquiries` or `npm run test:bookings` from E2 when shared contracts change; set `SMS_PROJECT_ROOT` there for a non-sibling checkout. See [E2 references](README.md#e2-reference-checkout) for its lint, TypeScript, cache and hosting checks. Do not copy E2-owned migrations here.

For the current release, install both lockfiles and run `npm run test:paired`
from CRM. `E2_PROJECT_ROOT` overrides the default sibling checkout. A mismatch
in `config/paired-baseline.json` requires reviewing the owning migrations and
hosting contract, running relevant paired tests, then explicitly recording the
new baseline. It is not a reason to replay SQL or silently refresh fingerprints.

The checked-in workflow runs CRM checks on pushes/pull requests. A manual paired
release check requires an exact E2 commit SHA and read access to that repository
(`PAIRED_REPO_TOKEN` for a private checkout). It verifies source, not deployment.
See [hardening release](HARDENING_RELEASE.md) for the complete gates.

## Paired migration prerequisites

The table records dependency edges, not a complete installation script. Source
timestamps may differ from applied remote versions. Consult the linked owning
guide and both project records, then compare live history before applying only
the intended missing forward migration. Never bulk-push either history.

| Feature | Required source order | Recorded mapping / details |
| --- | --- | --- |
| Owner-linked registration | CRM `20261001235349_business_service_prerequisites` before E2 `20261001235352_business_registration_services` | [Linking release](CRM_LINKING_RELEASE.md) |
| Canonical CRM access/profile review | CRM `20261002024327_sms_workspace_access_guards` before E2 `20261002024330_canonical_crm_access_profiles`, then CRM read-only conversation guard | [Linking release](CRM_LINKING_RELEASE.md) |
| Customer SMS summary | CRM `20261003032940_sms_connection_summary` before E2 `20261003032943_customer_sms_connection_summary` | [SMS summary](SMS_CONNECTION_SUMMARY.md) |
| Form sequences/customer enquiries | CRM `20261003143731_form_first_sms_automation` before E2 `20261003145302_form_sequence_enquiries`; unified Leads follows in E2 `20261003231755` | [Forms](FORM_AUTOMATIONS.md) |
| Inbound agent, coordination, activity, direct sequences | CRM booking baseline, then CRM `20261010171755`, `20261010183109`, `20261010185337`, `20261010210847`; retain paired access/cache prerequisites | [Inbound AI](INBOUND_AI.md), [Activity](AUTOMATION_ACTIVITY.md), [Direct](DIRECT_CONTACT_AUTOMATIONS.md) |
| Customer Voice | CRM `20261011235651_customer_voice_projection` before E2 `20261011235654_customer_voice_service`; then CRM `20261012195517_staff_voice_overview` and `20261012200816_voice_setup_flow` | [Customer Voice](CUSTOMER_VOICE.md) includes source-to-remote version mapping |
| October 14 hardening | Existing paired baseline, then CRM `20261014061007_queue_reporting_hardening` and E2-owned `20261014061728_hosting_read_indexes`; release E2 site-detail API before CRM frontend | [Hardening release](HARDENING_RELEASE.md); local, not applied/released by these checks |
| October 14 main E2 review | E2 `20261014065217_dashboard_scoped_reads`, `20261014065602_contact_intake_limits` and `20261014071224_hosting_operation_fencing`; drain old hosting invocations before the guard migration and deploy matching E2 APIs before reopening writes | [E2 release guide](../../E2local-main/docs/reliability-release.md); new local migrations, not applied |

The E2 business-services fixture loads the CRM test baseline and then E2
migrations into disposable PGlite. It proves combined contract compatibility,
not production replay order, live extension behavior or a restorable backup.
Useful focused checks, run from each indicated repository:

```powershell
# CRM root
node --test test/platformApi.test.js test/formSequences.test.js test/directAutomationsApi.test.js test/voiceSetup.test.js test/sharedTwilioWebhooks.test.js
# E2 root
node --test tests/business-services-database.test.mjs tests/customer-voice.test.mjs
```

## Documentation and contribution workflow

Trace a browser request through the Edge handler to the latest SQL definition and tests. Preserve auth, consent, idempotency and tenant boundaries. Test affected behavior, build when frontend changes warrant it, and update the owning guide and both project records for paired changes.

The maintained queue/reporting definitions live in `supabase/sql/current/`.
Keep their function/view source separate from the schema and one-time
trigger/backfill inputs. `node scripts/check-current-sql.js` verifies the reviewed
assembly without executing it. Applied migrations stay immutable; future changes
need new owning forward migrations. Historical `supabase/sql/` inputs are not
the current schema, and `db:assemble` now refuses to replay them.

For Edge packaging, `node scripts/prepare-edge-deployment.js --bundle-only`
walks the complete allowed import graph and writes an ignored bundle without
reading secrets or producing Vault SQL. Verify hosted Deno compatibility
separately, especially the pinned public HTTPS transport. Browser timing tests
and PGlite fixtures do not establish production performance or recovery.

Bootstrap and deployment scripts are operator actions, not test prerequisites. `smoke-edge.js` invokes authenticated workers and can consume jobs; follow [operations](OPERATIONS.md) before running it.
