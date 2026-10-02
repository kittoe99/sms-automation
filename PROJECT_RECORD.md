# Opek SMS project record

Current verified release — **October 1, 2026 (America/Denver)**: owner-linked registration, canonical CRM permissions, shared profile drafts/reviews, explicit SMS addition and individual customer service release are deployed. CRM API **v38** is active; all three linking/access follow-up migrations are applied. See the consolidated [implementation and release document](docs/CRM_LINKING_RELEASE.md) for current versions, migration order, 334 passing tests, authenticated verification and limits. Earlier local-only and v35/v37 entries below are historical checkpoints.

Last documentation reconciliation: **October 1, 2026 (America/Denver)**.

This is the current implementation and release-reference record for `opek-sms`. Update it after material code, schema, authentication or deployment work. Configuration names and synthetic examples are appropriate here; credentials and customer data are not.

## Current implementation

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
