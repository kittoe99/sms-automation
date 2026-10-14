# Opek SMS project record

### October 14 — Unified SMS workspace and reply behavior (migration applied; frontend pending)

SMS now groups Inbox, Automations, AI replies and Activity, including form message
editing in place. Calls/voice and Email remain separate. Existing links, permission
filters, stable click targets and retained drafts remain supported. AI history now
covers the same business/customer across conversation groups, using only inbound
and accepted outbound SMS up to the current input. Form and direct Continue runs
share the 30-minute wait in every mode; enabled reply settings also enable their
automation context. Existing Off/Review/Live values, pilot approval, booking
permissions, consent, STOP, manual takeover and appointment policies are retained.

CRM owns `20261014210130_unified_sms_workspace.sql`, after the October 14 paired
baseline. No E2 schema/API/application change. Existing production function hashes
match the local baseline. Tests: 407 passed / 29 skipped; 63 paired tests; 18 final
focused checks after the history query/editor refinements. Source, frontend and
Edge bundle checks passed. Migration applied as remote `20261014210940`
(`unified_sms_workspace`); all three function hashes and scoped grants match
the tested build. Opek remains shadow, unapproved, revision 1. Desktop/mobile
SMS tabs and retained AI/form-message drafts passed browser checks without console
errors. GitHub Project checks passed (run `38638227815`). Frontend commit
`5fb1f2a586bad3c131575a0500b57f0ae304bb84` is pushed to deploy-crm. Render
deployment `dep-db7v060473hc73844sj0` remains build_in_progress with no logs.
Render reports builds failing to start across all regions (October 14, 20:57 UTC):
https://status.render.com/incidents/8tsd93r1wbmz
The frontend is NOT verified live; served assets still reflect the earlier
release. Keep the pending deployment and verify all 18 assets plus runtime
configuration after recovery. Security advisor findings are unchanged from the pre-release baseline
(existing RLS-without-policy information, pg_net placement and existing public
function grants); this migration adds no exposed functions or table grants.

### October 14 — CRM navigation responsiveness fix (released)

Sidebar buttons and sibling tabs now keep the same DOM nodes as reads complete;
only permission/search structure changes rebuild navigation. This prevents a
load finishing between pointer-down and pointer-up from discarding the clicked
button. Selection updates in place and manually collapsed groups stay collapsed.
Page reads race cancellation through token/transport waits and response decoding;
lazy page imports also release the render queue on cancellation. Obsolete click
completions cannot change history or move keyboard focus after a newer selection.
Submitted writes and retained drafts keep their existing behavior.

Local checks: 403 CRM tests passed, 29 skipped; four added regression tests cover
stable click targets, sibling selection, ignored transport cancellation, and slow
body/module waits. Source checks, frontend build, 63 paired-project tests and Edge bundle checks passed. Synthetic browser QA
covered a six-second booking delay, single-click departure, rapid navigation,
Back, keyboard tabs, mobile single-tap navigation and unsaved Text replies draft retention. No backend, auth,
permission, shared contract or database change is included.

Released CRM commit `f9f41aef93f67d15cc053f9399d0d918911eecc9` on Render
(`dep-db7u4d3rjlhs73943mag`, live October 14 at 20:12:50 UTC). GitHub
Project checks passed (run `38630063749`). All 18 production frontend assets
and runtime configuration match the tested build. E2 application code is unchanged;
its project record is synchronized for the paired system.

### October 14 — Requested complete form cleanup (applied to production)

The user explicitly requested deletion of all form designs, submissions and form
automation history across the paired CRM/E2 system. A guarded transaction in the
shared production database disabled and deleted all five form definitions, the
one completed form test run, its two outbound test messages, four completed queue
jobs, six delivery events, six activity events and two provider attempts, plus
associated queue/archive and first-contact records. The inventory contained no
saved submissions, form sequences/versions/presets, email enrollments or website
form connections. No operational booking or lead was linked to the deleted data.

An independent post-commit query verified zero forms, submissions, form runs,
form messages, form jobs, matching activity and queue records. Existing dashboard
cache invalidation triggers remained enabled. Form seeding is already a no-op,
so loading the workspace does not recreate deleted designs. Existing form links
are no longer usable; new forms require new definitions. Customer accounts,
businesses, contacts, unrelated conversations, suppression/opt-out protections,
provider webhook receipts and provider-side records were not removed.
No schema migration, application code change or deployment was required. This
was an explicitly requested database purge, not the UI's recoverable Archive.

### October 14 — E2 dashboard layout production release

Dashboard-only application changes are live at https://www.e2local.com/dashboard,
from commit `349fba73acd6520dd3444b14046ccc2433864a1b` (implementation `f3f6dee`).
Vercel production deployment `dpl_4DpKZZ2LNm3g8vXnQpm3hLjqUwwa` is READY and
assigned to the production domain, confirmed October 14 at 15:23:34 UTC. The
local-only status below is superseded. CRM runtime, public marketing pages,
shared database, API contracts and delivery Worker are unchanged. No migrations
were applied and no backend service was redeployed.

Local checks passed: SQL-source consistency, lint, app/Worker TypeScript and
production build; six Worker tests and 63 paired contract tests. The app suite
ran 240 tests: 238 passed initially, with two outdated label assertions corrected;
all 13 ownership tests passed on the targeted rerun. Synthetic desktop/mobile
browser checks covered the reordered Home, filtered enquiry shortcuts, selected
mobile navigation, and website drafts retained across tabs, with no console errors.
The live dashboard correctly redirects unauthenticated visitors to sign-in; no
signed-in production customer session was available for visual verification.
The tested checkout and published dashboard source match after line-ending
normalization; unrelated local changes were preserved. See E2's
`docs/dashboard-layout.md` for navigation and current workflow details.

GitHub E2 project checks passed for the deployed commit: run `38588798864`,
including the full paired CRM suite and E2 `verify:release`.

### October 14 — E2 dashboard layout simplification (local implementation)

The signed-in E2 dashboard now groups Daily work and Services, uses Home,
Enquiries, Text messages and Calls labels, leads with customer work/recent
enquiries, and makes website change requests the first Website section. Secondary
website and messaging details are expandable. Public pages, backend contracts,
authentication, ownership and service visibility remain unchanged. Existing hash
keys, filters, cache/session boundaries and retained drafts are preserved.
No migrations or cross-project release prerequisites are introduced.

Local browser checks with synthetic data covered desktop/mobile layout, enquiry
filter shortcuts, selected mobile navigation and website draft retention. Release
checks and production evidence will be recorded separately. See E2
`docs/dashboard-layout.md`, `docs/business-services.md` and
`docs/website-workspace.md` for the current workflow.

### October 14 — CRM layout production release

The approved layout is live at https://crm.e2local.com. CRM source commit
`7156b5cd5caeb54014db5d9c7b866d3e0e17539e` deployed through Render
`dep-db7plstg1s2s73bdan8g`, confirmed live at 15:08:48 UTC. This supersedes the
local-only status of the layout entry below. Render auto-deploy did not start;
the existing service was deployed manually without changing service settings.
GitHub Project checks passed (run `38586568010`).

Release validation passed: 399 CRM tests (29 skipped), 63 paired contract tests,
source/security checks, paired baseline fingerprints, frontend build and complete
Edge packaging checks. Production HTML and all 17 generated assets match local
SHA-256 hashes; production configuration matches. The live Clerk sign-in screen
loads, and no Render errors were returned for the release window. Authenticated
production UI checks require a signed-in browser; local synthetic UI checks remain
the workflow evidence. No new migrations, backend,
worker, E2 application or provider-setting changes were needed. Original working
trees and unrelated local changes were preserved. Both project records were updated.

Build dependency audit also reported existing transitive advisories: axios (high)
and proxy-addr (critical), both with fixes available. Dependency files are identical
to the prior release; this frontend layout release did not alter them.

### October 14 — Simpler CRM navigation and daily-work layout (local only)

Implemented the approved frontend arrangement while keeping the existing branding,
URLs, role gates and backend operations. Daily pages are Home, Inbox, Contacts,
Bookings, Follow-ups and Forms. Secondary groups contain AI assistants, Reports,
Settings and staff Administration. Local tabs group messages/calls/help requests,
contact unsubscribes, and the four follow-up tools. Legacy labels remain searchable.

Home uses existing workload, activity, overview and SMS connection reads; unavailable
counts are distinct from zero. Forms use a compact directory and expandable creation
and detail controls. Editor tabs retain whole panels and listeners; Refresh checks
retained form/message drafts. Messages and timing are separated, repeat controls
and Preview & test are expandable, and save/publish/turn-on remain separate.
Text replies explains Review only versus Automatic replies; form testing does not
change the AI mode. Archive form reflects the existing recoverable operation.
Inbox keeps customer/AI controls inside customer details. No schema, API, auth,
ownership, shared contract, send-policy or provider configuration change was made.

Validation: frontend build and project checks passed; CRM tests: 399 passed,
29 skipped, zero failures; selected paired E2 cache, login realms, hosting access,
ownership, enquiry and booking tests: 59 passed. Synthetic browser checks covered
Home, mobile layout, filtered activity links, follow-up destinations and retained
form draft/listener behavior. The preview browser became unresponsive at the native
Refresh confirmation, so that dialog interaction could not be fully verified.
Screenshot: `data/crm-layout-preview.jpg` (synthetic data). Updated navigation,
user guide, tabbed-workspace and form workflow documentation. E2 application code
is unchanged. No migration, source publication or deployment occurred; no migration
ordering prerequisites were introduced.

### October 14 — Requested SMS test-contact reset

At the user's request, removed the Opek test contact ending 1409 and its two
messages, completed form test run, three completed queue jobs, shadow AI result,
conversation, test consent and dependent delivery/activity records from the
shared production database. Scoped transactional guards verified the contact
was test-created, had no opt-out/block, and had no linked booking or lead.
Post-commit reads verified zero remaining contacts, messages, conversations,
test runs, jobs and AI results for the inspected test. Provider webhook deduplication
receipts and aggregate usage remain; no Twilio records were deleted. Inbound AI
remains shadow. No migration, application change or release was required.

### October 14 — Paired hardening production release

The reviewed application changes are deployed. The earlier "local only" entries
below describe their implementation stage; this entry supersedes their deployment
status. Source publication was explicitly approved for the public CRM repository.
Original local branches, indexes and unrelated working changes were preserved.

| Component | Verified production release |
| --- | --- |
| E2 application | Commit `3bacc0e4a210f513eca1964def1597e48a4a2711`, Vercel `dpl_7PW1hj94SEMhYNGe9mCT7fjwWHiM`, [www.e2local.com](https://www.e2local.com) |
| CRM frontend | Commit `76edfa0c1ee7ccf19e46c1b2fdf873033ee717bf`, Render `dep-db7oii2vcj2c73ecl0pg`, live at 13:53:24 UTC, [crm.e2local.com](https://crm.e2local.com) |
| Delivery Worker | `e2-sites` version `dc8ad252-771c-49e6-b8ef-a1ffc8ea271d` (version 3), deployed 13:36:51 UTC; existing WEBSITES/R2 binding preserved |
| CRM API | Supabase `crm-api` version 59, ACTIVE |
| Knowledge worker | Supabase `knowledge-worker` version 15, ACTIVE |
| Email worker | Supabase `email-worker` version 12, ACTIVE |

Render's automatic deployment did not start after the production push. Both the
dashboard and deploy API still showed only the old deployment, so the release was
started through Render's deploy API. Future releases must confirm a new deployment
exists instead of assuming that a successful Git push deployed the frontend.

Only these five missing forward migrations were applied to the existing shared
Supabase project `wxamwhfmelxqahkdtcci`. Both histories were reconciled; neither
history was replayed. Each payload used a 5-second lock timeout and 60-second
statement timeout. Remote stored-payload hashes exactly match the owning local
SQL plus those two transaction-local guards.

| Owner / source migration | Applied remote alias |
| --- | --- |
| CRM `20261014061007_queue_reporting_hardening.sql` | `20261014133038` |
| E2 `20261014061728_hosting_read_indexes.sql` | `20261014133135` |
| E2 `20261014065217_dashboard_scoped_reads.sql` | `20261014133140` |
| E2 `20261014065602_contact_intake_limits.sql` | `20261014133147` |
| E2 `20261014071224_hosting_operation_fencing.sql` | `20261014134017` |

The CRM projection backfill was sized before application: six messages, two form
runs and no email enrollments; it produced two first-contact rows. These small
production volumes are not representative capacity evidence. Four new private
tables have RLS enabled and no anonymous/authenticated SELECT grant. Contact and
all six hosting operation RPCs allow service_role execution and deny anonymous
and authenticated execution. No interrupted hosting operation existed at the
post-migration check.

Hosting POST/DELETE/PATCH/PUT requests were temporarily denied at Vercel's edge.
The published pause was verified at 13:35:15 UTC; old 300-second invocations were
given a full drain before the fencing migration at 13:40:17 UTC. The new E2
production source and detail endpoint were verified before the CRM release.
The pause was disabled and published by 13:52:26 UTC; the inactive rule
`rule_e2_hosting_release_drain_20261014_Gd4CZf` remains for audit. Ordinary
hosting authentication and database operation guards remain enforced.

Production verification:

- E2's 11 public pages passed metadata, canonical, schema, sitemap, social-image,
  internal-link, real-404 and HTTP/HTTPS/www/apex redirect checks. The hosting
  directory/detail reads return 401 without staff authentication.
- CRM HTML and all eight referenced static assets exactly match the local build.
  Render now serves the reviewed CSP, framing, MIME, referrer, permissions and
  cache headers. Unknown paths redirect to the protected root; embed.html stays
  available without a framing denial. Both production Clerk sign-in screens
  rendered with no browser warnings/errors captured during the check.
- The existing hosted customer website returned HTTP 200 after the Worker update.
  CRM API returned 401 without authentication; worker GETs returned 405.
- Deno 2.9.6 entrypoint checks passed for all three deployed functions. Real local
  Deno TLS requests to public fixtures passed and loopback was rejected. This is
  local runtime evidence, not an authenticated hosted ingestion test.
- [Combined CI passed](https://github.com/kittoe99/E2local/actions/runs/38574671579)
  on the deployed E2 revision against the exact deployed CRM revision: CRM
  395 passed / 29 existing skips / 0 failures; E2 239 passed; Worker 6 passed;
  paired contract suite 63 passed. SQL, lint, application/Worker type checks
  and the credential-free production build passed. The separate
  [CRM production-branch checks passed](https://github.com/kittoe99/sms-automation/actions/runs/38575382744).
  Subsequent release-evidence commits change documentation only; the runtime
  source above is the tested baseline.

CI ownership was corrected: the public CRM workflow checks source/build/packaging;
the private E2 workflow checks out an immutable public CRM revision and runs its
complete suite before E2's release gate. Repository variable PAIRED_CRM_REF is
configured to `76edfa0c1ee7ccf19e46c1b2fdf873033ee717bf`. No private E2 fixtures
or cross-repository credentials were published. E2's account-unavailable page
now follows the root layout's configured-authentication check before rendering
UserButton; a production build with both Clerk keys explicitly empty passed.

Remaining verification limits: no authenticated two-account/business switching,
Persona/compliance, private Voice playback, R2 upload/publish/restore, forced
hosting interruption, hosted public-HTTPS ingestion, representative PostgreSQL
load/concurrency, or restore rehearsal was performed in production. Offline
behavioral tests cover the implemented contracts but do not replace those checks.
No real message, payment, service publication or customer content mutation was
used as a smoke test. Security advisors retained their existing pg_net/public and
SECURITY DEFINER warnings; no new warning category was introduced. Expected
deny-by-default/RLS-without-policy informational entries increased from 61 to 65.
Application rollback must retain the new fenced hosting contract; do not roll
back to old unfenced hosting code or replay migrations.

The paired main E2 review is now implemented locally; its final verification
and three new unapplied E2 migrations are recorded in the appended
[October 14 main E2 entry](#october-14--main-e2-reliability-review-verification-local-only).
Use the [E2 release guide](../E2local-main/docs/reliability-release.md) with the
CRM hardening guide when releasing the current paired checkout.

### October 14 — Architecture and reliability hardening (local only)

Implemented the paired review recommendations locally. CRM now preserves explicit
business context, fences tokens/cache/results across Clerk session changes, clears
account/business drafts and subscriptions on identity changes, and ignores late
mutation completions outside their original editor. Platform reads have cancellation
and deadlines, writes no longer block navigation, uploads use four bounded workers,
and Voice/Calls remount working handlers while releasing media on departure.

E2 hosting directory reads are paginated metadata only. A new authorized per-site
GET reads one deployment page and a publication manifest with a five-second storage
deadline, including stalled body collection. CRM uses that endpoint. Release this
E2 API before the new CRM frontend. E2 owns the additive pagination-index migration
20261014061728_hosting_read_indexes.sql.

CRM owns 20261014061007_queue_reporting_hardening.sql: bounded expired-email
recovery, terminal/paused lifecycle cancellation, single-active-address retry rules,
send-window checks, tenant rotation, bounded scheduler candidates, heartbeat
normalization and reporting indexes/projections. Activity reports narrow the cohort
and page before expensive work. Email shares admission slots with automation;
capacity limits do not promise strict alternation between worker types. The
first-contact projection has a one-time backfill that needs production sizing.

Website enrichment and knowledge ingestion share public-only HTTPS validation,
redirect/DNS checks, connections pinned to a checked address with TLS verification,
response limits and a 30-second deadline. Late knowledge results cannot be saved.
Synchronous parser CPU remains subject to the Edge runtime's own CPU limits.

Build/release inputs now include reviewed environment destinations, generated static
security headers that preserve public embeds, complete Edge dependency packaging,
four maintained SQL source modules and an exact migration assembly check. The old
historical SQL assembler refuses execution. Local CI definitions check CRM and offer
a manual paired release gate with an immutable E2 revision and reviewed source/hash
baseline. These definitions do not establish remote branch-protection settings.

Validation on the final local snapshot:

- CRM: 424 tests, 395 passed, 29 existing legacy/disabled-AI skips, zero failures.
- Paired E2 access/service/Voice/hosting contracts: 44 passed, zero skips/failures.
- Final changed frontend/auth/lifecycle tests: 14 passed after code freeze.
- E2 TypeScript check passed; CRM frontend build and secret-free 65-file Edge
  bundle passed; 178 source files, static headers and current SQL checks passed.
- Render Blueprint passed its official JSON Schema. Synthetic browser QA verified
  site details, deployment history, Leads and restoration through Users navigation.
  This used mocked records and does not prove deployed Clerk/R2 integration.

Both owning migrations are NEW AND UNAPPLIED for this work. No production database,
provider send, service visibility, publication, DNS or deployment was changed.
Reconcile existing remote migration aliases and both histories before applying only
the missing owning forward migrations; never replay either complete history. Hosted
Deno transport/TLS checks, actual CSP flows, PostgreSQL query plans/concurrency and
index/backfill timing remain explicit pre-release requirements. Existing unrelated
local work is preserved; the CRM diff retains a pre-existing trailing blank line in
public/dashboard-theme.css. Full local test logs are ignored workstation artifacts.

Release sequence and operational evidence: [paired hardening guide](docs/HARDENING_RELEASE.md).

### October 13 — Documentation reconciliation (local only)

Current documentation now describes form/direct SMS templates, the separate gated
inbound agent, explicit owner-linked service setup, shared-account sender routing
and the Voice Agents library/customer release flow. The CRM API reference marks
retired 410 mutations and includes form tests, contact sequences, activity,
Twilio connection and Voice gateway contracts. Configuration covers all current
Edge environment names, including the previously omitted Voice credentials and
flags. The guide index includes every CRM guide. Current database additions are
separate from the dated September catalog in both repositories.

Added the shared recovery runbook: backup/Storage inventory, incident role
assignment, contained restore, access/opt-out and provider reconciliation, release
checks and handover evidence. Alert thresholds are proposed operator defaults,
not newly installed monitoring. Actual backup coverage, named on-call contacts,
RPO/RTO and a successful restore drill remain unverified operational requirements.

Validation: 22 focused CRM tests and 12 paired E2 tests passed. The E2
business-services fixture exercised the combined local migration baseline;
source dependency edges were checked against the owning migrations/guides.
This does not replay or validate production migration history. Documentation
links/index, Edge configuration names and function inventory were checked locally.
No application code, credentials, database, provider, migration or deployment
changed. These are local documentation edits; publication/commit remains separate.


### October 12 — Simplified Automation activity layout (local)

CRM Automation activity now uses the page-level heading and Refresh control,
four summary cards, compact customer/date filters, and a six-column enquiry list.
Advanced filters and complete delivery/conversion/workload metrics expand on demand;
all original report fields, attribution actions and scoped API requests are retained.
Tags sit with customers; booking and handoff results share an Outcome column.
Expanded sections survive report reloads and automatic refresh defers unsaved filter
edits. Current-workload cards remain explicitly separate from date-based counts.

Validation: frontend build and three existing API/async lifecycle checks passed. Synthetic
browser QA checked desktop and 390px mobile layouts, status filtering/reset,
expanded metrics and enquiry timelines. Fixture: `test/fixtures/automation-activity-preview.js`
in CRM. E2 application code, shared contracts, migrations and production releases
are unchanged; this entry records local UI implementation only.

### October 12 — Voice Agents production rollout

Applied only CRM-owned `staff_voice_overview` and `voice_setup_flow`, in order,
as remote versions `20261012202507` and `20261012202514`. These are the exact
payloads from source files `20261012195517` and `20261012200816`; do not replay
source timestamps or either repository history. Existing paired customer Voice
prerequisites were already applied. CRM API version **58** is ACTIVE with its
existing Clerk authentication. Frontend commit **c43600a** is live in Render **dep-db6k4uavcj2c7389muug**
at https://crm.e2local.com. Authenticated browser checks verified the agent library,
release checklist and call history. Eight deployed entry assets match the release
build; the unauthenticated API correctly returns 401. Customer visibility remains
draft at revision 0. No real agent, phone or service release mutations were made.

The isolated release passed **36 CRM tests** and its frontend build. Paired E2
production-baseline tests passed **45**, with the two previously documented
website-copy assertions still failing. No E2 application or schema edits are
included in this release; its documentation is updated alongside CRM.

The existing Opek phone agent and draft customer Voice service are preserved.
Creation saves private CRM drafts; cloud runtime/phone provisioning remains a
separate integration step. The following local implementation entries describe
the work before this production rollout and are superseded by this status.

### October 12 — Voice Agents library, creation and guided release (local)

The Voice Agents tab now opens an agent library with separate connected-deployment
and draft cards. Staff can create an agent from scratch (name, voice, personality,
conversation and business instructions), continue editing, inspect deployed agents
already registered with CRM, or open an agent's call history. Creation uses a
client request UUID for idempotence, staff/business authorization and an audit row.
New drafts have no deployment, phone or published revision. They cannot publish or
appear in customer projections until their runtime connection is configured.

A shared three-step panel in Voice Agents and the business record shows Agent &
phone, Review setup, and Customer access. Existing attached/published agents resume
at review rather than asking staff to attach them again. Owner/profile/agent checks,
a customer-view preview, and explicit **Enable customer Voice / Hide customer
access** replace the generic Add Voice / Set live flow for Voice. These actions
reuse E2's existing revision/authorization/owner-transfer guards. Other services
retain their controls. The business record links directly into the agent library.

The deployed-agent picker lists CRM-connected deployments and identifies their
assigned businesses. Other-business entries are disabled. This is not automatic
LiveKit inventory discovery, cloud worker provisioning, deployment transfer or
runtime routing configuration; those still require the existing external setup.
The scoped Opek runtime/phone integration is unchanged. New CRM agent creation is
fully persisted draft creation, not a claim that a new cloud agent can take calls.

Read-only production verification confirmed Opek Junk Removal's existing phone
agent is attached/published and its customer Voice service is draft. No production
agent, service visibility or calling configuration was changed by this work.

Validation: 24 CRM tests passed (Voice setup, staff/customer Voice, workspace and
platform API); frontend build passed. Paired E2 suites: 46 passed, with the same two
known website-copy failures (`Production deployment`, `Your website starts here`).
PGlite covers the paired migration chain, retry-safe creation, authorization,
revision conflicts, hidden drafts on already live services, catalog metadata and
release readiness. Synthetic browser checks cover create-from-scratch, disabled
publishing for drafts, deployment selection/foreign-business blocking, explicit
release/hide, and refreshed library visibility. Production migrations/releases:
**none for these changes**.

Pending release order: apply CRM `20261012195517_staff_voice_overview.sql`, then
CRM `20261012200816_voice_setup_flow.sql`, after the already applied paired customer
Voice prerequisites. Deploy updated crm-api and CRM frontend. E2's customer API
contract and code are unchanged; only its project/workflow documentation changed.
Never replay either migration history over the shared database.


### October 12 — CRM Voice workspace parity (local implementation)

The staff Voice workspace now includes reviewed business facts, contacts, services,
service areas, time zone and separate customer release status. A direct **Manage
business & Voice setup** action opens the selected business record's Services.
Registered-agent selection keeps configuration drafts separate; call history adds
agent filters, published names, summaries and business-local date boundaries.
Configuration/publish/rollback, availability, bookings, contacts and leads remain
staff controls. Customer access still requires the existing explicit release.

Recording playback is on demand with no download button, stops on detail/tab/
business/session changes, and expires with its link. The staff media RPC rejects
deleted/missing audio and bounds signed-URL lifetime to remaining retention; the
CRM API forwards that bound. Transcripts and media links remain outside persisted
workspace caches. Generic deployment assignment/provisioning is still not a CRM
screen: **Add Voice** releases an already registered, published agent, and does
not create or reassign deployments or phone routing.

Validation: 27 CRM Voice, transport and cache tests passed; the CRM frontend build
passed. Paired E2 customer Voice, business-service, ownership and dashboard-cache
suites produced 46 passes and the same two pre-existing website-copy failures
(`Production deployment`, `Your website starts here`). Database validation used
PGlite with CRM and E2 fixtures, not production. Chrome synthetic-fixture checks
verified agent selection/draft preservation, filtering, transcripts, recording
expiry, workspace cleanup, setup callback and unregistered-agent messaging;
no browser console errors were observed.

Release status: **not applied or deployed**. After the already released CRM
customer_voice_projection and E2 customer_voice_service prerequisites, apply only
CRM `20261012195517_staff_voice_overview.sql`, then deploy `crm-api` (including
`_shared/voice-storage.js`) and the CRM frontend. E2 has documentation changes only;
its public contract and release gates are unchanged. Never replay either history.
No real agents, phone assignments or customer service releases changed.


### October 11 — Customer Voice deployed and verified

Both customer Voice migrations are applied in order: CRM source
`20261011235651_customer_voice_projection.sql` is remote history version
`20261012021000`; E2 source `20261011235654_customer_voice_service.sql` is remote
version `20261012021005`. Supabase generated these history timestamps. Do not
replay source files because their timestamps differ from the recorded versions.
Postflight verifies two cache triggers, server-only customer reader execution,
an invoker public wrapper, an empty unauthorized result and zero Voice services.
Existing released SMS and website services are unchanged.

CRM commit `4e9a5d5511dae701809e9ad958973892538891af` is LIVE in Render deployment
`dep-db643tlckfvc73c2evk0`, finished 2026-10-12 02:12:18 UTC. The push produced no
build/deploy event after more than a minute; one direct deployment then ran.
All 13 served JavaScript assets match the isolated release build byte for byte.
E2 commit `fb4ada466f046bbc1e8aa8553c2c60c00ee39859` is Ready in Production in
Vercel deployment `dpl_GqrZQeWa8RiVuJ3aERM4qGoVoqh9`, completed 02:11:47 UTC,
with www.e2local.com assigned. Both public sites return HTTP 200.
Deployment-scoped runtime logs show zero console warnings/errors/fatals; the
verified production dashboard and dashboard API requests returned HTTP 200.

The authenticated production `/dashboard/voice` redirects to `#voice`, shows
the setup notice and leaves Voice absent from navigation while unreleased.
Unauthenticated Voice API requests redirect to sign-in; cross-origin recording
requests return 403. No real call recordings were accessed, no agent settings
changed, and no business Voice service was created/released during verification.
No CRM Edge code changed; the existing generic service routes remain compatible.

Isolated release validation: 11 CRM and 43 E2 focused tests and both production
builds passed. Prior implementation verification includes 71 passes and desktop/
mobile synthetic audio/UI checks; two known unrelated E2 website-copy assertions
remain documented. Security advisors report no ERROR findings, with existing
public-extension and legacy function-grant warnings; remediation links are in the
customer Voice workflow. Earlier local/pending entries below are historical.

### October 11 — Customer Voice dashboard implemented locally

Voice is now a per-business draft/live service. CRM staff can Add Voice for an
active customer owner after reviewing the business profile and registering an
agent with a published configuration and phone number. Set live releases the
owner-only customer tab; Hide from customer and ownership transfers remove it.
Agent publishing does not release a service. SMS registration approval is not a
Voice release requirement, and no agent or provider resources are provisioned.

E2 displays published agent names/numbers, approved business facts, a business
selector and retained call history (25 per page, agent/date/status/search filters).
Call details expose summaries, outcomes, transcripts and on-demand private audio
playback. Configurations, prompts, runtime details, storage paths and editing
controls remain private. Signed recording URLs require current owner/live-service
access, are audited, and expire within five minutes or the remaining retention.
There is no download control; playback cannot prevent browser-level capture.

Voice metadata participates in scoped dashboard caching and background warmup.
Transcripts and media URLs are memory-only/on-demand; expiry is also enforced in
the UI. Release, ownership, published agent and customer-visible call changes
invalidate cache revisions; heartbeat and draft-only changes do not.

Migration order: CRM `20261011235651_customer_voice_projection.sql`, then E2
`20261011235654_customer_voice_service.sql`, then both frontends. The existing
CRM API service routes are compatible; this feature does not change Edge code.
Apply only these forward migrations, never either repository's history.
**Status: local implementation and validation only. Neither migration is applied
to the shared live database; no release or real business service visibility was
changed.** Local verification: 17 CRM tests and 54 E2 tests passed, including the
new Voice tests and existing paired business/cache suites. Both production builds
passed. Desktop/mobile synthetic browser QA covered history, details, filters,
business switching, audio playback and hidden/expired states. Two existing E2
ownership tests still fail on unrelated website wording. See the customer Voice
workflow documentation for verification.

### October 11 — Toll-free calling correction deployed and verified

CRM migration `20261011233216_toll_free_voice_before_sms_approval.sql` is applied.
CRM API v57 is ACTIVE; all deployed files match the release payload, preserving
prior live files except twilio-connections.js. Database postflight confirms
pending-status support, voice-capability validation, three existing sender claims,
API execution permission and no anonymous/browser function access. No history
was replayed; no E2 migration or webhook redeployment was necessary.

CRM commit `f4d84718088818f8cdba6aefa77e5ba7f2fef90e` is LIVE at
https://crm.e2local.com in Render deployment `dep-db61pqnlot8c738ih6v0`, finished
2026-10-11 23:34:14 UTC. The push produced no build/deployment event; after checking
both histories, one direct deployment ran. All 13 served JavaScript assets match
the isolated release build byte for byte.

E2 commit `2074c54ba4fd28447b04bb0b964aa3957ad53240` is Ready in Production in
Vercel deployment `dpl_F6FqL4bbwJmvhYBtJTsUvN5q5fKH`, completed at 23:33:31 UTC,
with www.e2local.com assigned. The authenticated customer SMS dashboard shows
Toll-free, SMS approval and the calling-independent-of-SMS-approval note. The
live CRM account directory loads and lists linked CRM businesses with numbers.
Both public sites return HTTP 200; unsigned CRM inventory correctly returns 401.

Isolated release validation: 26 CRM tests and six E2 SMS UI tests passed; both
production builds passed (including E2 TypeScript). Prior verification includes
42 focused CRM tests, four real PostgreSQL concurrency checks and 41 paired E2
passes; two known unrelated E2 website-text assertions remain documented below.
Security advisor reports no ERROR findings; existing pg_net/public and legacy
function-grant warnings remain, with links in docs/TWILIO_CONNECTIONS.md.
No business connections, voice routing, registration submissions, SMS activation,
number purchases, messages or calls were changed during release verification.
Unrelated local work is preserved. Earlier local/prepared entries are historical.


### October 11 — Toll-free calling independent of SMS approval (local, not released)

The CRM connection picker now accepts voice-capable toll-free numbers while SMS
verification is unsubmitted, pending or rejected. It rechecks live Twilio number
ownership/capabilities and uses server-derived approval state, ignoring browser
claims. Calling is independent of SMS approval; existing voice configuration is
preserved. This does not create voice agents or change voice URLs. Admin identity
review, one exclusive number/service per business, revisions and reservation
claims remain enforced. A2P approval requirements are unchanged.

The CRM-owned forward migration
`20261011233216_toll_free_voice_before_sms_approval.sql` follows the shared-account
migrations and precedes the new CRM API. It preserves pending/rejected SMS states
instead of marking every connection approved. Old approved-only API calls remain
compatible. Retry can refresh registration metadata for the same reserved
resources; reconnecting is idempotent and never enables SMS. Existing Check status
polling discovers a verification by number and advances SMS independently.
No E2 migration or customer-response/cache schema change is required. CRM and E2
labels distinguish SMS approval from calling and no longer call every toll-free
number verified. Both frontend changes need release with the CRM API correction.

Validation: 42 focused CRM tests passed across the initial run and targeted
reruns, including signed voice routing while SMS is in review, unsubmitted/pending/
rejected connections, rejected SMS canary/activation, retry/idempotency, ownership,
UI, compliance and migration regressions. Four disposable PostgreSQL concurrency
checks passed. Frontend build passed. Paired E2: 41 passed; two pre-existing
website-text assertions still fail (`Production deployment`, `Your website starts
here`). The touched files pass whitespace checks; the pre-existing
public/dashboard-theme.css blank line remains unrelated.

Release boundary: this correction is local only. Its migration has NOT been
applied and neither project has been redeployed for it. The preceding shared-account
release below remains the live version. No live business link, Twilio mutation,
message, number purchase or phone call was made. Unrelated local work is preserved.


### October 11 — Shared Twilio accounts deployed and verified

CRM commit e0e86bfec98524c2c7bd2ff0e630feb2c0efcf60 is LIVE at
https://crm.e2local.com in Render deployment dep-db5u7l67bikc73e36je0, completed
2026-10-11 19:30:50 UTC (1:30:50 PM America/Denver). The push did not create a
Render build/deploy event; after checking both histories, one direct deploy ran.
The frontend lists every linked CRM business and assigned number per Twilio
account, separates pending connections, and permits other available senders in
shared accounts. Each business retains one exclusive number and single-number
Messaging Service.

CRM migrations 20261011192551 and 20261011192649 are applied in staged order.
Messaging webhook v21, Soni voice v10 and CRM API v56 are ACTIVE and their deployed
files match the reviewed changes over previous live bundles. The database
postflight verified sender claims, number-aware routing, removed account
uniqueness and denied public/browser access to new private functions/tables.
No E2 migration/runtime release, real business linking, message send, number
purchase/transfer or voice call was performed. Unrelated local work was preserved.

Production root returns 200 and loads app-GI7RIQVJ.js. Both served Twilio source
files match the release; all 16 bundles match the isolated build after normalizing
hash-based import filenames (the local fflate dependency uses a symlink path).
Render error logs are empty. Unsigned CRM inventory returns 401; both webhook
consumers reject unsigned requests with 403 and GET with 405. Functional shared
linking/routing was tested with synthetic records, not live customer mutations or
a signed-in production admin session. Browser evidence: local
data/shared-twilio-qa/account-sharing.png.

Tests: 43 focused CRM passes, eight existing skips; four PostgreSQL concurrency
passes; 18 isolated release passes; frontend build passed. Paired E2: 40 passes
and two unchanged website text assertions failing in ownership.test.mjs. Shared
account customer isolation and cache regression checks passed. Earlier prepared
status below is historical; this entry is the final release status.


### October 11 — Shared Twilio accounts: backend released, frontend prepared

Admins can connect multiple CRM businesses to one Twilio account, each with an
exclusive number and separate single-number Messaging Service. Account inventory
returns all linked CRM businesses and separate pending connections. Resource claims
fence both reservations and provider writes; failed connections retain ownership.
Inbound SMS/calls use account plus receiving number; delivery callbacks resolve the
stored attempt/message and verify consistent routing before signed event writes.
Soni preserves its registered business/number restriction. No business was linked,
number moved, SMS sent, or voice call placed by this release.

Applied only CRM migrations 20261011192551 (routing) then 20261011192649 (shared
ownership). Filenames match Supabase's assigned history versions. Verified
twilio-webhook v21 and soni-voice-inbound v10 before enabling sharing; crm-api v56
is ACTIVE. Only feature handlers were replaced in their existing live bundles.
Live preflight found zero conflicts and all four paired prerequisites; postflight
found three expected/backfilled claims, no routing mismatches, removed account
uniqueness, and no direct browser/API grants on claims. New private functions deny
anon/authenticated. Security advisor has no ERROR findings; existing pg_net/public
and legacy function warnings remain outside this change. The claims table's RLS
without policies is intentional (no direct grants; private definer access).

Validation: 43 focused CRM checks passed, eight existing skips; four disposable
PostgreSQL concurrency checks passed. 18 isolated release checks and frontend build
passed. Synthetic browser selection verified shared account access, disabled
occupied/reserved numbers, all linked business names, and successful mock connection
without browser errors. Paired E2 checks: 40 passed, two unchanged website display
assertions failed in ownership.test.mjs (Production deployment/Your website starts
here). The new two-owner number/summary isolation check and cache checks passed.
E2 needs no migration or runtime release. Frontend deployment confirmation follows.
See docs/TWILIO_CONNECTIONS.md.


### October 11 — Loading animation and browser cache deployed

CRM `d507c4c00d71ab86a1955594e942eb2a488addc8` is live at
https://crm.e2local.com in Render deployment `dep-db5tg067bikc73e0n9mg`, finished
2026-10-11 18:40:15 UTC (12:40:15 PM America/Denver). The push produced no build
or deployment event; one direct deployment followed inspection of both histories.

Production app.js, auth.js, workspaceCache.js, workspaceWarmup.js,
dashboardLoader.js and dashboard-theme.css match the release commit byte-for-byte.
The homepage and all eight entry/preload assets return HTTP 200; built assets
match the isolated local build and carry immutable caching. Entry bundle is
app-ITLLK7MH.js; Dashboard theme is dashboard-theme-KQEKUQFM.css. Render error
logs are empty. Functional staff navigation was checked with synthetic records,
not a signed-in production staff account.

The isolated checkout was based on production bea0d57. Build and all 37 focused
cache/auth/navigation/Forms/Twilio UI checks passed; isolated browser Forms
navigation had no console errors. The implementation run had already passed
61 CRM and 34 paired E2 checks. Unrelated local website-deployment, form lifecycle,
preview and backend changes were excluded and remain preserved. Only CRM static
assets were released: no migrations, Edge/worker changes, E2 release, or changes
to SMS/AI sending settings. See docs/WORKSPACE_PERFORMANCE.md.

### October 11 — Matching loader and background tab cache (local, unreleased)

The CRM now shares E2 Dashboard's blue ring loading UI, including inline refresh
and reduced-motion states. Permitted tabs warm lazy code and bounded default
summary/directory reads sequentially after foreground rendering. A 60-second,
32-entry / approximately 1 MB sessionStorage cache survives same-tab reloads only
after fresh authorization; scopes include session, user, organization, business
and returned access. Writes, refresh, live updates, visibility return, business
changes and sign-out invalidate saved reads. Errors, auth responses, credentials,
detail records and later/search pages are not persisted. Existing DOM tab memory
continues to preserve drafts; expired retained views indicate that refresh is due.

Validation: frontend build passed; 61 focused CRM checks and 34 paired E2
dashboard checks passed. Browser QA with synthetic records and 350ms API delay
confirmed background GETs use Low priority, warmed Forms opens without a data
request, and reload rechecks auth while restoring Forms from browser storage.
See `docs/WORKSPACE_PERFORMANCE.md` for scope, bounds and limitations. No migrations
were authored or applied, no backend contracts changed, and no release was made
for this work. Production remains the prior `bea0d57` Dashboard redesign.

### October 11 — Dashboard redesign deployed and verified

CRM commit `bea0d574cd22cc5ac468902059aa125cc0598ef2` is deployed on
`deploy-crm`. Render deployment `dep-db5sv4vavr4c739vf230` is LIVE, finished
2026-10-11 18:04:15 UTC (12:04:15 PM America/Denver). The push produced no new
build/deploy event; one explicit deployment followed inspection of both histories.

Production app.js, dashboard-theme.css and dashboardIcons.js match the release
commit byte-for-byte. The new index references app-ZDVA7OT6.js and
dashboard-theme-N6J6PV72.css; all seven referenced entry/preload assets return
200 with immutable caching. The homepage returns 200 and deployment error logs
are empty. Authenticated staff workflows were checked synthetically, not through
a signed-in production session.

The isolated release was based on production `03b9754`; it excludes unrelated
local website-deployment styling, backend/configuration changes and local preview
code. Build and all 16 focused CRM tests passed; paired E2 checks previously
passed 23 tests. Isolated browser checks verified the actual Overview and mobile
drawer/Bookings navigation at 390px without document overflow. The old
dashboardFollowups test still expects retired markup, as documented previously.

Only CRM static assets were released. No database migration, worker/Edge release,
E2 application deployment or sending/AI setting change occurred. Both project
records and workflow documentation are updated; unrelated local work and the
normal Git index are preserved.

### October 11 — E2 Dashboard visual alignment (local only)

The CRM shell now follows the paired E2 Dashboard: 72px white header, 240px
white sidebar, pale workspace, blue selected areas, outlined icons, pill buttons
and white bordered cards. Overview has Inbox, Contacts, Bookings and Forms /
follow-up shortcuts. Existing tool controls appear beneath their selected area;
navigation search, permissions and view retention are preserved. Mobile keeps
the CRM drawer and uses two-column shortcut cards with non-overlapping totals.

Validation: frontend build passed; 16 focused CRM theme, preview, navigation,
page-reader and form-directory tests passed, plus two SMS summary tests. All 23
paired E2 cache/performance/warmup tests passed. Existing dashboardFollowups test
still expects retired followup-section markup (also absent in HEAD), unrelated
to this redesign. Synthetic browser checks covered overview shortcuts, staff
Users/Businesses navigation, Forms, mobile menu/search and 390px overflow.
The synthetic platform fixture lacks the Delivery report API; its error state
was observed after verifying filtered navigation, not treated as live coverage.

Both project records and staff workflow docs updated. Only local source and the
local frontend build changed; no deployment, migration, authentication, service
visibility or shared database contract changed. No cross-project migration order
or prerequisite changes are required. Existing migration histories must not be
replayed. Existing unrelated local changes remain preserved.

### October 10 — Direct contact automation release verified

CRM release `03b9754edb71c4bf55296db238d976442de6b419` is deployed to
`deploy-crm`. Render `dep-db5aroijnfac739r7rpg` is LIVE, finished
2026-10-10 21:28:14 UTC (15:28:14 America/Denver). The push produced no automatic
build; one explicit deployment followed inspection of deploy/event histories.
Production contactAutomations.js, phoneNormalization.js, automationActivity.js
and assets/app-NRJCFDHW.js match the tested isolated release byte-for-byte; the
production index references that app bundle and returns HTTP 200.

CRM API 55 ACTIVE; source migration 20261010210847 is applied as remote
20261010212516_direct_contact_automations. Shared worker SQL is updated; worker
JavaScript/model configuration is unchanged. Production staff-context reads for
contact runs, templates and direct reports pass; unsigned API requests return
401. All four new private tables have RLS, helper browser grants are zero and no
new WARN/ERROR security advisor categories were introduced.

Validation: 81 isolated CRM tests/build, 43 paired E2 tests and nine real
PostgreSQL scenarios passed (four direct/contact races, three coordination and
two SMS/voice shared-capacity directions). Actual-component synthetic browser
checks covered preview, enrollment, stop, blocked reenrollment, async isolation
and mobile 390px layout; no page overflow or console warnings/errors. Production
verification used deployed assets and guarded SQL/API boundaries, not an
interactive authenticated staff browser session.

The single production contact has a valid normalized phone; no messages lack a
contact, and the one supported thread-name mismatch is repaired. Zero direct
runs/templates were created in production. Opek AI remains shadow with
coordination enabled; other businesses remain off. No customer was automatically
enrolled and no E2 application release or live AI activation occurred. Both
project records/workflow docs updated; unrelated local work and the normal Git
index remain preserved. See docs/DIRECT_CONTACT_AUTOMATIONS.md for usage and the
runtime switch that disables direct enrollments/sends without erasing history.

### October 10 — Direct contact database/API deployed; frontend pending

Applied CRM source `20261010210847_direct_contact_automations.sql` as remote
`20261010212516_direct_contact_automations`. CRM API 55 is ACTIVE. Shared scheduler,
sender and AI SQL contracts now understand direct runs; worker JavaScript and
model configuration are unchanged. Do not replay the migration under either name.

Production verification: 1 contact, 0 invalid phones, 0 messages missing contacts,
0 remaining thread-name mismatches, 0 direct enrollments. Private helper browser
grants are zero; no new WARN/ERROR security advisor categories. Staff-context
read smoke passed for templates and direct reporting. Opek remains shadow with
coordination enabled; no business is live. Existing contacts were not enrolled.

Isolated release: 81 CRM tests and production frontend build passed. New direct
coverage includes 12 database/API/lifecycle tests, booking crash recovery and late
provider acceptance after stop. Four real PostgreSQL races and 43 paired E2 tests
passed. Browser synthetic checks verified preview, assignment, stop, blocked
reenrollment and 390px layout; no console warnings/errors. Frontend deployment
verification follows separately. E2 access/cache contracts remain unchanged.

### October 10 — Direct contact automations (local validation)

Implemented contact normalization/integrity, source history, reusable direct SMS
 templates with per-contact snapshots, guarded assignment and overlap choices,
individual run controls, and persistent business/contact enquiry follow-up blocks.
Contacts now links to current runs instead of retired enrollments. Automation
activity has a separate direct funnel and template/origin filters. AI model and
rollout settings are unchanged. No production contact has been enrolled.

Production read-only audit before migration: 1 contact, 0 invalid phone values,
0 messages missing contacts, 1 legacy thread-name mismatch. The forward migration
repairs only that supported display-name mismatch; it does not infer identity or
consent. Histories reconciled through remote activity migration 20261010191143.
Local source migration: 20261010210847_direct_contact_automations.sql.

Validation so far: 11 new contact/direct API/database/lifecycle tests, the prior
47-test CRM regression run, 4 real PostgreSQL races and 43 paired E2 tests passed.
Actual-component browser checks covered schedule preview, enrollment, contact
blocking and mobile width 390px. No horizontal document overflow. Release and
applied migration are recorded separately after verification.

### October 10 — Automation activity release verified

Deployed CRM commit `d4337a2ee216417490323cc6b8140761abf588e3` (initial feature commit
`5204b7088dd694076f96adb4066ee73241868288`) to `deploy-crm`. Render deployment
`dep-db58ubss728c73c8tbmg` is LIVE, finished 2026-10-10 19:17:16 UTC
(13:17:16 America/Denver). The second push again produced no automatic build or
event; one explicit deployment was triggered after checking both histories.
Production `/automationActivity.js`, `assets/chunk-MN7BOYGB.js` and
`assets/app-TE267JGJ.js` match the verified release build, and the production
index references the verified app bundle. Reproduction accounts for Linux
checkout line endings and the local package path used by the fflate import.

CRM API 54 is ACTIVE. CRM source migration
`20261010185337_automation_activity.sql` is applied as remote
`20261010191143_automation_activity`; do not replay either timestamp. Production
staff-context SQL smoke checks pass for enquiry, test and unlinked reports;
unauthenticated API reporting returns 401. All new private tables have RLS and
report helpers are unavailable to browser roles. No new WARN/ERROR advisor
categories were introduced; private no-policy INFO notices are intentional.

Validation: exact isolated release build passed; 50 CRM tests, 43 paired E2 tests
and three real PostgreSQL concurrency checks passed. Browser verification used
the actual component with synthetic local data: filters, empty/error states,
timeline, tags, pause, keyboard focus and 390px layout. Production verification
covered deployed assets, API authentication boundary and database reporting; an
interactive authenticated production staff browser session was not exercised.

Opek remains SHADOW with coordination enabled, zero businesses are live, and all
other businesses remain off. No E2 application release or live AI activation.
Both project records and reporting/workflow docs updated; unrelated local changes
and the normal Git index were preserved.

### October 10 — Automation activity backend deployed

CRM migration source `20261010185337_automation_activity.sql` is applied as remote
`20261010191143_automation_activity`. CRM API 54 is ACTIVE, and unauthenticated
reporting requests return 401. A production staff-context reporting smoke test
passes. All six new private tables have RLS; browser roles have no helper execute
privilege. Security advisors show no new WARN/ERROR categories; the six new
RLS-without-policy INFO entries are intentional private deny-by-default storage.

Initial frontend commit `5204b7088dd694076f96adb4066ee73241868288` went live in Render
`dep-db58s5ks728c73c8m43g` at 2026-10-10 19:12:38 UTC. No automatic build/event followed
the Git push, so one explicit deployment was triggered. A navigation follow-up
remounts live reports instead of restoring disposed tab nodes, clears them on
business/account reset, and focuses the timeline for keyboard users. Its exact
release build and 50 CRM tests pass, including stale reads, refresh cancellation
and visible request failures. Paired E2: 43 passed; real PostgreSQL: three races
passed. The follow-up frontend deployment is tracked in the next release entry.

Opek remains SHADOW with coordination enabled; every other business remains off.
No E2 application release or live AI activation occurred.

### October 10 — Automation activity implementation and local validation

Added the CRM Automation activity tab beside Forms, tenant-scoped reporting,
accepted/delivered activity, first-contact conversion cohorts, current workload,
filtering, enquiry timelines, manual tags and explicit booking/response/AI
attribution. Private lifecycle records are transactional and callback-deduplicated.
Booking corrections keep one primary enquiry and preserve the recorded creator.
Historical unknown transition times stay labeled snapshots; shadow/test/reminder
activity is excluded from enquiry conversions. Existing E2 permissions and cache
contracts remain unchanged.

CRM owns forward migration `20261010185337_automation_activity.sql`, after remote
`20261010184313_inbound_automation_coordination`. Applied histories were reconciled
against both repositories; no previous migration is to be replayed. Local checks:
10 new reporting/API tests pass, 22 CRM reporting/form/API tests pass, 21 existing
agent-database/coordination tests pass, 43 paired E2 tests pass, and three real
PostgreSQL concurrency checks pass. Browser checks cover filters, empty state,
timeline, pause, tags, and a corrected 390px responsive layout.

The isolated release build passes, with 46 CRM tests passing against the exact
release source.

These are local implementation/validation results; deployment is pending at this
entry. Opek remains shadow and other businesses off. See CRM
`docs/AUTOMATION_ACTIVITY.md` for definitions, API and rollback.

### October 10 — Enquiry coordination release verified (shadow only)

Deployed isolated CRM commit `56a83d388af7e10a9ead533ee280d5a128b5b548`
(parent implementation `317fbf0e1d00e2c650094b87e6754da88a0c52c7`) to
`deploy-crm`. Render deployment `dep-db58fv5ckfvc739auub0` is live, finished
2026-10-10 18:46:31 UTC (12:46:31 America/Denver). Both pushes produced no
Render build/deploy events, confirmed through event and deployment history;
one explicit API deployment was then started. Production CRM returns 200;
served Inbound AI and form-editor modules match the tested release.

Backend AI worker 38 matches the tested source. CRM forward migration source
`20261010183109_inbound_automation_coordination.sql` is applied as remote
`20261010184313_inbound_automation_coordination`; do not replay either timestamp.
The existing CRM API/sender RPC contracts required no redeployment. Opek has
coordination enabled in SHADOW only, live validation remains locked, other
businesses are off, and no new coordinated live runs exist. Security advisors
remain unchanged (four prior findings); helper access is denied. Unsigned AI
worker/API calls and the retired validation endpoint return 401.

Final focused tests: 40 passed. Exact release tests: 55 passed, one existing
skip. Broader CRM tests: 79 passed, three existing skips; paired E2: 43 passed.
Real PostgreSQL concurrency and 12 real-model scenarios plus the three-turn
booking passed as recorded below. Synthetic actual-component browser checks
verified the association/quiet-time and outcome tables without console errors.
No new authenticated production staff UI session or real customer SMS was used.
Live activation still requires operational schedules and production shadow /
business review. Both records and workflow docs are updated locally; no E2
application deployment or E2-owned migration was required. The original Git
index and unrelated working changes were preserved using an isolated release.

### October 10 — Inbound AI / form coordination (backend deployed, shadow only)

Backend release: applied this source once as remote migration
`20261010184313_inbound_automation_coordination`; AI worker 38 is ACTIVE.
Opek coordination is enabled in shadow with live validation still locked; no
other businesses are enabled. No CRM API or sender redeployment was required:
their existing RPC contracts dispatch the updated database routines. Frontend
publication is pending below. The exact isolated release build passed and its
56 tests completed with 55 passed and one existing skip. Final focused tests
passed all 40 cases. The temporary model validation endpoint is retired (v4).

Added automation context and scoped enquiry association to the existing GPT 6.1 Sol
worker. Continue enquiry sequences defer during AI processing and for 30 minutes
after inbound texts or accepted AI replies; deferral preserves the queue item,
attempt budget and sequence cursor. Paused runs still require staff resume.
Appointment reminders retain their original policies. Confirmed bookings stop only
the associated enquiry; explicit declines use a scoped, evidence-checked tool;
staff handoff pauses an associated enquiry only. Cross-customer references and
unrelated YES confirmations fail closed. Shadow records proposed actions without
applying coordination mutations. The staff Inbound AI view shows association,
reason, quiet time and proposed outcomes.

CRM owns forward migration 20261010183109_inbound_automation_coordination. Its
prerequisite inbound_sms_agent is already applied as remote 20261010175821; do not
replay its local timestamp or either repository history. The new coordination
switch defaults off; Opek will remain shadow only after release. E2 service access,
customer ownership and booking/reminder hooks remain unchanged.

Validation: 79 CRM tests passed with three existing skips; 43 paired E2 tests
passed. Real PostgreSQL verified inbound/send and close/send races, duplicate
webhooks, lease recovery and shared SMS/voice capacity in both orders. Twelve
synthetic real-model coordination scenarios plus a three-turn linked booking
passed (one appointment); Codex reviewed replies and tool arguments. Estimated
API cost $0.044206. Provider acceptance was simulated; no customer SMS was sent.
Production migration rollback rehearsal passed with private helper denial and
sender access verified. Synthetic browser checks verified coordination/outcome
rendering and no console errors. Live activation still requires operational
schedules and production shadow/business review. Unrelated local work is preserved.

### October 10 — Inbound AI frontend deployed

User confirmed Micah's Render workspace. Fast-forwarded `deploy-crm` to the
tested isolated release `1ffa88f14ccc177b8c7492274d4656ebd47dff24`. Render did not
create an automatic build/event, so one API deployment was started after checking
the queue/history. Deployment `dep-db583fks728c73c66stg` is live, completed at
18:19:53 UTC (12:19:53 PM America/Denver). `https://crm.e2local.com` returns 200,
contains Inbound AI navigation, and serves an Inbound AI module matching the
release source. The bundled Inbound AI asset also returns 200 with the configured
model. This is asset verification, not a new authenticated staff UI session.

Backend versions/migration and model evaluation are recorded below. Opek remains
shadow only with live validation locked; no service schedules were invented or
customer replies enabled. Supabase and existing OpenAI credentials already work,
so no new login authorization is required. Both project records and rollout docs
are updated locally; unrelated checkout edits remain untouched.

### October 10 — Inbound AI backend released; Opek shadow enabled

Direct WPacquisition access succeeded despite omission from project discovery.
Reconciled remote CRM/E2 histories through E2 `20261009053203`, rehearsed the
new migration in a rollback transaction, then applied local
`20261010171755_inbound_sms_agent.sql` as remote `20261010175821_inbound_sms_agent`.
These are the same migration; do not replay it under the local timestamp.
Deployed AI worker 37, CRM API 53, SMS worker 20 and Twilio webhook 20. Deno checks
passed; workers/settings reject unsigned access (401), and unsigned inbound
webhook requests return 403. All four private tables have RLS; shared cores and
new RPCs have no anon/authenticated execute access. Advisors added only four
expected private-table no-policy notices; prior extension/legacy RPC warnings
remain outside this release.

Existing server credentials successfully accessed GPT 6.1 Sol. Evaluated and
reviewed 50 supported plus 20 adversarial synthetic messages against real
Responses with an isolated database: zero provider failures, unauthorized data
disclosures, false booking confirmations or shadow side effects observed.
All 50 supported tool choices matched expectations. A separate real-model booking
conversation prepared, confirmed after YES and handled a repeated YES with one
appointment total. Provider acceptance was simulated; no real SMS was sent.
Estimated model cost was $0.20767. `data/inbound-agent-review.json` records the
Codex review and limitations; business review remains pending. A temporary
authenticated, expiring validation function used the server key without extracting
it; it is now retired with JWT verification and a 410-only handler.

Opek is in shadow mode; AI queue dispatch is enabled. No live validation marker
was set. There are no Opek service schedules and the approved profile timezone is
UTC, so staff must review operational schedules and shadow observations before
live activation. All other businesses remain default off. The focused suite
passed all 29 tests again. Frontend release is pending the Render connector's
required workspace confirmation. See [release guide](docs/INBOUND_AI.md).

Published isolated source commit `1ffa88f14ccc177b8c7492274d4656ebd47dff24` on
`codex/inbound-sms-release`. Its exact archived source built and passed 56 tests
with three existing skips after supplying the paired E2 migration fixture path.
Working-tree checks passed 57 with three skips (one additional unrelated local
test). The release commit excludes unrelated local edits and leaves the checkout
and original index intact. HTTPS push succeeded after SSH host verification was
unavailable; no host-key protections were changed. Render deployment remains
pending the connector's explicit workspace-selection requirement.

### October 10 — GPT 6.1 Sol inbound SMS agent (local, release pending)

Implemented the versioned `sms-agent-v1` inbound worker with direct OpenAI
Responses requests, low reasoning, standard tier, `store:false`, bounded tools
and deterministic booking/handoff replies. Added staff Inbound AI settings,
off/shadow/live modes, revision checking, booking permission, recent run metrics,
scoped pause/resume and manual takeover. All businesses default off; only Opek
may enter the pilot and live requires a separately recorded validation gate.

CRM-owned forward migration `20261010171755_inbound_sms_agent.sql` extracts
shared booking prepare/commit functions while retaining voice authentication,
OTP wrappers and endpoint contracts. SMS and voice share service/resource
capacity locks; SMS appointments retain existing intake/reminder hooks with
source `sms`. Confirmation is bound to an accepted exact proposal and schedule
version; corrections/expiry require preparation again. Stable action records
recover committed bookings and repeated confirmations without duplication.
STOP, newer inputs, staff replies and settings changes fence execution and
pending sends. Staff handoff pauses atomically; shadow has no action side effects.
Form Pause/Continue and retired automation boundaries remain intact.

Validation: broad CRM worker/conversation/form/booking/voice/API batch passed
78 tests, with nine existing disabled-legacy skips. The final focused inbound
suite passed all 29, including atomic handoff pause/crash recovery. Paired E2 booking, enquiry,
service-access and cache batch passed all 48 against local CRM and relevant E2
migrations. Real PostgreSQL 17.10 concurrency passed voice-first and SMS-first
capacity contention with independent sessions. Provider/queue/Vault services
were fixtures. Frontend build and scoped whitespace checks passed. Synthetic
actual-component browser check verified saving shadow settings, disabled live
gate and knowledge/availability links; screenshot is in ignored
`data/inbound-ai-settings.png`. No authenticated production UI was exercised.

Prepared an isolated real-model evaluator with 50 supported and 20 adversarial
scenarios, not yet run: `OPENAI_API_KEY` is unavailable. Recommend a dedicated
OpenAI API project key in WPacquisition Edge Function secrets. The connected
Supabase account exposes Hobby Projects, not WPacquisition; production applied
histories cannot yet be verified. No migration was applied, no deployment or
activation occurred, and no customer messages were sent. The forward migration
requires CRM `20261006065213` and the existing paired baseline, including CRM
`20261003143731` before E2 `20261003145302`; never replay either history. No E2
schema or customer-permission change is needed. See [Inbound AI](docs/INBOUND_AI.md)
for release gates, commands and rollback. Existing unrelated local work is retained.

### October 10 — Deactivate and recoverably delete forms (local)

Added editor-only Deactivate form and Delete form controls to the Forms workspace,
including its Automation tab. Inline confirmations explain consequences and keep
Cancel focused initially. Delete uses the existing archive action, per the user's
choice to preserve history and allow restore. Current forms excludes deleted
forms; Deleted forms exposes Restore as draft. Inactive forms no longer count as
active automations, and the Automation header reports their inactive state.

Deactivation uses the existing form-save transaction after reading current saved
fields: collection is disabled, active SMS runs pause, active email enrollments
cancel, and the published sequence setting/history remain. Archive disables the
sequence and stops active/paused runs. Restore never re-enables collection or
restarts stopped runs. Actions retain the original business scope, invalidate
cached reads and suppress late rendering after navigation; failures remain
retryable. Existing editor/reader/customer permissions and E2 visibility apply.

Validation: CRM production build and 30 focused CRM tests passed, including real
paired-schema assertions for deactivation, editor/reader denial, stopped runs,
retained submissions/versions and inactive restore. Eleven E2 enquiry/service
schema tests passed using both migration histories. Existing CRM-first form
migration 20261003143731 followed by E2 20261003145302 remains the prerequisite;
no new migration or API release is required. Synthetic desktop browser checks
verified cancel, deactivate, delete, Deleted filter and restore with retained
counts; a 390px confirmation had matching 375px content/scroll widths. The first
native browser-confirm check hit a tooling timeout; the final inline confirmation
flow passed in a fresh tab with no console errors. No live customer forms,
provider messages, schema, deployment, commit or push were changed. Release only
the CRM frontend for these controls; unrelated local work remains preserved.

### October 10 — Website deployment page simplified (local)

Website details now open on Deployments (formerly Assets), with a flat production
status panel, folder/ZIP upload choices, collapsible file requirements and compact
version rows. Preview/Publish remain prominent; View files and protected deletion
are under More. The old Dashboard tab is labeled Settings. Existing tab keys,
upload/build/publish APIs, business assignment and customer access are unchanged.
No migration, provider change, push or deployment was performed.

Validation: CRM production build, nine CRM tests and thirteen paired E2 hosting
lifecycle/tab tests passed. Synthetic actual-component desktop and 390px browser
checks verified default navigation, keyboard tab switching, file requirements,
saved-file viewing, live deletion protection and empty-upload feedback. Mobile
content/scroll widths both measured 375px and browser error logs were empty.
The earlier live pilot remains unpublished and blocked at file selection; this
redesign did not resume or publish it. Unrelated changes remain preserved.

### October 10 — CRM website creation and deployment verification

Traced the existing CRM create/upload/preview/publish flow against the paired E2
hosting routes, private R2 storage and delivery Worker. Fixed a root-file mismatch:
CRM and E2 upload validation accepted uppercase `INDEX.html`, but the builder and
Worker require exact lowercase `index.html`. Both validators now reject it before
creating an unusable deployment. Assets explains static build output and separate
preview/publish steps. Source projects still require compilation before upload.

Added E2 `tests/hosting-lifecycle.test.mjs`, using the real CRM file preparer, E2
routes/build and Worker with in-memory database/storage. It covers creation,
preview isolation, publish, restore, unpublish, incomplete-upload recovery,
invalid files/addresses, unsigned access and cross-site deployment rejection.
13 CRM tests, 40 E2 tests (including 11 paired-schema/access tests), four Worker
tests, both production builds, scoped E2 lint and Worker TypeScript passed.
The combined migration harness preserved CRM prerequisite `20261001235349`
before E2 lifecycle `20261001235352`; no new migration is needed or was applied.

Live browser verification: existing customer website reported published; staff
created `crm-check-20261010`, named CRM Hosting Verification — temporary. It is
unassigned, unpublished and has zero deployments. Chrome's extension denied
local file selection twice, including the user's requested retry, because its
file-URL permission is off. The tool also blocked opening chrome://extensions.
Production upload, preview and publish therefore remain unverified. Two harmless
pilot files are saved under ignored `data/hosting-verification/` for manual
selection. Resume with this existing test site; do not create a duplicate.
After a successful pilot, unpublish the test site. No existing site, business,
owner or service release was changed. No source commit, push or application
release was performed; the validation fix remains local. Unrelated edits remain.

### Dashboard and website requests release verified

E2 application 67a320a is READY in Vercel deployment
dpl_BdcTfCABPF8emjEzXSA5xdBY2Fac, assigned to www.e2local.com and e2local.com.
CRM application 7c43c2e is live in Render deployment dep-db4888qd0e5s73f40pq0.
The dashboard header, sidebar, AI Assistant preview and Website workspace are
released. Saved requests and staff status/replies are active. Assets remain
browser-local previews, Domain connection remains unwired, and no AI model
is connected. No live asset storage, DNS changes or customer test requests were created.

Applied only E2 migration 20261009053203 after a successful production rollback
rehearsal. RLS/grant assertions pass; the security advisor reports no errors.
Both production roots return 200; unsigned customer requests redirect to sign-in
and staff requests return 401. The deployed CRM request chunk exactly matches the
staged build; raw source matches after line-ending normalization. Builds, scoped
lint, 40 E2 tests and 10 CRM tests passed. Desktop/mobile fixture navigation and
layout were verified; authenticated production rendering/submission was not tested.
The existing unrelated local changes remain outside these commits.


### October 8 — Customer website requests release prepared

Added the staff Websites Update requests inbox with status and customer-visible
replies. The paired E2 migration passed a live rollback rehearsal and grants/RLS
assertions; release order is new E2 migration, E2 API/UI, then CRM frontend.
40 E2 tests and 10 CRM API/render/tab-memory tests passed. Asset storage and
domain connection remain previews. Deployment is authorized and pending.


### October 8 — Website update requests, local implementation

The paired E2 customer Website tab now includes a saved update-request workflow.
CRM Websites has an Update requests inbox for statuses and customer-visible
replies, served by the E2 hosting API using existing staff authorization. Customer
reads remain scoped to the submitting account, authorized site and current site
business; staff changes use revisions. No website publication happens here.
Asset selection and domain connection remain customer-side previews; no live
storage was created. No database migration or app release was performed.

The E2-owned `20261009053203_website_update_requests.sql` migration must follow
the existing paired platform/login/service schemas, then E2 API/UI release,
then this CRM frontend release. No CRM migration is required; never replay either
repository's history. E2 build/TypeScript/lint, CRM frontend build, 35 E2 combined
schema/access/API tests and ten CRM tests passed. Synthetic browser checks
verified customer retry/draft behavior and staff status/reply persistence.
Details: [paired Website workspace](../E2local-main/docs/website-workspace.md).

### October 8 — Voice history and playback in Inbound calls

Reports → Inbound calls now mounts the same staff voice call history and detail
viewer as Voice Agent, including filters, paging, duration, agent, outcome,
transcripts, linked bookings and Listen controls. Listen fetches the existing
private five-minute signed recording URL on demand and exposes browser playback
and download. Failed loads can retry, and late media responses cannot populate a
different call's player. Separate report state resets when the business changes.
Provider-history calls without recovered media now say Unavailable. Existing
non-agent call records remain below when present; non-staff access is unchanged.

Validation: 14 CRM voice/API/media-expiry/cache tests and 7 paired E2 booking/
access/cache tests passed. A synthetic browser recording reached readyState 4,
played with advancing time and no media error; report details and recovered-audio
labels were verified. Exact staged frontend build passed. This verifies the player,
not a new production phone recording. No database/Edge/E2 release is required.
CRM source 919252f submitted to Render deploy dep-db476gnlot8c738249b0; release
verification is recorded in docs/VOICE_CRM.md. Unrelated work remains preserved.


### October 8 — Forms and automation dashboard

The CRM Dashboard now lists every form for the current business instead of legacy
category follow-up cards. Dashboard and Forms share a searchable directory with
All/Live/Draft/Archived filters, aggregate and per-form all-time submission counts,
automation state and published version, descriptions, types, fields, IDs and dates.
Submissions and Automation actions open the selected form directly. Archived forms
remain visible and contribute to submission totals but not active-form totals.
Missing counts show Unavailable; failed reads never appear as zero. Existing
submission-access controls remain in effect. Creation dates absent from the
existing data are shown as Not recorded; no historical dates were invented.

Validation: 24 CRM form/API/cache/security tests and 13 paired E2 enquiry/access/
cache tests passed. Browser checks verified filtering, search, direct submissions
navigation, return to the directory and mobile layout without horizontal overflow.
The exact staged frontend built successfully. No shared contract, migration, Edge
function or E2 frontend change was needed; unrelated local work was preserved.

Released source fb034d259fed439ef1ae0e2ef9b04c533d58ac96 to crm.e2local.com in
Render deploy dep-db472am0tbcc73dcaueg, live October 9 at 04:44:43 UTC. Served form
directory/workspace chunks match the tested build exactly; dashboard code matches
after normalizing the unrelated platform asset hash.


### October 8 — Fixed missing voice call history and recovered provider metadata

Investigated the empty Voice Agent history reported by staff. The screenshot was
the Leads tab, but the underlying call table was also empty. Twilio confirmed two
inbound calls with completed LiveKit SIP legs after the October 6 integration
release. The October 8 session produced one successful configuration request and
15 HTTP 400 runtime requests. No caller payloads were included in diagnostic output.

Root cause: runtime and booking adapters JSON.stringify-ed objects before passing
them to Postgres.js. Its inferred JSONB serializer encoded those strings again,
so call start could not read the room field and rejected it as a non-phone room.
The earlier PGlite/function tests missed this wire-level difference. Adapters now
pass objects directly. The same correction covers maintenance deletion acknowledgments
and booking payloads. No grants, tenant boundaries or feature flags were changed.

Validation: 15 CRM tests (including an actual Postgres.js serializer regression),
7 paired E2 database/access/cache tests, and the staged frontend build passed.
The old failure was reproduced against live PostgreSQL; the fixed adapter completed
start and finish inside a rolled-back transaction. Deployed source was read back
and verified. Staff database reads and unauthorized-access denials still pass.
An extra signed write probe was blocked by automatic policy review; it was not
retried. Read-only deployed-source verification was used instead.

Deployed voice-runtime v3, voice-maintenance v3 and voice-booking v4, all ACTIVE.
CRM source 3e4eabd is live in Render deploy dep-db46pocs728c739p58h0
(finished October 9 at 04:26 UTC). Its served Voice Agent module matches the tested
build. It includes a truthful 'Not captured' configuration label for
provider-history recovery. Two real call metadata records were restored atomically
and idempotently from matched provider parent/SIP-leg evidence, with original SIP
start/end/duration, unknown outcome/configuration and missing media clearly marked.
Recovery created no leads, contacts, bookings or consent. Original retention dates
were preserved. CRM now contains two calls and zero qualified voice leads.

Audio/transcripts were not recovered: Twilio returned no matching recording and
the LiveKit Analytics API denied access (403). This does not prove no LiveKit copy
exists. A new real SIP call and end-to-end audio upload remain unverified after
the fix. Voice booking stays disabled pending the existing pilot. No migration,
E2 frontend release or voice-worker deployment was necessary. Unrelated edits
remain preserved.


### October 6 — Removed ZIP and dumpster-size fields from agent booking

At the user's request, agent booking no longer requires ZIP coverage or dumpster
size in CRM or the voice tools. Availability selects one enabled schedule per
service; a partial unique index prevents ambiguous enabled schedules. Full service
address, time zone, duration (including multi-day rentals), pool capacity,
verification, recap, expiry, rule-version checks and idempotency remain enforced.
Legacy columns/payloads remain compatible; existing records were not rewritten.

CRM-owned forward migration 20261006065213 was rehearsed with save/preview in a
rolled-back transaction, then applied once after 20261006060755. Live rule count
was zero. Restricted live availability accepts service/date without removed
fields. Security advisors reported no errors. No schedules or customer records
were created and booking remains disabled. E2 customer access is unchanged.

18 CRM tests, 22 paired E2 tests, all 48 Python tests and the exact staged frontend
build passed. A browser fixture using the real editor saved a dumpster schedule
without either field. CRM source cce0e3a is live in Render deployment
dep-db29nabncjis73du0rdg; the deployed booking module matches the tested build.
LiveKit KsbH9doie9Ur is Running; an RTC probe verified the unchanged published CRM
configuration. No physical phone pilot was performed. Unrelated local edits were
excluded. No Edge redeployment was needed because its payload already allowed
omitting these keys; the database and worker implement the changed requirements.


### October 6 — CRM availability and Voice Agent integration released

Released CRM source dc9b49f to https://crm.e2local.com in the user-confirmed
Micah's workspace. Render deployment dep-db29enbbc2fs73fpda40 is live. The exact
staged frontend built successfully and passed 29 CRM checks; deployed app and
availability/voice modules match it (nested chunk filenames normalized). The
production browser displays the sign-in gate; a signed-in staff browser session
was unavailable for this release check.

Applied only CRM forward migration 20261006060755 after a rolled-back rehearsal
and reconciliation of existing 20261006053509/lookup prerequisites. Provisioned
separate runtime/maintenance login roles and Vault cleanup secret through the
authenticated Management SQL API, using bootstrap-equivalent SQL and recovery
credentials written first under ignored data/. No histories were replayed.
Imported the previously verified production prompt pair as CRM revision
1747c5d0-86d9-4699-808f-7abf640108cf. LiveKit version tWp9DZbhN4j8 is Running;
a temporary RTC probe verified that it loads this revision with Vesper. The probe
did not start a model conversation or create a call/lead/booking record.

Live Edge status: crm-api v52, voice-runtime v2, voice-maintenance v2,
voice-lookup v5 and voice-booking v3 ACTIVE. Signed configuration reads and
maintenance succeeded; unsigned endpoints returned 401. Live staff SQL reads
passed and unauthorized reads were denied. Restricted logins cannot access the
private schema or booking API. The recording bucket is private. Security advisors
reported five existing warnings and no new voice-object findings.

CRM runtime is enabled; lookup remains independent. Voice booking stays disabled
and no schedules were seeded: live calls, operational bookings, settings and voice
rules were all zero at verification. Business UTC was preserved. The local old
production publisher is now directed to CRM. Real phone/audio/OTP/booking pilot
and observed revision from an actual SIP call remain outstanding. Earlier local
validation passed 46 paired E2 and 47 Python tests plus browser draft/save/mobile
checks; these are separate from live verification. E2 needs no frontend release
for these private CRM additions. Unrelated local changes were excluded.


### October 6 — Voice Agent CRM workspace implemented locally

Added the Opek Voice Agent workspace, configuration drafts/publish/rollback,
private calls/audio/transcripts, qualified voice leads and atomic booking attribution.
The worker loads per-call published snapshots and preserves existing lookup,
verification, consent, booking-capacity and persona mismatch safeguards. New runtime
and maintenance roles are separate and narrow. CRM audio/transcripts expire after
90 days; customer E2 visibility is unchanged. New forward migration is
20261006060755_voice_crm_workspace, dependent on 20261006053509 and existing paired
account/service prerequisites. No earlier migration was modified.

Local validation: 29 CRM checks, 46 paired E2 checks, all 47 Python tests and the CRM
frontend build passed. Browser checks covered draft preservation, saved reload,
call details/transcripts and 390px mobile layout. Production import, new migration,
Edge/worker/frontend releases and controlled phone-recording pilot are not yet
verified at this checkpoint. Existing unrelated local changes remain preserved.
See CRM docs/VOICE_CRM.md for contracts, rollout and operational limitations.


### October 5 — availability backend and voice-worker deployment verified

CRM API v49 and voice-booking v1 are ACTIVE. LiveKit voice-agent-phone version
rSSD7nP25dsn deployed successfully and reports Running. A temporary RTC probe
verified database_lookups=true, voice_booking=false, Vesper, and the unchanged
prompt revision fd70eef16bd943d69522e2e2f0765260. The probe did not start an OpenAI
conversation and its temporary room was removed. A signed booking request is
blocked by the disabled Edge flag (503); unsigned CRM preview returns 401.
Live counts remain zero for booking settings, voice rules and operational bookings.
No physical phone/OTP booking pilot was performed. The CRM frontend build and
actual-component browser checks passed; its Render release awaits explicit
selection of Micah's workspace required by the connector. Source remains local
and uncommitted; unrelated local changes were preserved.

### October 5 — CRM availability and scoped voice booking

Implemented CRM split-day schedules, structured date exceptions, strict validation,
independent drafts and database-backed slot previews. Conversational SMS stays
inactive; voice retains separate crew/equipment capacity. Added a separate,
provider-bound HMAC booking endpoint with a restricted database role and only
availability/prepare/confirm. The sibling voice agent now supports verified new
bookings after completed recap playback and a fresh affirmative caller response;
network retries retain the same preparation. Rescheduling/cancellation remain out
of scope. No customer permission or website-form booking behavior changed.

Validation: 48 selected CRM checks passed, two disabled-SMS checks skipped; 41
paired E2 account/service/cache/booking checks and all 41 voice-agent Python tests
passed. Fixed the E2 booking test to create its required form explicitly. CRM build
passed; synthetic actual-component browser checks verified independent drafts,
split windows, save/reload and 390px layout. Real phone booking remains untested.

Reconciled live history, including voice bridge alias 20260926141343 and lookup
migrations 20261005200000/20261005203000. Applied only CRM forward migration
20261006053509_booking_availability_voice after a rolled-back rehearsal. CRM and
voice-booking Edge APIs deployed; restricted-login availability succeeded, direct
tables/private legacy calls were denied, security advisors found no errors, and
unsigned CRM preview returned 401. Edge and agent booking flags remain false.
No live schedules, bookings, provider settings, verification texts or E2 runtime
release were created. Existing unrelated working changes are preserved.

See CRM docs/BOOKING_AVAILABILITY.md and voice agent/README.md for setup and rollout.
Frontend workspace selection and voice-worker release verification were still
pending when this implementation entry was written; later release notes supersede
that checkpoint.

### October 4 - CRM page-load performance production release

CRM application commit `51f21b21135d2e3aacd7e2c7a943129464e575bb` is live
at https://crm.e2local.com on Render deployment
`dep-db0vm9ou01pc73c5il3g` (build and deploy completed in 12 seconds).
The push did not start an automatic deploy; a cleared-cache deploy was triggered.
Live service headers now cache hashed /assets/* as public, max-age=31536000,
immutable and revalidate /config.js with no-cache. HTML remains revalidated.

The isolated staged release passed its production build and all 22 targeted
checks, excluding unrelated local preview/auth edits. All eight emitted assets
returned 200 with immutable headers and matched that release after normalizing
platform-dependent chunk filenames; the underlying hosting-upload chunk bytes
were identical despite its Linux/Windows filename hash difference. Live initial
application JS is two files, 171,819 raw bytes / 47,208 summed gzip bytes, versus
387,149 / 105,743 before (about 55% less compressed application JS). This excludes
external Clerk/vendor scripts and is not an end-to-end page timing benchmark.

Signed-in production checks verified Dashboard totals/connection, Forms listing,
lazy Platform Users and return navigation; browser warning/error logs were empty.
No business data was edited or messages sent. No migrations, API/worker release,
E2 runtime deployment or identity/provider changes were part of this CRM release.
Both project records and staff workflow docs were updated; unrelated local work
was preserved. The earlier E2 cache mock failures were fixed by concurrent E2 work.

### October 4 - dashboard performance production release

E2 application commit `e09f7951aa37d5a7ffe83d54cfe327f880753794` was pushed to
`main`. Vercel deployment `dpl_EN7cy9QnNg1DdHmMPi8dMvi2Z6W9` completed Ready
in 28 seconds and was verified Current in Production with `www.e2local.com`
assigned. The signed-in production dashboard loaded successfully; Overview,
Leads, Website publication details and SMS connection details rendered correctly.
Browser warning/error logs were empty. These are live functional checks, not a
controlled performance benchmark; production phone timings remain unmeasured.
The prior entry records the local regression, lint, TypeScript and build results.
No database migrations, Clerk configuration changes, CRM runtime deployment or
provider changes were performed. Unrelated local CRM/documentation edits remain
preserved.

### October 3 - E2 progressive dashboard performance (local, not deployed)

E2 entry now uses the existing fast verified identity/access reader instead of
blocking on Clerk profile synchronization. Signed lifecycle webhooks and the
missing-identity provisioning fallback remain. Cold bootstrap returns authorized
business/service navigation in one request (four backend calls); a matching
account/session/revision hint returns state only (two calls). Overview loads
independently using an authorized website count, five recent leads and booking
totals. Website deployment history, the storage SDK and R2 manifests are deferred
until Website is visited. Detailed Leads/Bookings pages and all five secondary
panel bundles load on demand. Legacy snapshot clients remain compatible.

Browser schema 5 stores the separate resources. Focus revalidation keeps panels
mounted behind a hidden/inert access gate; unchanged revisions retain drafts and
pagination. Session changes, denial and changed revisions still clear/isolate
protected data. Before/after revision checks, late-response generation checks,
service release rules and the account-wide Refresh limit remain in force.

Validation actually performed: all 26 cache/request/performance tests passed,
including seven new bootstrap, summary, isolation and race regressions. Full E2
suite: 145 passed, three older database fixture failures reproduced from the
unchanged HEAD baseline (bookings default form and two platform default-form
assumptions). Nineteen paired CRM account/business/API/tab tests passed. E2 lint
and production build including TypeScript passed; deferred chunks are emitted.
Actual-component browser checks verified early navigation while summaries were
artificially delayed 1.5 seconds, one-request cached reload, deferred service
reads, no tab-revisit reads, draft/pagination retention after focus validation,
and revoked service removal on Refresh. The 390px frame had no document overflow
and no browser warnings/errors. Authenticated production timing remains unmeasured.
The transient cache mock failures recorded during concurrent CRM work are fixed.

Compared both records, customer/CRM identity flows, lifecycle webhooks and shared
readers. No new schema or shared reader contract: no migrations or new paired
migration prerequisites; existing owning-repository order remains unchanged.
No live database, Clerk configuration, provider, deployment or release changes.
Existing unrelated/concurrent CRM and documentation edits were preserved.
See E2 docs/dashboard-cache.md, docs/accounts.md and docs/api-reference.md.

### October 3 - CRM page-load performance (local, not deployed)

CRM startup reuses the authorized /auth/me workspace payload, retaining /tenants
fallback for older/local servers and fresh reads on workspace changes. Dashboard
totals, SMS connection and categories load concurrently; totals paint early and
provisioning is deferred to SMS setup. Categories are fetched only by views that
use them. No identity, permission or shared database contract changed.

Forms reuses its directory payload in the editor and across internal tabs, loads
automation rules/presets concurrently, and caches presets within the tenant's
Forms workspace. Writes, explicit refresh, workspace/session changes and failed
reads invalidate or discard cached data. Navigation aborts unfinished main-page
GET/HEAD reads while retaining the render queue and never aborting mutations.
Cached tab nodes continue to preserve drafts. Platform detail operations still
use their existing completion guard.

The frontend build now minifies and splits application code into content-hashed
assets. Forms/platform editors load on demand; the shared auth module stays a
singleton. Initial application JS falls from 20 modules / 387,149 raw bytes
(105,743 bytes summed gzip) to 2 files / 171,878 raw bytes (47,223 summed gzip).
These are local build measurements, excluding external Clerk/vendor scripts.
Render Blueprint adds immutable caching only for hashed /assets/* and revalidates
/config.js. These header settings have not been applied to the live service.

Validation: full CRM suite 232 passed, 29 existing skips; final targeted checks
22 passed and production build passed. E2 paired checks: 28 passed, two
dashboard-cache mock failures (Unexpected import @/lib/business-services) in the
E2 working tree. Concurrent E2 runtime edits were observed and left untouched. Built-browser synthetic checks verified dashboard,
Forms and lazy platform loading, one form-list read across editor/subtab visits,
one preset read across repeated Automation visits, and preservation of an unsaved
form title. An injected 8-second Bookings response was cancelled after 77 ms on
navigation. Build inspection confirmed one auth module and valid hashed URLs.

No migrations, API/worker deployment, live cache-header changes or releases were
performed. No E2 runtime changes or cross-project migration prerequisites are
needed; do not replay either migration history. Existing unrelated local changes
remain preserved.

### October 3 - actual SMS form test sequences

The form tester now offers Prepare real SMS test, then Start real SMS test after
showing the recipient, full configured send count and first scheduled time.
Staff confirms control of the phone and consent. Tests snapshot current rules and
use the normal automation scheduler, Twilio sending worker, provider acceptance,
delivery callbacks, reply policy, opt-out fencing and business sending controls.
Configured delays/windows/repeats remain intact; this is not an immediate-send
shortcut. The panel refreshes delivery progress and offers Stop test for future
sends. Simulation remains available separately.

CRM migration 20261004033035_form_live_test_runs adds isolated test snapshots to
private form runs. Tests may use a disabled draft form without publishing or
enabling it. They create consent/contact/message history but no customer form
submission, intake or E2 Lead. SMS-read accounts can view safe progress; starting
and stopping require existing CRM staff permissions. Duplicate starts reuse their
request ID, an active/paused test cannot overlap the same form/phone, and uncertain
provider sends block a new run. A real opted-out phone is never reconsented by test.
The forward migration also fixes ambiguous dropdown validation in the preview.

Validated 27 CRM tests (including the complete send-worker boundary with a mocked
Twilio client, repeat advancement, stop/reply/opt-out, access and idempotency),
19 paired E2 Leads/cache/access tests, production frontend build, desktop/mobile
start-review-stop controls and absence of test submissions in the owner reader.
Nine production function baselines matched before applying only the new migration.
The migration and CRM API v45 are deployed. Application 746a783 is live in
Render dep-db0sqhc9v7es73csg5q0, and all seven changed frontend assets match
source. Authenticated production shows the actual-send controls, connected number,
sending-enabled state and safe test history, with no browser errors. Security
advisors retain the same five existing findings.
No production test sequence was started during verification. E2 has no runtime or
migration change; both repositories' unrelated local changes remain preserved.

### October 3 - form submission and automation simulation

CRM Forms now include an interactive Preview & test panel, also available under
Automation. Users enter sample answers, choose a local start/appointment time and
simulate no reply, a reply or STOP after the first message. Form preview uses
current unsaved fields and saved draft rules; Automation uses unsaved editor rules.
Results show personalized texts, numbered repeats and estimated business-timezone
send times, plus separate live-readiness warnings. The first 200 sends are shown
with the full configured count. Existing live delivery/activation is unchanged.

CRM migration 20261004021248_form_automation_preview adds a private, stable,
tenant-authorized reader used by POST /api/web-forms/:id/preview. It reuses the
existing rule validator and form_due scheduler. SMS-read permission is required;
forms-only editors retain interactive fields without automation-read access.
No contacts, submissions, runs, jobs, texts or E2 Leads are created by simulation.
No E2 migration or runtime change is required. Prerequisites: CRM form-first
20261003143731, E2 canonical access 20261002024330 and current unified-leads
20261003231755 baseline. Never replay either migration history.

Validated 23 CRM API/form/database tests, 19 paired E2 Leads/cache/access tests,
frontend build, desktop and 390px mobile behavior, unsaved repeats and reply pause.
Four live prerequisite function hashes matched the paired baseline. The single
CRM forward migration and CRM API v44 are deployed. CRM application 0d54190
is live in Render dep-db0rln49v7es73co4vo0; all seven changed frontend assets
match source. Security advisors retain five existing findings with no new finding.
Authenticated production form validation and automation simulation are verified.
Existing unrelated local changes remain excluded.

### October 3 - unified customer Leads and visible SMS numbers

E2 now exposes one Leads tab for released SMS or enquiries services, combining
existing SMS form submissions and authorized website enquiries without creating
copies. Business/form filters, automatic tags, inline answers, nullable website
attribution, safe run statuses and stable pagination preserve tenant isolation.
SMS release includes SMS leads even when sending is disabled; website metadata
and ownership-history cutoffs remain protected. Overview displays connected SMS
numbers per business; SMS details remain read-only. Browser cache schema 4 drops
pre-unification snapshots, with existing scoped triggers refreshing new changes.

Validated 58 relevant E2 tests (including five new customer-reader scenarios),
16 paired CRM tests, changed-source lint and E2 production build. Synthetic desktop
and 390px mobile checks verified filters, inline answers and pagination; mobile
filters were corrected to stack without horizontal overflow. Live migration
20261003231755_customer_unified_leads was applied only after matching five shared
function baselines and paired history prerequisites. Security advisors retain
five existing findings with no new finding. Application `a4e84e1` is Ready on
Vercel `dpl_J9da1mqBGTC4yEwt6xZoB2BsmsFS`, assigned to www.e2local.com.
Authenticated production verification confirmed the overview phone/status, Leads
navigation, all current form choices, filters, empty-state counts and mobile
layout without horizontal overflow or console errors. The live RPC grants execution
only to service_role among customer/CRM roles tested. CRM runtime is unchanged.
No Twilio changes, sends, jobs or copied submissions were created by these reads.

### October 3 — standalone Twilio accounts section

Added a dedicated Twilio navigation area and account directory independent of the
selected business. Staff browse linked/unlinked accounts, approved senders and
attention reasons, and open linked businesses. The existing profiles API now maps
an omitted business scope to SQL null; staff authorization still precedes inventory.
No schema/permission changes, connections, activations or sends. Twenty CRM and five
paired E2 UI tests passed, plus frontend build. CRM API v43 is ACTIVE; frontend
d882220 is live in Render dep-db0ol0ugekts73aks420. Five changed public assets match
source, and authenticated production navigation/account listing is verified.
E2 runtime remains unchanged.

### October 3 — visible staff SMS connection and activation actions

The CRM dashboard now has a persistent staff-only SMS setup card with Approved
Twilio accounts and state-specific activation shortcuts. The activation screen
also links to the account dropdown after a sender is connected, and ready is labeled
Awaiting activation. Explicit setup navigation fetches current state instead of
restoring a stale tab. No automatic connection, sending activation or test sends.
Seventeen CRM tests and 13 paired E2 UI/cache tests passed; frontend build passed.
CRM 078078c is live in Render dep-db0ohnpsrm7s738gptp0; all six changed public assets
match source. Authenticated live checks opened the account dropdown and approved
sender list directly from the dashboard, then reached Enable SMS. E2's read-only
Awaiting activation view is also live. No migrations/API/worker or E2 runtime changes.

### October 3 — E2 owner activation summary

The shared summary adds an allowlisted activationStatus without exposing test or
provider internals. E2 now explains Awaiting activation separately from sending,
with read-only active/paused status and compatible handling of older cached payloads.
Applied only CRM 20261003213902 then E2 20261003213905 after guarded prerequisite
checks. Existing access rules and cache triggers are unchanged. Security advisors
remain at five pre-existing findings, with no additions. Eleven CRM and 25 E2 tests
passed; E2 production build and desktop/mobile previews passed. E2 application
7916e1d is published: the authenticated production owner SMS tab shows Awaiting
activation, Ready to enable SMS and separate Sending disabled details. CRM
frontend/API/worker releases are unnecessary. No messages or sending settings changed.

### October 3 — retain delivered activation tests on refresh

A status refresh overwrote ready with webhook_verified even after the activation
test was delivered, hiding Enable SMS. The compliance worker now checks the saved
receipt after current approval and sender/webhook verification. A matching delivered
receipt restores ready; pending/failed receipts remain gated. Account, service,
sender and recipient must match. Refresh does not enable sending or send messages.

Compliance-worker v12 is deployed and ACTIVE. A production Check status completed
and restored ready with the existing delivered test; sending_enabled remains false
pending the user's explicit Enable SMS action. Twenty-four relevant CRM tests passed
(two historical AI tests skipped), plus 20 paired E2 service/cache tests. No database,
API or frontend changes/migrations are needed; paired customer projection and cache
contracts are unchanged. See docs/TWILIO_CONNECTIONS.md.

### October 3 — automatic phone country codes

CRM activation, business profile/contact inputs and public embedded forms share
phone normalization: 10-digit US/Canada entry gains +1 on blur and before submit,
while explicit international codes are preserved. Optional empty fields remain
empty and incomplete/ambiguous input is not guessed. Business profile serialization
uses the same helper. See CRM docs/PHONE_FIELDS.md. No database/API/worker or E2
runtime changes; no migrations to apply.

Validation: 22 targeted CRM tests, seven paired E2 business-service tests and the
frontend build passed. Local browser verification showed a 10-digit entry gaining
+1 on blur. CRM application commit 0725da1 is live in Render deployment
dep-db0n4s49v7es73c64jc0; all nine changed public assets match local hashes.
The live embedded form also converted a synthetic 10-digit number to +1 on blur.
No form was submitted and no SMS was sent during this verification.


### October 3 — activation sender verification hotfix

The activation test failed before message creation because the compliance worker
read Messaging Service phone resources as phoneNumberSid instead of the Twilio
SDK's sid. The same field mismatch affected approval refresh and purchase
reconciliation. Corrected all three checks and their fixtures, with an additional
regression test proving attached senders pass and unrelated senders remain blocked.

Compliance-worker **v11** is deployed and ACTIVE. A non-sending production status
check completed successfully and restored webhook_verified. The earlier failed
test remains in history; no SMS was sent or retried, and sending remains disabled
until successful delivery and explicit activation. Nineteen targeted CRM tests
passed, as did 12 paired E2 service/cache tests. No schema, API, frontend or E2
runtime change is required; no migrations
were applied.


### October 3 — simplified business SMS activation

The CRM now defaults to choosing an approved sender, testing delivery and enabling
SMS. Approved connections ask only for a test mobile number; technical details
and new-sender registration are secondary disclosures. Businesses places the SMS
connection first and links directly to activation. Existing business/profile facts
are reused; the dashboard no longer asks for SMS AI context. Staff authorization,
Twilio approval/delivery checks, explicit test-charge confirmation and customer
service visibility remain unchanged. No schema, API, worker or E2 UI changes are
required, so there is no new migration order to apply.

Validation: 21 CRM activation/connection/API/access tests and 12 paired E2
service/cache tests passed; frontend build and desktop/mobile layout checks passed.
No real test SMS was sent and no business sending setting was changed.
Live verification: CRM application `22a2bc9` is deployed on Render
`dep-db0i755g1s2s73e6uo3g`. All seven changed public assets match source. The
authenticated business activation page shows the approved sender, three steps,
and one test-number input. E2 documentation is committed as `c43667a`; its runtime
is unchanged. No new migrations or Edge releases were needed.


### October 3, 2026 — form-first SMS production release

- Application revisions: CRM `0f1d6ea`, E2 `3ca64ba`, both pushed to GitHub.
- Applied only CRM `20261003143731`, then E2 `20261003145302`; all 12 prerequisite function definitions matched the paired baseline. No migration history was replayed.
- Supabase: CRM API **v42**, automation-worker **v26**, ai-worker **v31** active. SMS/automation dispatch restored; AI dispatch disabled. Business/provider sending settings unchanged.
- CRM Render deployment `dep-db0hvatg1s2s73e5vgn0` live; all eight changed public assets match local application files. E2 Vercel `53Ng3kzb55vwxszVwnH5EA7XKzvN` ready on www.e2local.com.
- Authenticated production checks: Forms list, preserved form editor/embed, Automation preset/configuration controls, and owner SMS/website views loaded. The owner's approved sender remains **Sending disabled**, as before. No production messages, AI calls or sample form submissions were made.
- All three existing forms preserved; zero historical runs re-enrolled. Four new private tables have RLS enabled. Security advisors unchanged (five pre-existing warnings; zero additions).
- Validation: **203 CRM tests passed**, **29 historical AI-enabled tests explicitly skipped**, zero failures; **41 paired E2 service/enquiry/cache/tab tests passed**. Both frontend builds passed. Desktop/mobile form editing, preset preview, repeated-message summary and draft save were checked locally; mobile layout had no horizontal overflow. The scheduler test accepted 103 simulated sends in A×2 → B×1 → C×100 order.
- Both records and the form workflow guide updated. Unrelated local documentation/preview changes remain uncommitted. Application deployment evidence above is separate from the following documentation-only commits.


October 3 form-first SMS: named forms now own versioned template sequences with
per-message delays and repeats, reusable presets, reply policies and staff controls.
SMS AI is disabled at enqueue, worker and final-send boundaries. Legacy embeds and
history are preserved; legacy runs require template review. See
[form workflow and migration order](docs/FORM_AUTOMATIONS.md). Local implementation
and paired validation are complete. Both forward migrations are applied; CRM API v42,
automation-worker v26 and ai-worker v31 are active. Both frontends are live and authenticated production views were verified. SMS/automation dispatch is restored and AI dispatch stays disabled.

October 2 read-only SMS summaries: the CRM dashboard and E2 customer SMS tab share
a seven-field server projection, with approval separate from sending. Canonical
access and customer service-release rules remain unchanged. Detailed registration
reads are staff-only in both the API and direct table policy. See
[summary workflow](docs/SMS_CONNECTION_SUMMARY.md). Both forward migrations and
CRM API v41 are applied; both frontends are live and authenticated views were
verified. Release evidence is in the latest entry.

Current verified release — **October 1, 2026 (America/Denver)**: owner-linked registration, canonical CRM permissions, shared profile drafts/reviews, explicit SMS addition and individual customer service release are deployed. CRM API **v38** is active; all three linking/access follow-up migrations are applied. See the consolidated [implementation and release document](docs/CRM_LINKING_RELEASE.md) for current versions, migration order, 334 passing tests, authenticated verification and limits. Earlier local-only and v35/v37 entries below are historical checkpoints.

Last documentation reconciliation: **October 1, 2026 (America/Denver)**.

This is the current implementation and release-reference record for `opek-sms`. Update it after material code, schema, authentication or deployment work. Configuration names and synthetic examples are appropriate here; credentials and customer data are not.

## Current implementation

October 14, documentation follow-up: both guide sets now reflect the completed
paired review, including current API inventory, hosting recovery/drain rules and
local-versus-deployed status. Documentation links, guide coverage and E2 route
coverage were checked; no application changes or new deployments occurred. See
the appended paired documentation completion entry.

October 14, local: the paired E2 review adds session-safe dashboard/onboarding,
scoped customer queries, contact intake limits and guarded hosting mutations.
CRM's paired baseline now fingerprints the complete hosting mutation path and
Worker and runs 63 shared-contract tests. CRM's 395 passing tests and 29 existing
skips remain unchanged. Three additional E2 migrations are unapplied; drain old
hosting invocations before the guard migration. See
[paired release guide](docs/HARDENING_RELEASE.md) and the appended E2 verification.

October 12: Dashboard product tabs are deployed in E2 `07f8f6c` / Vercel
`dpl_9DBrmF4AgrfK7MH2qtzAx4Go6ea7`. Always-visible tabs and inactive-service Add
placeholders are verified in production. No CRM runtime or database release was
required. See the final October 12 Dashboard release entry for evidence.

October 12, local: all Dashboard product tabs are visible before activation.
Inactive tabs show an empty state and disabled Add Lead Capture / Add Bookings /
Add Website / Add SMS / Add Voice Agent buttons, with setup forms deferred.
Active views, Overview cards, access gates and service-data warmup retain their
release filtering. This is an E2 UI change; CRM has paired documentation only.
No migrations, live database changes or deployments were made.

October 5 live phone lookup: the external `voice-agent-phone` now uses ACTIVE
`voice-lookup` v2 with restricted approved business reads and call/phone-bound,
consented SMS verification for customer bookings. Both new additive CRM migrations
are applied and tracked; CRM/E2 runtimes are unchanged. Saved persona still says
Mile High Moving while the approved sender/database belong to Opek. See the
October 5 change entry and CRM `docs/SONI_VOICE_BRIDGE.md` for verification limits.


E2 dashboard performance (October 4, deployed as `e09f795`): conditional workspace
bootstrap, independent Overview summaries, deferred service data/panel code and
retained same-revision panels during access revalidation are implemented.
Existing identity, ownership and service-release contracts remain; no migration
or CRM runtime change is required. See the latest E2 performance entry above.

October 2 existing Twilio connections: staff can select approved toll-free or A2P
senders from the configured parent account and active child accounts in Businesses.
The connection reserves account ownership, verifies the owned number and SMS
webhooks, stores credentials in Vault, and keeps visibility/sending separate.
One Twilio account remains bound to one CRM business. See
[connection workflow](docs/TWILIO_CONNECTIONS.md). The forward migration and Edge
release are applied. Application `14fa6ec` is live and an authenticated business
connection was saved and verified; sending awaits its separate activation test.
See the latest change entry below.

October 2 profile summary: a detailed, live preview now closes the guided business
form, with per-section Edit links and explicit missing/pending details. It uses
current form values and retains existing draft/review persistence. See the latest
change record for validation and release status. Application `ce99d35` is Live
on Render `dep-db01gs60tbcc73fpuik0`; summary UI and all six assets were verified.


October 2 guided business setup: the Businesses profile editor has numbered
sections, editable entry cards, time-zone/hours choices, a pricing builder and
explicitly selected guidance presets. Existing shared draft/review contracts
remain unchanged. See [form workflow](docs/BUSINESS_PROFILE_FORM.md); implementation
and local verification are recorded below. Application `558ab41` is Live on
Render `dep-db01d3qd0e5s739nulm0`; authenticated production UI and six assets
were verified.


Paired customer dashboard: E2 now has the matching workspace refinement and
retained hash-tab panels in production (E2 application 7098031). Both authorization contracts remain unchanged;
see the latest paired dashboard change record for validation and release status.

| Area | Checked-in behavior |
| --- | --- |
| Frontend | Persistent tabbed browser CRM; esbuild dependency bundles; Render static-site configuration; loopback local preview |
| Backend | WPacquisition Supabase Edge APIs, PostgreSQL RPCs/triggers, durable queues and bounded workers |
| Login | Independent CRM Clerk issuer; E2 customer accounts remain separate; explicit grants required |
| Local Google login | Enabled on the CRM development instance October 1, 2026; localhost sign-in reaches Google account selection. Local preview remains read-only sample data with separate development identities. |
| Registration and release (live) | Onboarding creates one owner-linked business without provider work; admin extends/reviews its profile, adds services, and selects Set live per service. Customer visibility is separate from publishing/sending. Transfers reset release. |
| Business scope | `sms_businesses.tenant_id`; request tenant plus database authorization; scoped worker credentials |
| Staff registry | Users, Businesses, Websites, issuer-qualified identities and audited permissions; canonical grants authorize immediately; compatibility tables/flags are retained |
| Messaging | Durable outbox, signed callbacks, delivery ledger and uncertainty handling; current manual send path uses marketing purpose |
| Automations | Four fixed intake types, fresh AI drafts, group-specific context and lifecycle cancellation |
| Email | Separate group/form activation and consent; Resend delivery, suppression and unsubscribe; no inbound mailbox ingestion |
| Forms | Three presets, stable public IDs, field snapshots and optional immutable E2 website attribution |
| Bookings | Operational appointments distinct from original booking forms and reminder intake |
| Knowledge and AI | Draft extraction/embedding, explicit version approval, grounded replies and durable handoffs |
| Voice | Opek-specific Soni bridge and signed Twilio-to-LiveKit route; external voice worker maintained separately |
| Legacy | Express rejects production startup; DigitalOcean and persistent worker material retained for isolated reference |

See the [documentation index](docs/README.md) for developer, staff and operator reading paths.

## Recorded deployment evidence

CRM, E2 and CRM API releases were verified October 1. Other observations retain their earlier recorded dates. Use the latest dated release evidence when specialist guides differ.

| Component | Latest relevant recorded observation |
| --- | --- |
| CRM static release | `0638dcf`, Render `dep-davfsim7bikc73dtmn90`; business setup and service release |
| E2 release | `9581ea2`, Vercel `dpl_GYDeFrFv2iEVqDT82CuMam7cSjQ1`; owner-linked onboarding and service visibility |
| CRM API / compliance | `crm-api` version 37 verified October 1; `compliance-session` version 10 previously recorded, separate CRM issuer |
| Public forms | `web-form` version 7 with website connection support |
| Administrator bootstrap | One explicitly authorized CRM administrator recorded as enabled in canonical and compatibility grants; bootstrap is no longer a general pending release step |
| Registry cutover | Recorded OFF; legacy access cleanup has not run |
| Website pairing | Manual business/owner/form pairing and a published authenticated pilot remain outstanding |
| Voice routing | September 26 signed Twilio/SIP routing checks recorded; physical PSTN audio/dispatch test remained outstanding |

The E2 record itself contains older reset-era paragraphs. Do not reinterpret those historical empty-account observations as a fresh assertion that the later administrator bootstrap disappeared.

## Shared migration ownership

SMS migrations are owned here. E2 owns shared account/registry, website attribution, customer read and cache migrations. The mapping below transcribes recorded deployment aliases; it is not a live migration-list result or permission to replay files.

| E2 local migration | Recorded live version |
| --- | --- |
| `20260930050000_website_sms_enquiries.sql` | `20260929221427` |
| `20260930060000_dashboard_bookings.sql` | `20260930001422` |
| `20260930070000_platform_crm.sql` | `20260930012338` |
| `20260930080000_platform_crm_hardening.sql` | `20260930013528` |
| `20260930090000_platform_form_permissions.sql` | `20260930015523` |
| `20260930100000_platform_identity_directory.sql` | `20260930020115` |
| `20260930110000_separate_login_realms.sql` | `20260930054730` |
| Dashboard cache migration beginning `20260930120000` | `20260930153439` |

Compare repository definitions and the actual live history before any future database change. Do not copy E2 migrations into SMS or run guarded historical reset/cleanup scripts as setup. The [database inventory](docs/DATABASE_INVENTORY.md) explains ownership and retained data distinctions.

## Known limitations and remaining verification

- Published, authenticated website/owner/form and customer enquiry/booking workflows need the recorded controlled pilot; public login checks alone do not complete it.
- Canonical registry activation and legacy cleanup require their explicit reports, mapping, backup and pilot gates.
- Local frontend preview targets shared services. The synthetic demo and offline PGlite tests do not validate production authorization, provider delivery or maximum throughput.
- Provider submission uncertainty requires reconciliation; queue durability does not make provider delivery exactly once.
- Email mailbox replies are not ingested. The external voice worker and physical call path need their own verification.
- The existing database review identified intake enrollment references without a foreign key and some non-tenant-qualified AI/handoff job references. These are recorded follow-up integrity work, not fixed by documentation.
- The configuration helper does not automatically transfer every runtime setting and contains fixed model/rate defaults. Review generated secrets privately before use.

## Migration and verification status

Applied this repository’s `20261001235349_business_service_prerequisites.sql` then E2’s `20261001235352_business_registration_services.sql` on October 1, after comparing recorded aliases and function contracts with live history. Both exact versions are recorded remotely. Existing linked assets become hidden service drafts requiring admin review/release. The shared account/registry/cache migration history is exercised together in offline tests.

## Change record

### October 2, 2026 — Detailed business profile summary

Added a final Review your business profile section after all setup inputs and
before Save draft / Save reviewed profile. It displays identity/contact details,
description, services, areas, hours, FAQs, pricing, policies, booking rules,
handoff guidance and brand voice. Current form changes update the summary without
a fetch or save. Missing fields are labeled Not provided. Edit links focus the
matching input or add control, retaining drafts. Completed pending pricing is
shown separately and included on save; incomplete builder details are identified
without claiming approval. Summary text is escaped, preserves multiline values,
and adds no new submitted fields or shared contract changes.

Compared E2 onboarding/service implementations and both records. No database/API
change, migration, E2 application change or provider action. Existing owning-
repository migration order is unchanged. Workflow docs updated in both projects.
Validation: 15 targeted CRM profile/revision/draft/navigation tests and 20 E2
onboarding/service UI tests passed; final summary refinements passed targeted
checks and the production frontend build. Synthetic browser checks confirmed live
updates, removal/empty states, Edit focus, pending price saved once and retained
values on reload. Desktop and 390px mobile summary cards have no horizontal
overflow. Local implementation/testing at this checkpoint; release evidence follows.

Release verified: CRM application `ce99d35` is Live on Render
`dep-db01gs60tbcc73fpuik0` (October 2, 2026, 2:47 PM MDT). All six
changed production assets matched the release after newline normalization.
Authenticated read-only production inspection confirmed the detailed summary,
saved business facts and explicit missing-field labels, with no browser errors
or warnings. Live screenshot saved in this task. No production profile save,
API/database deployment or provider change was performed during verification.



### October 2, 2026 — Guided business profile form

Replaced the long raw Businesses profile form with five numbered sections matching
the E2 theme. Added a time-zone dropdown, hours presets, services/areas as individual
entries, FAQ question/answer cards with topic suggestions, a pricing-method builder,
policy prompts, appendable booking/handoff suggestions, and brand voice cards.
Presets require explicit selection; original registration and custom/unknown facts
remain. Saved facts keep the current string/array API shape and revision checks.
Draft saves do not approve; review uses the existing API and service-addition gate.
No extra navigation tabs, migrations, provider changes or E2 application changes.
Compared E2 onboarding, service readers, shared profile implementation and both
records; existing owning-repository migration order is unchanged. Workflow:
[Guided profile form](docs/BUSINESS_PROFILE_FORM.md).

Validation: 208 CRM tests passed, followed by targeted serialization/navigation
checks after final refinements; production frontend build passed. All 24 selected
E2 business-services UI, onboarding and combined CRM linking/access tests passed.
Synthetic browser checks covered preset insertion, FAQ validation, pricing included
on draft save, saved value round trips, review enabling service addition, desktop
and 390px mobile layout with no horizontal overflow. Screenshot saved in task.
Local implementation at this checkpoint; release verification follows separately.
Unrelated local documentation/auth/preview changes remain excluded.

Release verified: CRM application `558ab41` is Live on Render deployment
`dep-db01d3qd0e5s739nulm0` (October 2, 2026, 2:39 PM MDT). All six
changed production assets matched the release after newline normalization.
Authenticated production inspection confirmed the five guided sections, hours
presets, FAQ cards and pricing methods with no browser warnings/errors. Live
screenshot saved in this task. No production profile/data save, provider action,
API deployment or migration was performed during verification.



### October 2, 2026 — Remove stock workspace names

Removed the hardcoded business option and initials from the CRM shell and named
example placeholders from setup forms. The selector now displays only returned
businesses; loading/empty states are disabled and no-workspace resolution clears
the old selector, business label and initials. Selection is reconciled against
the returned workspace list. Frontend-only correction with no database, service
or E2 application changes. Frontend build, syntax/diff checks and three workspace
tests passed. Synthetic browser checks covered a populated list and an empty
list with a stale currentTenant: the latter showed a disabled No business
workspace selector, blank initials and a neutral CRM label.

Application `6b6470f`, Render `dep-db012mnavr4c73do20eg`, is live (October 2,
02:17 PM MDT). Live HTML contains no stock business option and app source matches
the released implementation. An authenticated production browser displayed its
actual returned workspace; console warnings/errors were empty. Existing business
records were not renamed or deleted.

### October 2, 2026 — Remove duplicate inner CRM tabs

Removed the horizontal Overview/Contacts/Inbox/Bookings/Automations/Email tab
row that duplicated the sidebar. Sidebar menus still use retained in-page views,
preserving drafts and avoiding full reloads. The content region is labelled by
its page heading instead of a removed tab. Frontend build, syntax/diff checks
and three workspace tests passed. Synthetic desktop navigation preserved section
history; the 390px drawer still exposed its menus without the extra tab row.

Application `c219f95` is live on Render `dep-db00v15g1s2s73c5onu0` (October 2,
02:09 PM MDT). Deployed HTML has no inner tab markup. Authenticated production
Inbox inspection confirmed zero inner tab rows and the visible sidebar menu;
console warnings/errors were empty. No shared database or E2 application changes.

### October 2, 2026 — CRM logo returns to its dashboard

The header logo now points to the CRM overview instead of the public E2 homepage.
Normal clicks use retained tab navigation; opening a new tab uses the CRM URL.
Forms-only accounts retain their existing workspace restrictions. Frontend build,
syntax and diff checks passed; synthetic browser navigation opened overview.
Application `6824198` is live on Render `dep-db00t5u7bikc73foknn0` (October 2,
02:05 PM MDT). Live HTML points to the CRM overview, and an authenticated browser
logo click stayed on crm.e2local.com and opened its Dashboard. Console warnings
and errors were empty. No migration or E2 application change.

### October 2, 2026 — Visible automation setup entry point

An empty Automations view now explains how the four preset groups are initialized
and shows administrators a Set up automations button. It opens the selected
business's existing service setup without creating a service or provisioning a
provider. Configured businesses retain their existing group editors. Failed
category requests now show a retryable error instead of being cached as an empty
group list. See [CRM navigation](docs/CRM_NAVIGATION.md).

Local frontend build, JavaScript syntax and three tab workspace tests passed.
Synthetic browser verification confirmed the empty-state button opens the correct
business details and existing profile-review/service controls. This is a frontend
change only, with no migrations or shared contract changes. A simulated category
500 displayed the error and Try again successfully reloaded the setup view.

Released application `bd39e6e`, Render `dep-davtukvlk1mc73chu8q0` (live October 2,
10:44 AM MDT). Authenticated production verification confirmed Set up automations
on the empty Automations page and its selected-business destination with Add SMS
available. Navigation only was exercised; no service was added and no messaging
was activated. The deployed app includes the new setup markup.

### October 2, 2026 — Restore visible CRM menu options

The refined shell hid the detailed sidebar behind navigation search. The current
section's menu now remains visible alongside the retained workspace tabs.
Automation submenus synchronize on first load; the parent returns to the group
list after selecting a group. Search still spans permitted sections. See
[CRM navigation](docs/CRM_NAVIGATION.md).

Validation: frontend build, JavaScript syntax and all three tab workspace tests
passed. Synthetic browser checks covered first-load group menus, group selection,
return to the list, Platform menus, cross-section search and a 390px mobile drawer.
This is a frontend-only repair; no migrations, service setup or access changes.
Released application `6d92401` to Render as `dep-davsub49v7es7392vuo0`
(live October 2, 09:35 AM MDT). Live app/CSS matched the source and the HTML
matched after line-ending normalization. An authenticated production browser
confirmed the Automations and Workspace sidebar menu options without search;
console warnings/errors were empty. E2's paired record is `ec5833e`; no E2
application change was needed.

### October 1, 2026 — Coordinated production business lifecycle release

Applied both migrations to shared WPacquisition Supabase (`wxamwhfmelxqahkdtcci`)
in one guarded transaction after a successful rollback rehearsal. Historical
migrations were not replayed. CRM API **version 37** is active.

CRM application commit `0638dcf0ca5d927dbcfdb053d0040fb9414c5b21` on `deploy-crm`
is live on Render deployment `dep-davfsim7bikc73dtmn90` at
https://crm.e2local.com. E2 commit `9581ea2b0e3179befc4ea4b3ac32f7d1a3020fc7`
on `main` is Ready on Vercel deployment `dpl_GYDeFrFv2iEVqDT82CuMam7cSjQ1`,
with https://www.e2local.com and https://e2local.com assigned. Render's Git hook
did not start a build; a cleared-cache deployment succeeded. Unrelated local
documentation and preview changes were excluded.

Production checks found one canonical registered business with a verified owner,
zero reconciliation issues, zero reviewed profiles/services/providers/jobs and
no sending enabled. The retained website remains unassigned. Staff directory and
customer workspace database readers returned the expected draft/source profile
and empty services. New tables enforce RLS and deny direct authenticated SELECT;
new server-only RPCs allow service-role execution only. Both cutover switches
remain off. Security advisors returned the same five existing findings, none new.

E2 public pages, browser dashboard redirects, unsigned API denials and CRM
no-store authentication responses passed. CRM entrypoint and five JavaScript
assets matched the committed release after line-ending normalization. Earlier
implementation checks passed 200 CRM and 128 E2 tests, E2 TypeScript/full lint
and both builds. The authenticated browser workflow pilot remains pending.
Render's existing dependency-audit warning remains outside this change.

An administrator must review the prefilled profile, link/add intended services,
then select **Set live** individually. Deployment did not link/publish a website
or activate services/messaging. This release supersedes older status above.

### October 1, 2026 — Local CRM Google login

Enabled the existing CRM development instance's Google connection for sign-in
and signup. No production Clerk settings, database grants, or deployed releases
were changed. Rebuilt local frontend assets. Compared CSS with production after
normalizing line endings: identical; no design code change was needed.

Validation: four local-preview/shared-auth tests passed and frontend build
passed. Local Google sign-in visibly reached Google's account chooser. No Google
account was selected and no completed sign-in or new account creation was tested.
The local preview continues to use synthetic read-only records.

### September 30, 2026 — Documentation completion

Replaced the mixed current/legacy README with a current entry point; added architecture, development, configuration, API, staff, operations and legacy guides and this project record. Reconciled specialist guides against source and existing E2 records, including separate-login bootstrap/release status and E2 cache-table ownership. E2 documentation remains unchanged. No application code, credentials, database records or deployments were changed.

Validation: 36 selected existing tests passed across booking API, Edge workers,
public form builder, website embeds, separate logins, voice bridge, email worker
and platform API. Local Markdown links/anchors, all 77 `.env.example` variables,
all 17 Edge function names and all 13 npm scripts were checked against the new
guides. Git whitespace checks passed. No full application suite, frontend build,
browser rendering, provider calls or live database checks were performed for this
documentation-only change.

### October 1, 2026 — Owner-linked registration and manual service release (local)

Implemented the paired lifecycle: atomic/retry-safe customer registration, original source preservation, administrator draft/review, explicit website/SMS/enquiry/booking linking, and per-service Set live/Hide. Existing verified registrations reconcile without provider work; ambiguous matches require staff selection. Existing assets default hidden. Ownership transfers and website reassignment reset releases. Customer SQL readers, counts, activity, direct pages, navigation and cache schema 2 enforce release and ownership independently of compatibility flags. SMS is a read-only customer summary. Both AGENTS files require paired-project comparison.

Validation: CRM 200/200 tests and frontend production build passed; E2 128/128 tests, TypeScript, full lint and production build passed. Combined PGlite migrations cover atomic retries/rollback, no onboarding provisioning, idempotent additions, reviewed version activation, stale writes, role/realm isolation, compatibility modes, cache changes, ownership transfer/reassignment, independent visibility filters and reconciliation. Rendered-component checks cover hidden navigation/cards/counts/activity/direct links and SMS-only release. Synthetic local CRM browser checks verified profile prefills, review unlocks, draft service creation, Set live and Hide; no browser console errors. Node globals are now configured for existing E2 scripts/tests so the full lint suite runs.

Not applied, pushed or deployed. No cloud records, provider services, messages or published websites changed. Supabase local `db lint --local` was attempted but could not connect to 127.0.0.1:54322 because the local database is not running. Docker-based lint/advisors and an authenticated deployed pilot remain release checks; this environment used the combined PGlite harness. Apply CRM prerequisite 20261001235349 before E2 lifecycle 20261001235352, reconciling live timestamp aliases first. See the business lifecycle documentation for existing-asset review and coordinated rollout.


### October 2, 2026 — Canonical CRM linking and shared profile review

Compared CRM with `../E2local-main` (`e2-local`). Canonical active CRM identities,
staff grants and enabled operator memberships now authorize SMS/form access
immediately, including revocation with either compatibility setting. Legacy grants
and rollout flags are retained without migration. Session workspace discovery no
longer calls an administrator-only directory. Scoped SMS reads and form-only
workspaces are separated from administrator mutations and customer ownership.

Both profile editors use the same persisted draft, revision and review transaction.
Review updates approved facts, setup, business identity, audit and cache together;
partial drafts retain omitted fields and never replace the customer submission.
Stale/missing revisions fail with 409; API/network errors retain unsaved input.
Provider setup and retries reject businesses without explicit Add SMS.

Validation: full CRM 202/202 and E2 132/132 suites passed, E2 type/lint/build and CRM
frontend build passed. Additional combined real-handler/PGlite checks cover both
cutover values, canonical-only administrators, conflicting legacy grants,
revocation, cross-business reads, authenticated RLS, suspension and deleted
identities, profile concurrency/retention, and one-job SMS addition. Targeted
regressions passed after final guards. Browser verification uses synthetic local
records and real database-backed handlers; authenticated production verification
is recorded separately below. No provider integrations were invoked by tests.

Release order: existing lifecycle migrations, then CRM
`20261002024327_sms_workspace_access_guards.sql`, then E2
`20261002024330_canonical_crm_access_profiles.sql`, then crm-api and CRM assets.
Compared 22 affected/dependent live functions with the combined local baseline:
all matched. The guarded live rehearsal rolled back successfully, preserving
services, providers/jobs, memberships, staff grants and compatibility settings.
At this entry these new migrations and application changes are local, not released.


### October 2, 2026 — CRM linking release and authenticated verification

Released CRM application `4dd63fc` and E2 `4511485`. Applied CRM migration
`20261002024327`, then E2 `20261002024330` to shared project
`wxamwhfmelxqahkdtcci` after exact-definition comparison and a successful rollback
rehearsal. Deployed crm-api v38 (ACTIVE), Render
`dep-davi1apsrm7s73c39bn0` (live), and Vercel
`dpl_96JdqGU8teqE1SuQnZ4dR39yJySt` (READY production). All five changed CRM assets
were fetched from crm.e2local.com and matched the application commit. The API
reports the CRM login realm and rejects unauthenticated /auth/me with 401.

Final inspection found that legacy phone-based conversation lookup could create
an empty conversation for SMS readers. Applied the additional forward-only CRM
migration `20261002031422_read_only_conversation_lookup.sql` after its own live
comparison and rollback rehearsal. Readers now resolve existing conversations;
only administrators initialize a missing one. The deployed definition hash
matches the rehearsed definition. Full suites re-run after this change: CRM
202/202 and E2 132/132 passed. No API/frontend redeploy is required for this SQL
follow-up; application assets are unchanged.

Browser verification completed with the existing production CRM staff login and
the separate E2 customer login. Staff startup and Realtime were healthy, the
no-SMS notice opened the correct owner-linked business, and both profile editors
showed the same prefilled business name/time zone. The customer dashboard showed
Opek Junk Removal with “We’re setting up your services”; only Overview/Account
navigation was present, and Refresh preserved that result. Neither browser
reported console errors. Synthetic local browser checks using real CRM handlers
and the paired PGlite database verified shared draft/review synchronization,
stale-save conflicts retaining unsaved text, SMS-reader navigation without write
controls, and forms-only saving without SMS submission access. Live operator
identity and real provider sending were not exercised.

Final production counts: one business, one enabled owner link, zero services,
zero assigned websites, zero providers and zero jobs. Both compatibility flags
remain false. No retained website was assigned, no service was set live, and no
messaging was activated. Security Advisor after rerun remains 0 errors, 5 existing
warnings and 36 informational suggestions; no new findings. The pre-existing
Render npm audit high-severity warning remains; dependencies were not changed.
Unrelated local documentation and preview work were preserved.


### October 1, 2026 (America/Denver) — Consolidated linking documentation

Consolidated all registration, canonical permission, shared profile, provisioning,
read-only lookup, migration, deployment and verification details in the paired
CRM release document. Corrected current guide summaries that still said not
released or referenced API v35/v37. Recorded the deployment recheck: CRM assets
match repository head d1aa8bb (frontend bytes from 4dd63fc), crm-api v38 is ACTIVE,
E2 fe009ce is READY as dpl_kqawguS3mJBQ3H3SDLNi41qSLJTj, and all three follow-up
migration versions are present. Older October 2 entries use UTC; this heading
uses local America/Denver time. Historical checkpoints remain intact.

This update changes documentation only. It records the existing 202 CRM + 132 E2
passing tests, both builds, E2 lint/type checks, authenticated staff/customer
walkthroughs and unchanged security findings; those checks were not rerun just
for prose edits. No application, database, provider or deployment state changed.

### October 2, 2026 — CRM tab navigation without page reloads (local)

Converted related standalone pages into instant in-page tabs. A contextual
tab bar now groups Reports (Inbound calls, Message history, Delivery report,
Opt-Outs), Setup (Business setup, Business context, Booking setup, Forms, AI
instructions) and Platform (Users, Businesses, Websites); website detail
sub-pages (dashboard, domain, assets, business info, leads) switch from a
cached record instead of refetching. All view changes go through one
`switchView` path using the History API, so workspace/tenant changes,
organization switches and dashboard shortcuts no longer trigger full page
reloads; auth, theme and realtime stay mounted. Revisited tabs keep content
on screen while data revalidates, and sidebar hover prefetches. Tab styles
match the E2 dashboard theme. No database, API, provider or deployment state
changed; no E2 counterpart change was needed (no registration, ownership,
profile, linking, visibility, authentication or shared-contract behavior
changed).

Validation: full CRM 202/202 tests passed and the frontend production build
passed. Not applied, pushed or deployed.

### October 1, 2026 (America/Denver) — Persistent CRM workspace redesign

Replaced the long page-style navigation with Workspace, Reports, Setup and Platform
areas and a persistent tab strip. Restored E2 site typography and paper/blue theme,
with a cleaner header, KPI strip, action cards and mobile drawer. Main tabs retain
actual DOM nodes, draft inputs, filters, pagination, scroll and directory state.
Website sub-tabs retain their own panels and drafts too. Removed discarded hover
requests and repeated empty-category loads. Serialized main rendering prevents slow
loads from painting a subsequently selected tab. Existing URL bookmarks and browser
Back/Forward remain supported, with keyboard navigation on the main tab strip.
Background updates flag snapshots for refresh instead of replacing the screen;
Inbox live refresh remains guarded while editing. Workspace/session changes clear
memory. Existing API authorization and revision enforcement are unchanged.

Compared the current E2 dashboard and both project records. No database/API/shared
contract or migration change; no combined migration sequence is required. Workflow:
[Tabbed workspace](docs/TABBED_WORKSPACE.md). Unrelated local docs and auth/preview
work remain excluded from the release.

Validation: 205 CRM tests passed, frontend build passed; E2 business-services UI
and hosting-tabs tests passed (11). Synthetic browser verification covered desktop
and 390px mobile layout, retained search and profile drafts, website sub-tab drafts,
browser Back and zero extra API reads when revisiting tabs. No provider actions or
live data edits were used. At this checkpoint implementation is local; deployment
verification is recorded separately after release.

### October 1, 2026 (America/Denver) — CRM workspace release verified

Published application commit `59d0615` on `deploy-crm`. Render deployment
`dep-davjvshsrm7s73ca7lk0` succeeded and is Live (started 11:24 PM MDT).
The push did not produce an automatic deployment during observation despite the
On Commit setting, so this release was triggered manually in the existing static
site. Webhook diagnosis remains separate from the verified frontend release.

All five changed frontend assets fetched from `crm.e2local.com` match the release
commit after newline normalization. Authenticated production browser verification
showed the redesigned area navigation, Workspace tabs, healthy Live connection,
Contacts loading, and instant return to the retained Overview; no console warnings
or errors. The final 205-test CRM run passed. Both project records were updated.
No API/database migration, provider action, customer data edit or E2 app deployment
was performed. Unrelated local auth/preview/documentation changes remain preserved.

Production visual QA follow-up: refined the no-SMS setup notice spacing and
responsive action placement; frontend build passed. This changes presentation only.

Final visual follow-up `80f63d7` is Live as Render deployment
`dep-davk1hvavr4c73cbeg8g` (October 1, 11:27 PM MDT). HTML/CSS matched the
commit; the authenticated production screenshot confirmed notice spacing and
healthy Live status with no browser errors. JavaScript is unchanged from the
205-test verified application release.


### October 1, 2026 (America/Denver) — Paired E2 workspace refinement

Applied the CRM workspace design to the E2 customer dashboard: sticky header and
accessible tab strip, business identity sidebar, joined summary cards, blue primary
service card, compact typography and responsive layouts. Existing Website deployment
cards remain. Visited panels now retain drafts, expanded details, filters and
pagination; explicit filtered links select their requested view. Browser Back/Forward
and Arrow/Home/End navigation work without full page navigation. Cache identity/revision
and access validation bound panel lifetime; unreleased/revoked services are removed.
No API, authentication policy, database, migration or provider configuration changed.
Both records and dashboard workflow docs were compared and updated.

Validation: all 132 E2 tests and 205 CRM tests passed; E2 full lint, TypeScript and
production build passed. Updated stale test imports to exercise the current tabbed
entry and service visibility. Actual components with synthetic local HTTP data verified
retained account draft, website expansion and enquiry page 2, keyboard navigation,
browser Back, zero extra reads on tab revisits, service-revision clearing, and a 390px
layout with no page overflow. No browser warnings/errors. A local fixture is retained
under E2 tests/fixtures/dashboard-preview.mjs. Implementation is local at this checkpoint;
production verification is recorded separately below. No combined migration order is
required. Unrelated CRM local work is preserved.


Production release verified: E2 application `7098031` was pushed to `main` and
Vercel automatically built deployment `dpl_5kpzkv8yUC8H3zAw8EfE7QaW8Yye`, Ready
at October 1, 2026, 11:42 PM MDT. The authenticated dashboard at
https://www.e2local.com/dashboard shows the redesigned Overview and Website tabs.
Production tab switching preserved the expanded website Business info panel; no
browser warnings/errors were recorded. Screenshot saved in this task. Both records
and workflow docs now reflect the release. This E2 Git-triggered deployment worked;
the separately recorded CRM Render webhook issue remains unchanged. No database,
API, provider configuration or customer data mutation was part of this release.


### October 2, 2026 (America/Denver) — Remove duplicate customer navigation

Removed the extra Overview/Website/Account strip inside E2 dashboard content at
user request. The existing sidebar remains the only section navigation, becoming
one horizontally scrollable row on mobile. Refresh and retained visited panels
remain; panel labels no longer refer to removed tab buttons. No API, authentication,
customer visibility contract, database or migration changes. Both workflow docs updated.

Validation: 13 targeted E2 cache, service-visibility and dashboard tests passed;
production build passed. Full lint passed after removing a redundant section role.
Local actual-component checks confirmed no inner strip, retained account input
through sidebar switching, and working 390px mobile navigation without page overflow.
Implementation is local at this checkpoint; live release verification follows.


Release verified: E2 `446a5c8` is Ready on Vercel deployment
`dpl_6BNevksKLAnigdJk21AB8nmenLQa` (October 2, 12:08 AM MDT). The authenticated
production Account page has no inner workspace strip and retains Overview/Website/
Account sidebar navigation. Screenshot saved in this task. Three paired CRM tab-memory
tests also passed. Changes are pushed; no database/API/provider release was needed.


### October 2, 2026 — Final paired live deployment check

At the user's request to deploy all current work, redeployed CRM GitHub head
`4aec4d6` to the existing Render static site. Deployment
`dep-db01jqm0tbcc73fq98i0` is Live, finished 2:54 PM MDT. The complete guided
profile and live detailed summary are included; all six production assets match
the checked-in release after newline normalization. E2 production was confirmed
Ready on Vercel `dpl_E9qTNe1W8wytRafdqcFmRz828ZWF`, source `8faeee1`,
assigned to www.e2local.com. Both production roots return HTTP 200.
No new application change or test rerun was needed; previously recorded profile
and paired validation remains applicable. No new migrations, API deployments,
profile saves, service activation or provider changes. Unrelated CRM local
auth/preview/documentation work remains preserved and outside this release.

### October 2, 2026 — Approved existing Twilio connections

Implemented a staff account/profile/sender chooser in Businesses, with a header
shortcut and a detailed connection review. The server discovers the configured
parent account and active children, filters verified toll-free or A2P resources,
and checks profile/brand/campaign approval, phone ownership and single-number
service attachment. Reservations reject cross-business reuse, stale revisions and
running provider leases. Existing interrupted bootstrap work is held/cancelled
without replay; completed connections retain Vault credentials and account-based
webhook isolation. Connecting leaves sending disabled and preserves separate
customer service visibility. Already connected profiles have a dedicated setup
summary and activation-test controls rather than another registration form.

Local validation: 222 CRM tests, 31 relevant E2 tests, 29 focused API/worker/tab
checks, build and syntax checks passed. Combined migration tests cover account
reservation, private credentials, cross-business denial, bootstrap uncertainty,
service release/customer reads and activation gating. Synthetic browser checks
covered selection, review, save, activation summary and 390px layout geometry.
Read-only provider inventory verified real approved/failed statuses and expected
webhooks; it identified Twilio's actual 50-item toll-free page-size limit, which
the SDK inventory now respects.

Live: compared five paired function definitions and existing history before
applying only CRM `20261003023928_connect_existing_twilio`. E2 registration/access
prerequisites were already present. New table RLS and scoped RPC grants were
verified; the security advisor returned the same five existing warnings and no
new finding. Deployed ACTIVE `crm-api` v40, `provisioning-worker` v19 and
`compliance-worker` v10. The compliance worker now recognizes `TWILIO_APPROVED`
and the A2P compliance-list envelope when polling. Application `14fa6ec` is Live
on Render `dep-db0752lg1s2s73crpt0g`, finished October 2 at 9:12 PM MDT. All eight
production assets matched the committed release. Automatic deployment did not
start after the GitHub push; an explicit fresh-cache build completed successfully.

Authenticated production verification connected the approved toll-free profile,
owned number and Messaging Service to the matching reviewed business. One account
mapping and Vault credential were verified, the interrupted bootstrap was
cancelled, and the existing live SMS service visibility was preserved. The E2
customer reader returns the connected phone. New SMS services still start in
draft visibility. Provider configuration and webhook verification are complete;
no activation canary was sent and sending remains disabled. Existing webhooks
already matched and needed no provider update. No paid resource purchase or SMS
was performed. A final dashboard-label follow-up shows the connected profile and
**Finish SMS activation**, with a fresh application cache key; syntax/build and
browser checks passed. No E2 migration or application change; paired
workflow/records are updated. Unrelated local changes remain outside this release.
### October 2, 2026 — Read-only SMS connection summaries

Implemented the shared private summary, guarded CRM GET `/api/sms/connection`,
compact CRM/E2 cards and optional customer `services[].smsConnection`. There are
no credentials, Twilio IDs, internal errors or canary recipients in the summary.
Owners retain only released-service visibility; SMS readers retain their canonical
business grants. No new CRM access for customers. Staff provisioning/activation
screens and existing operational permissions remain unchanged. Detailed raw
registration GET and authenticated table SELECT now require staff access.
Registration changes invalidate dashboard cache revisions; older browser snapshots
without the new field remain compatible.

Validation: all 224 CRM tests and 31 relevant E2 service/access/cache/UI tests
passed, as did CRM syntax/build and E2 production build. Combined database tests
cover approved toll-free/A2P, pending/rejected/uncertain registration, missing
provider, activation separation, tenant isolation/revocation, direct SELECT denial,
private grants, identical customer/CRM projection and read-without-job creation.
Synthetic desktop and 390px checks show read-only cards without horizontal overflow.

Live: five affected function definitions matched their paired baseline before
applying only CRM `20261003032940_sms_connection_summary` followed by E2
`20261003032943_customer_sms_connection_summary` in one guarded transaction.
Verified the staff-only registration policy, private/scoped function grants and
registration cache trigger. The released customer service returns the same live
connected summary, and sending remains disabled. CRM API v41 is ACTIVE. CRM
application `d7842c2` is Live on Render `dep-db07lp2d0e5s73aehoo0` (October 2,
9:48 PM MDT); all nine production assets match the committed application. Render
again required an explicit fresh-cache build after automatic deployment failed
to start. E2 application `0fe8dde` is Ready/Current in production on Vercel
`dpl_9o1wM511yGwU2bH5CVECpCvSCNtH`, assigned to www.e2local.com.
Authenticated production owner and CRM staff views show identical core details;
both summary cards contain zero form/input/button controls. Staff activation
setup remains available separately. Security advisors retain the five existing
warnings with no new finding. No Twilio calls, paid actions or activation SMS.
Subsequent record-only commits do not change the verified application behavior.


### October 4, 2026 — approved phone connected to the GPT-Live cloud agent

Live inventory confirmed the existing Opek toll-free sender is approved and voice-capable. The sibling voice agent is deployed as voice-agent-phone (CA_H8mbfRdWKWJV, version P3HUxF5Y2kGd) with its saved prompts. LiveKit inbound trunk ST_wuu4MFmMMfdG and dispatch rule SDR_KjBLwj6ZZg4h route callers to separate rooms. The existing signed voice webhook was rejecting the registered provider owner because it required the legacy opek tenant. Its owner guard is now configured through SONI_VOICE_TENANT_ID, retaining the exact-number and signature checks; soni-voice-inbound version 5 is ACTIVE. Deployment used downloaded live shared modules to avoid releasing unrelated local authentication edits.

Validation actually performed: 25 focused CRM tests and 16 paired E2 account/service UI checks passed; signed live webhook returned 200 with matching SIP destination/credentials, unsigned requests returned 403, and the cloud agent generated audible greeting audio. PSTN audio still needs a physical call. SMS callbacks, provider/account ownership, customer visibility, shared database contracts and migration order are unchanged; no migrations or CRM/E2 frontend releases. Current details are in CRM docs/SONI_VOICE_BRIDGE.md and the voice agent README. The new voice runtime has no CRM tool bridge.


### October 4, 2026 — Vesper phone voice deployed

At the user's request, the external voice-agent-phone deployment now uses Vesper through VOICE_AGENT_VOICE. Version d6P5JWi7NpUf is Running. Six configuration checks passed and a fresh cloud session generated audible greeting audio; its temporary room was removed. Saved prompts, models, phone routing and SMS callbacks remain unchanged. No CRM/E2 runtime release or migration.

### October 5 - live phone agent database lookup deployment

The sibling LiveKit `voice-agent-phone` (cloud ID `CA_H8mbfRdWKWJV`) now uses a
separate read-only `voice-lookup` gateway in shared Supabase project
`wxamwhfmelxqahkdtcci`. Edge version 2 is ACTIVE. LiveKit production version `f3pBiwBsMUYb` is Running. The fixed scope is the approved
line's registered provider owner, `biz-1c0c09ce-819e-4795-86b9-0e457ab92f58`
(Opek Junk Removal); ownership is checked on each operation. Business lookup
returns only approved active profile fields and approved active knowledge.
Customer name/phone and up to ten bookings require consented SMS verification
for that exact call and phone. Codes expire after five minutes, allow three
attempts, and are rate limited; verified reads expire after 30 minutes. Booking
creation, rescheduling/cancellation and general texting are not exposed.

Only two additive CRM migrations were individually applied and tracked:
`20261005200000_voice_agent_read_lookup.sql` then
`20261005203000_voice_lookup_boundary.sql`. No historical migrations were replayed.
The dedicated `sms_voice_lookup_login` has no direct customer-table privileges,
no superuser/bypass-RLS rights, and no `sms_private` schema access. Its four
`voice_lookup_api` wrappers enforce scope and verification. The isolation migration
addresses inherited PUBLIC execution on older internal routines without changing
existing client privileges. Edge owns the restricted database credential and OTP
hashing key; LiveKit receives only the Supabase URL and a signed gateway key,
not admin/service-role credentials. The legacy voice write bridge is unchanged.

The phone route, Vesper voice, GPT-Live-1/GPT-6.1 Sol and saved prompt revision
`13635bbf6dfb4543ad199ab37b2a116e` are preserved. Lookup workflow rules are appended
at runtime, including after future prompt publications. The saved persona says
Mile High Moving, while the database belongs to Opek; runtime rules prohibit
misattributing business facts. Staff can reconcile it in the local live prompt UI.
The local worker is configured for the same restricted gateway. Existing
Twilio SMS callbacks, business/provider ownership and CRM/E2 application
runtimes were not changed or released.

Validation actually performed: 36 Python checks, five focused CRM bridge/lookup
checks and 24 paired E2 accounts, business services, CRM linking/access and
bookings checks passed. Synthetic SQL fixtures cover actual verification outbox
queueing, wrong/valid/expired codes, phone/call isolation, approved-only facts,
denied table access and denied legacy/internal functions. Live signed business
lookup returned the approved Opek profile; unsigned requests returned 401 and
signed unverified customer requests returned 403. Production contact, booking
and message counts were unchanged. A fresh cloud voice session generated audible
greeting audio and the live model successfully delegated to and executed the
business lookup tool; the temporary room was removed. No real verification SMS
or customer record lookup was performed. A controlled PSTN call and real SMS
verification are still needed for complete telephony/delivery coverage.
See CRM `docs/SONI_VOICE_BRIDGE.md` and sibling voice agent `README.md`.

### October 8 — Paired Website request inbox change record (not released)

Added the Websites Update requests section and E2-hosting API client for staff
status/reply management. Customer request data stays within the existing staff
realm and submitting-customer boundaries. E2 owns the new request table/RPC
migration; CRM owns only its inbox UI. Apply the new E2 migration before releasing
E2 APIs/UI and then CRM. No live storage, database changes, pushes or deployments
were performed. E2 build/lint and 35 combined schema/access/API tests passed;
CRM frontend build and 10 API/render/tab-memory tests passed. Synthetic browser
checks verified status/reply refresh. See ../E2local-main/docs/website-workspace.md.

### October 8 — Customer website requests release prepared

Added the staff Websites Update requests inbox with status and customer-visible
replies. The paired E2 migration passed a live rollback rehearsal and grants/RLS
assertions; release order is new E2 migration, E2 API/UI, then CRM frontend.
40 E2 tests and 10 CRM API/render/tab-memory tests passed. Asset storage and
domain connection remain previews. Deployment is authorized and pending.

### Dashboard and website requests release verified

E2 application 67a320a is READY in Vercel deployment
dpl_BdcTfCABPF8emjEzXSA5xdBY2Fac, assigned to www.e2local.com and e2local.com.
CRM application 7c43c2e is live in Render deployment dep-db4888qd0e5s73f40pq0.
The dashboard header, sidebar, AI Assistant preview and Website workspace are
released. Saved requests and staff status/replies are active. Assets remain
browser-local previews, Domain connection remains unwired, and no AI model
is connected. No live asset storage, DNS changes or customer test requests were created.

Applied only E2 migration 20261009053203 after a successful production rollback
rehearsal. RLS/grant assertions pass; the security advisor reports no errors.
Both production roots return 200; unsigned customer requests redirect to sign-in
and staff requests return 401. The deployed CRM request chunk exactly matches the
staged build; raw source matches after line-ending normalization. Builds, scoped
lint, 40 E2 tests and 10 CRM tests passed. Desktop/mobile fixture navigation and
layout were verified; authenticated production rendering/submission was not tested.
The existing unrelated local changes remain outside these commits.


### October 12 — Always-visible Dashboard products (local)

All five product tabs now remain visible in both loading and loaded navigation.
Inactive hash selections stay on their own tab and render a shared empty state
with a service-specific disabled Add button and setup-coming-soon explanation.
Forms are intentionally deferred. Active service views remain intact; private
service data, Overview summaries and background data requests remain gated by
existing released-service access. No provisioning or activation action is wired.

Compared both project records and the CRM service-release implementation. No new
migration is needed; the existing paired migration order is unchanged. No history
was replayed and no shared live database or deployment was changed. Existing
unrelated local edits in both repositories were preserved.

Validation performed: 40 E2 tests passed (service UI, paired service database,
cache, warmup and customer Voice); 10 CRM business-setup/customer-Voice tests
passed. These database suites use local fixtures and exercise paired migrations.
Scoped ESLint and the E2 production build including TypeScript passed. Actual
component browser checks verified the desktop Voice empty state, active SMS
navigation and the 390px Voice tab/empty state; no browser warnings/errors were
reported. Both records and affected customer-service/cache/Voice docs updated.

### October 12 — All Dashboard product tabs deployed and verified

E2 commit `07f8f6c4db8e01ba9246fd4f09e67a36bbef73ea` was pushed to main and is
Ready in Production in Vercel deployment `dpl_9DBrmF4AgrfK7MH2qtzAx4Go6ea7`,
completed October 12 at 2:27:39 PM MDT. Both www.e2local.com and e2local.com are
assigned. The existing Git integration deployed automatically in about 29 seconds.
All five product tabs remain visible before activation, including the loading
shell. Inactive selections show their empty state and disabled Add service button;
forms remain deferred. Existing released data and Overview filtering are preserved.

Isolated release validation: 32 E2 focused tests, scoped ESLint and the production
build/TypeScript passed. The initial isolated build rejected an external dependency
junction; installing dependencies directly resolved it. Prior paired verification
remains 40 E2 and 10 CRM passes. Signed-in production verification confirmed all
five product tabs and the Voice empty state with Add Voice Agent. Browser and
deployment-scoped warning/error/fatal logs were empty. Both public roots returned
HTTP 200. Screenshot: E2 `.artifacts/dashboard/all-products-live.png`.

No database migration or CRM runtime deployment was needed for this task. Other
pending work remains separate. Both local project records and workflow docs now
record the verified release; earlier local/prepared statements are historical.

### October 13 — Documentation verification record

Reconciled the CRM's main reading paths and affected E2 integration/database
references; preserved unrelated work. CRM validation command: `node --test
test/platformApi.test.js test/formSequences.test.js test/directAutomationsApi.test.js
test/voiceSetup.test.js test/sharedTwilioWebhooks.test.js` (22 passed). E2:
`node --test tests/business-services-database.test.mjs tests/customer-voice.test.mjs`
(12 passed). Documentation-only work; no frontend build or live/provider test was
needed or performed. Source migration prerequisites are documented in CRM
`docs/DEVELOPMENT.md`; recovery evidence still needed is explicit in CRM
`docs/RECOVERY.md`. Earlier dated rollout observations remain historical evidence.

### October 14 — Main E2 reliability review verification (local only)

Completed the main E2 review and implemented verified fixes while preserving
unrelated local work. Dashboard requests now fence redirects/cache writes by
session, bound transport/body waits and persisted cache size, and clear old
drafts on account changes. Onboarding forms and save actions verify the
originating account/session; late saves cannot navigate or refresh another
session. Voice media/dialog cleanup and transcript access are corrected.

Customer SQL readers authorize the account's service set, select narrow page
keys and totals, then hydrate only page payloads. Connected forms use the direct
relationship. Server database transport has a 10-second cancellation-aware
deadline. Current SQL source modules are checked against their owning migration.

Contact intake has bounded JSON input, durable retry identity, atomic email/IP
limits and generic confirmation text. Trusted-ingress IP handling is explicit.
Contact/Pricing browser submissions prevent duplicates, preserve retry IDs for
unchanged drafts and bound response waits. Resend calls have an 8-second deadline.
Contact mail remains best-effort after durable storage; this is not an email outbox.

Hosting builds copy one bounded file at a time and no longer run the legacy
Tailwind compiler. Existing ready/published manifests remain usable. All conflicting
hosting mutations serialize per website, with token/generation-fenced database
writes and explicit recovery holds for expired/uncertain external operations.
Malformed, missing-body or JSON-null publication metadata cannot be mistaken for
a missing pointer during cleanup. The delivery Worker validates manifest sizes,
paths, deployment keys and preview expiry.

Static-page-compatible security headers, generic recovery/404 pages, truthful
newsletter placeholder, maintained documentation index/architecture guide and a
paired CI/release gate are implemented. Removed unused compiler dependencies and
one-off tunnel settings. CI still needs reviewed immutable paired revisions and
remote repository configuration before enforcement can be claimed.

New E2-owned forward migrations:
- `20261014065217_dashboard_scoped_reads.sql`
- `20261014065602_contact_intake_limits.sql`
- `20261014071224_hosting_operation_fencing.sql`

All three remain NEW AND UNAPPLIED for this work. The earlier local CRM
`20261014061007_queue_reporting_hardening.sql` and E2
`20261014061728_hosting_read_indexes.sql` remain separately owned release inputs.
Drain old hosting mutation invocations before the fencing migration and deploy
the matching E2 API before reopening writes. Old unfenced hosting code is not a
compatible rollback. Reconcile existing remote aliases and apply only missing
reviewed owning migrations; never replay either repository history.

Final local verification:
- E2: 239 tests passed, zero failures/skips; delivery Worker: 6 passed.
- Expanded paired source/migration fingerprints and contracts: 63 tests passed.
  These overlap the E2 suite and are not additional independent test coverage.
- CRM: 424 tests, 395 passed, 29 existing legacy/disabled-AI skips, zero failures.
- E2 full ESLint, application/Worker TypeScript, maintained-SQL comparison and
  final production build passed. Public marketing pages remain prerendered.
- CRM source/header/Edge dependency checks and maintained-SQL comparison passed.
- Local production HTTP checks passed for 11 public pages, metadata/canonicals,
  structured data, sitemap/robots, internal links, social image and real 404s.
- Synthetic browser checks verified same-session draft retention and account
  switching with a delayed old-session 401. Offline onboarding component/action
  tests verified stale-session rejection and late-completion isolation.
- 21 E2 documentation files decode as UTF-8 and 203 local links resolve.
  Served Contact/Pricing/404 security headers passed local HTTP checks.
- Both repositories' relevant diffs passed whitespace checks. The unrelated
  pre-existing CRM `public/dashboard-theme.css` trailing blank line is preserved.

No production migrations, database edits, provider submissions, publications,
DNS changes, commits or deployments were performed. Local logs are ignored
workstation artifacts. Hosted Clerk/CSP/media behavior, actual PostgreSQL
concurrency/query plans, R2 interruption/recovery and ingress forwarding remain
release checks, not proven by PGlite or mocked transport tests.

### October 14 — Paired documentation completion follow-up

Confirmed both projects have maintained documentation indexes, setup/configuration,
architecture, APIs, customer/staff workflows, database ownership, release and
recovery guides. Filled the remaining gaps after the implementation review.

E2's API reference now matches all current route/method combinations, paginated
hosting responses, Voice resources and website-update request contracts. Browser
storage schema 6 is distinguished from the cache-key/API version. Contact retry
troubleshooting and onboarding session-test instructions match the source.
Account/service release observations and earlier ownership-test failures are
explicitly historical; the October 14 passing suite remains dated evidence.

CRM's documentation index links the main E2 index, architecture and release guide.
Architecture, website integration, operations, workspace performance and deployment
guides now carry the guarded-hosting conflict/recovery behavior, drain requirement
and the complete paired release inventory through its authoritative guide.

Validation for this documentation-only follow-up: 57 README/guide files decode
as UTF-8; 524 local file/heading links resolve; every guide appears in its index;
all 25 E2 route/method combinations appear in the API inventory. Relevant Markdown
diffs pass whitespace checks. Earlier application/build/test results were not
rerun or presented as new evidence. No application, migration, provider,
production database or deployment change was made in this follow-up.
