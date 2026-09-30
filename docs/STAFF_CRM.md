# Shared staff CRM and customer dashboard

Updated September 29, 2026 (America/Denver). `opek-sms` is the staff CRM;
E2 Local is the customer dashboard. Both use the same Supabase records.

## Release status

| Component | Actual status |
| --- | --- |
| Registry migration | Live: local `20260930070000_platform_crm.sql` → live `20260930012338`. |
| Staff protection migration | Live: local `20260930080000_platform_crm_hardening.sql` → live `20260930013528`. |
| Form permission migration | Live: local `20260930090000_platform_form_permissions.sql` → live `20260930015523`. |
| Identity directory migration | Live: local `20260930100000_platform_identity_directory.sql` → live `20260930020115`. |
| CRM Edge API | Version 33 deployed, including global platform endpoints. |
| Compliance/registration Edge API | Version 8 deployed with transaction-local identity context. |
| Identity backfill | Existing dashboard UUID retained; development accounts reconciled against Clerk. Previously audited production administrator mapped to the production issuer. No email matching. |
| Registry cutover | OFF. All known legacy SMS subjects/grants are mapped; one previously owned website still lacks an explicit business pairing. |
| R2 uploads | Existing CORS rules retained, `https://crm.e2local.com` added. Both CRM and E2 preflights returned 204. No website files changed. |
| Frontends / account webhook | Implemented locally; not released/configured by this work. Production Clerk configuration and frontend deployment remain prerequisites. |
| Legacy cleanup | Prepared separately; NOT run. Requires verified release, controlled pilot and external backup. |
| Pilot | Local SQL/HTTP/UI verification performed. A published website pilot is still pending. No customer messaging was activated. |

The shared database now has 75 application tables: the 69 reviewed tables plus
six platform registry/audit/runtime tables. See the [complete table inventory](DATABASE_INVENTORY.md)
for retention and consolidation decisions. Do not blindly push either repository's
older migration history. Earlier E2 and SMS migrations have live timestamp aliases;
compare live definitions and the migration mapping in `PROJECT_RECORD.md` first.

## Sources of truth

| Record | Source |
| --- | --- |
| Authentication | Shared production Clerk instance, `https://clerk.e2local.com`. |
| Platform account | `dashboard_accounts.id`, with active/suspended/deleted status. |
| Authentication binding | `platform_account_identities(issuer,subject)` → account UUID. Each account belongs to one issuer. |
| Business / tenant | Existing `sms_businesses.tenant_id`; identifiers and operational history remain stable. |
| Customer and operator access | `platform_business_memberships(account_id,tenant_id)`. |
| Global staff | `platform_staff_grants`, separate from business ownership. |
| Websites and deployments | Existing `hosting_sites` and `hosting_deployments`. |
| Website form attribution | Existing immutable `hosting_site_forms` and `hosting_form_submission_links`. |
| Account event deduplication | `platform_identity_events`, keyed by issuer/event ID. |
| Staff change history | `platform_audit`; assignments, permission changes, suspension and cutover. |
| Compatibility rollout | `platform_runtime`; both switches initially false. |

Names and emails identify records for staff; they establish no authentication or
ownership authority. Development and production Clerk subjects stay separate. Staff directories and
account selectors show the verified issuer so similar names/emails cannot conceal
which authentication environment an account belongs to.
Signup grants no business access, staff role, sending permission or owner role.

Owners and viewers have explicit website/enquiry/booking permissions. Operators
may separately receive SMS-read and form-management permissions. Form-only operators
receive only their authorized form workspace selector and builder; message/submission
reads remain denied without SMS-read permission. Customer roles
cannot receive those operator permissions. An existing global administrator may
also own a business; the global staff grant preserves their administrative access.
SMS memberships do not automatically become customer ownership.

Only one enabled primary owner is allowed per business. Once customer cutover is
active, database triggers derive each site's compatibility `owner_account_id` from
its business owner. Changing permissions alone preserves `owner_assigned_at`;
ownership changes reset it. Unassigned websites remain staff-visible.

Customers need active accounts and completed onboarding. Website enquiries also
require enabled business permission and connection, and their submission time must
be within the current website ownership period. Bookings permission is explicit
and grants business-wide operational booking history. Booking-form enquiries are
not operational appointments. Disabled SMS forms keep prior enquiry visibility;
disabled E2 connections or membership permissions remove customer access.

Public form intake and business automation continue when an owner is suspended.
Suspension denies authenticated access immediately; restoring preserves grants.
Clerk deletion leaves a tombstone and retains operational records for reassignment.
Staff controls cannot suspend/remove the last active administrator for their Clerk
instance. External deletion of that Clerk administrator requires operator recovery.

## Staff workflow

1. In CRM → Users, locate the account by name/email and inspect onboarding status.
2. In Businesses, choose an existing workspace or use Add business. Assign the
   primary owner explicitly. Enable enquiry and booking access only as intended.
3. In Websites, create/select the website and assign its business. For the current
   migration, pair the existing owned website and choose its intended owner before
   activating customer cutover. Do not infer its business from its name/subdomain.
4. In Website → Business Info, save website-specific details. These remain separate
   from customer onboarding and the SMS business profile.
5. In Website → Leads, connect enabled SMS forms from that business and copy the
   generated snippets. Retire connections by disabling them; never repoint an embed.
6. Add snippets to website files, upload in Assets, build a preview, review, then
   publish. The hosting Worker and public website content are otherwise unchanged.
7. Verify enquiries and separately scheduled Bookings in the owner's E2 dashboard.

Transferring ownership removes the previous owner's customer permissions by
default while retaining staff authority. The action is transactional, audited and
requires the expected previous owner/revision. Sites cannot change business while
any retained form connection references that business, even if disabled. A separate
cross-business migration is required; this release offers no history transfer.

## Interfaces and security

`crm-api` verifies Clerk JWT signature, issuer, expiry and authorized party. Its
global `/platform` routes do not require `X-Tenant-ID`. Database functions resolve
the verified actor and independently require active global staff access.

| Endpoint | Purpose |
| --- | --- |
| GET `/platform/accounts`, `/businesses`, `/websites` | Searchable directories: `q`, `page`, `pageSize` (25 default, 100 maximum). |
| GET `/platform/{resource}/{id}` | Staff detail, including memberships and associated records. |
| POST `/platform/status` | `{accountId,revision,status}`; active/suspended only. |
| POST `/platform/memberships` | Account/business role and explicit boolean permissions; revision -1 means a new membership. |
| POST `/platform/ownership` | Target account/business, membership revision and `previousOwnerId`; serialized transfer. |
| POST `/platform/website-business` | `{siteId,tenantId,revision}`; foreign keys protect retained connections. |
| POST `/platform/connections` | `{siteId,formId}`; matching enabled form required. |
| POST `/platform/connections/disable` | `{siteId,connectionId}`; retains attribution/history. |
| E2 `/api/web-hosting/**` | Existing hosting backend, now supporting verified CRM bearer tokens and exact-origin CORS. |
| POST/DELETE E2 `/api/web-hosting/{siteId}/forms` | Audited form connection creation/disable. |
| POST E2 `/api/webhooks/clerk` | Signed lifecycle events; configured instance and signed envelope required. |

Stale changes fail with a conflict; refresh before retrying. Direct browser roles
cannot read/write platform registry tables or invoke server-only account/customer
RPCs. Realtime and public SMS compatibility readers use the shared authorization
helpers. Human Edge calls set issuer context inside the same transaction as each
RPC, never on a reusable pooled session. Registration's automation credential uses
that context too; background workers retain their queue-scoped identities.

Webhook and first-visit provisioning lock the issuer/subject, preserve UUID/onboarding,
discard stale events, and prevent late events recreating deleted accounts. The
installed Clerk SDK strips envelope metadata; the handler reads the identical
signed payload clone only after verification. Failures return a retryable response
and logs contain error codes rather than contact details.

## Configuration and rollout

E2 needs matching **production** Clerk publishable/secret keys, `CLERK_ISSUER`,
`CLERK_INSTANCE_ID`, and `CLERK_WEBHOOK_SIGNING_SECRET`. Configure Clerk's
user.created/user.updated/user.deleted events to the deployed E2 webhook endpoint.
Keep the webhook outside authenticated page protection; signatures authorize it.

CRM's public `HOSTING_API_BASE` points to the E2 `/api/web-hosting` endpoint.
`HOSTING_ALLOWED_ORIGINS` must list exact E2/CRM browser origins. Add a Render
preview origin only if it is intentionally used for staff hosting operations; add
the same origin to R2 PUT CORS. No server credentials belong in `dist/config.js`.

Reconcile existing Clerk users with the server-only script:

```powershell
node --env-file=.env.local scripts/reconcile-platform-accounts.mjs
node --env-file=.env.local scripts/reconcile-platform-accounts.mjs --apply --mapping=C:/private/reviewed-mappings.json
```

Set the matching issuer and publishable key for that run. The default is read-only.
The mapping file contains reviewed `{issuer,subject,accountId}` entries for existing
legacy rows; no email-based merges occur. It must stay outside committed files.
Production-wide Clerk reconciliation remains pending matching production credentials.

After deploying and verifying both frontends, inspect the service-only
`platform_rollout_report(issuer)`. Resolve unmapped identities/grants and the owned
website pairing; compare customer permission differences against audited staff
changes. `activate_platform_registry(issuer)` enables both canonical paths together
and refuses unresolved mappings. Legacy access tables then reject independent writes.
Set `CRM_HOSTING_URL=https://crm.e2local.com/?view=platform-websites` only after
verification to redirect the old E2 staff UI.

Run a controlled published pilot with messaging disabled before testing intended
automation separately. Observe submission/attribution errors and duplicate intake
counts without logging contact data. Never reactivate sending as a migration step.

Cleanup is `../E2local-main/supabase/maintenance/platform-cleanup.sql`, intentionally outside automatic
migrations. Verify an external backup, successful cutover/pilot and remaining
dependencies before setting its transaction gates. The script archives the three
legacy access tables privately, verifies copies, removes compatibility callers,
and aborts on remaining dependencies. It never uses CASCADE. Profile/intake/history
tables and still-used compatibility columns remain intact.

## Verification

Database tests cover real migrations, issuer isolation, retry/stale-event/deletion
handling, account identity preservation, ownership and permission cutoffs, all three
form presets, shared forms, connection retirement, denied browser reads, suspension,
last-administrator protection, global staff ownership and guarded cleanup.

HTTP tests cover tenant-independent platform routes and authenticated actor binding.
Real Clerk signatures are tested. Upload tests cover folder/ZIP paths, traversal,
duplicates, expansion limits and root index.html. Synthetic local browser inspection
covers directories, access editing, website details and connection empty states.
All **87 E2 tests** and **190 SMS tests** passed, along with targeted E2 lint,
TypeScript checking, both production builds and JavaScript syntax checks. Live
Node/service-role staff bridging and invalid-site rejection passed; R2 origin
preflights passed. See E2 PROJECT_RECORD.md for release limitations.

## Dashboard design alignment

The CRM uses the E2 dashboard's wordmark, Arial typography, white 64px header,
210px sidebar, pale blue background, outlined navigation states, 12px cards,
and blue/orange action colors. `public/dashboard-theme.css` is loaded after the
existing CRM styles by `public/index.html`; public embeds and authentication
pages retain their existing theme. The wordmark is mirrored as
`public/e2-dashboard-logo.svg` from E2's dashboard brand component.

Global Users, Businesses and Websites appear together above the selected
business workspace tools. Breadcrumbs distinguish global CRM pages from the
selected business. The existing mobile navigation drawer remains available;
search fields and cards stack at narrow widths. No authorization, database,
submission or sending behavior changes as part of this design update.

Verified locally on September 29, 2026: desktop and 390px mobile layouts,
website business-detail fields, dashboard metrics, active navigation and mobile
drawer opening/closing with synthetic records. All 12 targeted theme, editor,
platform API and form-builder tests passed; frontend build, JavaScript syntax,
SVG XML and whitespace checks passed. Frontend deployment remains pending.
