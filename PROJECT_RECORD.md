# Opek SMS project record

Current verified release — **October 1, 2026 (America/Denver)**: owner-linked registration, canonical CRM permissions, shared profile drafts/reviews, explicit SMS addition and individual customer service release are deployed. CRM API **v38** is active; all three linking/access follow-up migrations are applied. See the consolidated [implementation and release document](docs/CRM_LINKING_RELEASE.md) for current versions, migration order, 334 passing tests, authenticated verification and limits. Earlier local-only and v35/v37 entries below are historical checkpoints.

Last documentation reconciliation: **October 1, 2026 (America/Denver)**.

This is the current implementation and release-reference record for `opek-sms`. Update it after material code, schema, authentication or deployment work. Configuration names and synthetic examples are appropriate here; credentials and customer data are not.

## Current implementation

October 2 profile summary: a detailed, live preview now closes the guided business
form, with per-section Edit links and explicit missing/pending details. It uses
current form values and retains existing draft/review persistence. See the latest
change record for validation and release status.


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
