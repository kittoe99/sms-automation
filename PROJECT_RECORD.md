# Opek SMS project record

October 1, 2026 local implementation: **owner-linked onboarding, manual extended-profile review, explicit service addition and per-service customer release** are implemented across this CRM and `../E2local-main` (`e2-local`). These changes have not been applied, pushed or deployed. See [Business lifecycle](docs/BUSINESS_LIFECYCLE.md).

Last documentation reconciliation: **September 30, 2026 (America/Denver)**.

This is the current implementation and release-reference record for `opek-sms`. Update it after material code, schema, authentication or deployment work. Configuration names and synthetic examples are appropriate here; credentials and customer data are not.

## Current implementation

| Area | Checked-in behavior |
| --- | --- |
| Frontend | Static browser CRM; esbuild dependency bundles; Render static-site configuration; loopback local preview |
| Backend | WPacquisition Supabase Edge APIs, PostgreSQL RPCs/triggers, durable queues and bounded workers |
| Login | Independent CRM Clerk issuer; E2 customer accounts remain separate; explicit grants required |
| Local Google login | Enabled on the CRM development instance October 1, 2026; localhost sign-in reaches Google account selection. Local preview remains read-only sample data with separate development identities. |
| Registration and release (local) | Onboarding creates one owner-linked business without provider work; admin extends/reviews its profile, adds services, and selects Set live per service. Customer visibility is separate from publishing/sending. Transfers reset release. |
| Business scope | `sms_businesses.tenant_id`; request tenant plus database authorization; scoped worker credentials |
| Staff registry | Users, Businesses, Websites, issuer-qualified identities and audited permissions; canonical and compatibility paths coexist |
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

The following observations were already recorded in [staff CRM history](docs/STAFF_CRM.md) and the [E2 project record](../E2local-main/PROJECT_RECORD.md), reviewed on September 30. They were **not freshly verified against live services during this documentation work**. When an older specialist guide contradicts a newer release entry, use the newer explicitly dated record for status and the implementation for behavior.

| Component | Latest relevant recorded observation |
| --- | --- |
| CRM static release | `1de5387`, Render `dep-dauo39s1nsns73f1sh5g`; shared auth-module fix and E2 branding |
| E2 release | `d6515e5`, Vercel `dpl_HkLYU2Fz7gy6mvWYhi2KmX7Zk29f`; customer reads and dashboard cache |
| CRM API / compliance | `crm-api` version 35 and `compliance-session` version 10, separate CRM issuer |
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

## Local migration and verification status

Apply this repository’s `20261001235349_business_service_prerequisites.sql` before E2’s `20261001235352_business_registration_services.sql`, after comparing recorded aliases with live history. Existing assets become hidden service drafts requiring admin review/release. Neither migration has been applied remotely. The shared account/registry/cache migration history is exercised together in offline tests.

## Change record

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
