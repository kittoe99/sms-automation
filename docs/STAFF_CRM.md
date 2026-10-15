# Shared staff CRM and customer dashboard

## AI connections (local implementation)

Administration → AI connections manages staff MCP clients, their action grants,
selected or all-business scope, status and audit activity. New clients start
pending; activating a connection does not grant staff status. All-business access
includes future registrations. Agents execute granted actions directly and cannot
change their own grants. See [CRM MCP](CRM_MCP.md) for the nine first-milestone
tools and release prerequisites; this interface has not yet been deployed.

## October 12 production rollout status

CRM migrations are applied as `20261012202507 staff_voice_overview` and
`20261012202514 voice_setup_flow`; `crm-api` version 58 is ACTIVE. CRM frontend
commit `c43600a` is live in Render `dep-db6k4uavcj2c7389muug` at
https://crm.e2local.com; authenticated library and call-history checks passed. E2 application code is unchanged. The local-only/pending
notes below are historical and superseded by this status. Existing customer
Voice visibility stays draft until staff explicitly enable access.

Historical October 1, 2026 linking release (America/Denver): owner-linked registration, canonical CRM permissions, shared profile review and explicit service release are **deployed**. That release used CRM API **v38**; later releases supersede it. See [Business lifecycle](BUSINESS_LIFECYCLE.md) and the consolidated [implementation/release evidence](CRM_LINKING_RELEASE.md). Dated release observations below are historical.

Updated September 30, 2026 (America/Denver). `opek-sms` is the staff CRM;
E2 Local is the customer dashboard. Both use the same Supabase records.

Read [the staff user guide](USER_GUIDE.md) for daily procedures and the
[project record](../PROJECT_RECORD.md) for reconciled status. Release observations
below are historical evidence from prior work, not live checks performed during
this documentation update. Later dated releases supersede older observations.

## Page-load improvements (deployed October 4)

Startup uses the authorized session's workspace list once. Dashboard readers run
concurrently, with provisioning deferred to SMS setup. Forms retains its list and
presets for internal tab switches; Refresh and successful edits invalidate that
cache. Returning to a workspace tab retains its draft and nodes. Leaving an
unfinished main-page load cancels its reads; mutations are not cancelled.

Run `npm run build:frontend` for the hashed/minified app and lazy Forms/platform
chunks. Deploy the generated `dist/index.html` and its assets together. Apply the
`render.yaml` cache rules through the service's normal Blueprint/header workflow:
only content-hashed `/assets/*` is immutable; config and stable embed URLs must not
receive that policy. No API or database migration is required. These changes and
cache settings are live in CRM release `51f21b2` (Render deployment
`dep-db0vm9ou01pc73c5il3g`); see the project record for checks and limitations.

For synthetic browser checks, build then run
`node test/fixtures/platform-preview.js` and open `/shell` on port 4319.
`CRM_TAB_QA_LOG=1` logs API calls; `CRM_TAB_QA_DELAY_MS=8000` delays Bookings
to verify leaving a slow page and restoring a cached draft.

## Historical release status (superseded by the current release above)

CRM session fix (September 30): Users/Businesses/Websites and Realtime now use
the exact same versioned auth module as app initialization. Different query-string
versions created independent module state and caused missing bearer tokens despite
a successful login. The application entry and platform/live imports use refreshed
asset URLs. A regression test reproduced the original 401, then passed for all
three directories, token refresh and sign-out after the correction. All 196 CRM tests, including eight targeted auth/platform checks, JavaScript
syntax checks and frontend build passed. This is
a frontend correction; administrator grants and API authorization are unchanged.
Correction **1de5387** is pushed and live on Render in deployment
**dep-dauo39s1nsns73f1sh5g**. Production HTML references the refreshed entry;
app/platform/live assets returned 200, matched source, and resolve the same auth
module. The user’s signed-in phone session was not remotely inspected.

September 30 administrator bootstrap is complete: the user explicitly approved
the newly created CRM account. Its dedicated production Clerk identity was
verified, and a transaction enabled canonical and compatibility staff access.
Independent database checks confirmed one active CRM administrator, zero customer
staff grants and one audit entry. Authorization cutover remains OFF. Reload the
CRM to retrieve updated authorization; no application deployment is required.
Business/website assignments and the authenticated workflow pilot remain separate.

CRM login and account-access screens use the existing E2 dashboard logo asset.
Clerk controls match E2 `app/auth-appearance.ts`: blue borders, rounded cards,
48px inputs and gradient pill buttons. Separate sign-in and signup stay in the
branded CRM screen using the independent CRM Clerk application. Local syntax, three targeted
authentication/theme tests and the production frontend build passed. Branding
release `b6eb5b1` is live on Render (`dep-dauhch17lnhs73bcoiqg`). Desktop and 390px
browser checks verified the current logo, 24px card corners, 48px controls, pill
buttons and no horizontal overflow; the browser reported no errors. Asset version
references were refreshed so cached browsers load the new styling. Follow-up
release `6637821` is live (`dep-dauhhbe0tbcc73ff81ig`), restoring explicit Sign in
and Sign up links using mountSignIn/mountSignUp and the same appearance. Browser
navigation between both screens was verified. Three targeted tests, syntax and
frontend build passed; no account was created during visual verification.

CRM Google login is enabled in production after the user's explicit approval.
A separate Google web client uses origin `https://crm.e2local.com` and callback
`https://clerk.crm.e2local.com/v1/oauth_callback`; its credentials are stored in
the CRM Clerk application, outside repository code. Customer Google configuration
was compared before/after and is unchanged. Clerk's authenticated database role
claim is retained. Sign-in and signup both display the white outlined Google
button with the current E2 logo/design. Clicking it reached Google's account
chooser using the dedicated client, correct callback and only openid/email/profile
scopes, with no OAuth error. No account selection, signup or staff grant was made;
the first completed Google login was still a user pilot step at that observation.
The later explicitly authorized administrator bootstrap described above is complete.
The existing Google project's audience remains External/Testing. Basic identity
scopes qualify for [Google's test-user exemption](https://support.google.com/cloud/answer/15549945?hl=en);
the project was not republished and no additional Google API scopes were granted.
This was a live provider configuration change; no application rebuild, schema or
Edge deployment was required.

Keep future CRM screens consistent with E2 Local and reuse its existing logos.

| Component | Actual status |
| --- | --- |
| Registry migration | Live: local `20260930070000_platform_crm.sql` → live `20260930012338`. |
| Staff protection migration | Live: local `20260930080000_platform_crm_hardening.sql` → live `20260930013528`. |
| Form permission migration | Live: local `20260930090000_platform_form_permissions.sql` → live `20260930015523`. |
| Identity directory migration | Live: local `20260930100000_platform_identity_directory.sql` → live `20260930020115`. |
| Login separation migration | Live: local `20260930110000_separate_login_realms.sql` → live `20260930054730`; issuers configured in the migration transaction. |
| CRM Edge API | Version 35 deployed with dedicated CRM issuer and first-login provisioning. |
| Compliance/registration Edge API | compliance-session version 10 deployed with dedicated CRM issuer and transaction-local identity context. |
| Identity backfill | The reset cleared old mappings. Fresh customer and CRM identities are provisioned; the explicitly authorized CRM administrator is enabled and audited. |
| Registry cutover | OFF. One verified active CRM administrator has canonical and compatibility grants; no customer has staff access. |
| R2 uploads | Existing CORS rules retained, `https://crm.e2local.com` added. Both CRM and E2 preflights returned 204. No website files changed. |
| Frontends / account webhook | Latest recorded releases: E2 d6515e5 on Vercel and CRM 1de5387 on Render. Separate lifecycle subscriptions remain recorded as configured. An explicit CRM administrator bootstrap is complete; the published authenticated integration pilot remains. |
| Legacy cleanup | Prepared separately; NOT run. Requires verified release, controlled pilot and external backup. |
| Pilot | Local SQL/HTTP/UI verification performed. A published website pilot is still pending. No customer messaging was activated. |

The original review covered 69 application tables, followed by six platform
registry/audit/runtime tables and two later E2 dashboard-cache tables. This is a
recorded inventory, not a fresh live count. See the [table inventory](DATABASE_INVENTORY.md)
for retention and consolidation decisions. Do not blindly push either repository's
older migration history. Earlier E2 and SMS migrations have live timestamp aliases;
compare live definitions and the mapping in [PROJECT_RECORD.md](../PROJECT_RECORD.md) first.

## Separate-login production switch

The shared production Clerk assumption is superseded by two independent Clerk
applications. Identical emails are allowed with separate issuer/subject account
UUIDs. New code requires dedicated CRM credentials, CRM-only staff/operator grants,
customer-only owners/viewers, separate signed webhooks and issuer-bound legacy SMS/
Realtime access. See [E2 separate login setup](../../E2local-main/docs/separate-logins.md) for environment variables, bootstrap and coordinated rollout.
The separate-login release recorded E2 migration `20260930110000_separate_login_realms.sql`
as live `20260930054730`. The CRM issuer is `https://clerk.crm.e2local.com`;
E2 retains `https://clerk.e2local.com`. DNS, certificates, mail, dedicated secrets,
signed lifecycle subscriptions and CRM database authentication were verified in
that release, with CRM Edge version 35 and compliance-session version 10. The
initial frontends were E2 `37c9a2d` and CRM `a4b5247`; the table above identifies
later recorded releases. Hosting requires CRM bearer credentials, the customer
dashboard requires customer login, and unsigned lifecycle requests were denied.
The subsequent explicitly authorized CRM administrator bootstrap is complete.
Authenticated integration and same-email browser pilot coverage remain separate
from successful public login-page verification.

## Sources of truth

| Record | Source |
| --- | --- |
| Authentication | Separate customer and CRM Clerk applications configured in production; same emails remain independent identities. Database/API switch is live; frontend releases are verified. |
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
cannot receive those operator permissions. A person may have separate customer
and CRM identities; the CRM identity cannot be assigned as a customer owner.
SMS memberships do not automatically become customer ownership.

Only one enabled primary owner is allowed per business. Database triggers derive
each site's compatibility `owner_account_id` from
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

1. Find the completed customer registration in CRM → Users. The business should
   already be linked to its verified owner and appear in Businesses. For reviewed
   reconciliation cases, use **Set up registered business** and explicitly select
   the intended customer/business; do not infer ownership from names or email.
2. Extend the prefilled profile in **Businesses** or **Business context**. Both
   share one draft and revision. Save draft preserves work; Save reviewed profile
   atomically approves facts and business name/time zone. Refresh and reconcile
   after a 409 conflict; failed saves retain input.
3. Explicitly add the intended services. **Add SMS** initializes the provider and
   deduplicated bootstrap job; registration and provisioning retries do not
   substitute for this action. Website linking is also explicit. The retained
   unassigned website must remain unassigned until an administrator selects it.
4. In Website → Business Info, maintain website-specific details separately from
   the customer submission and shared operational profile. In Website → Leads,
   connect the intended enabled form and copy the generated snippet. Disable
   retired connections; never repoint an existing embed.
5. Review website previews and publish only when intended. Separately choose
   **Set live** for each customer-facing service. Enquiries require both their
   service and the source website to be live. Bookings release independently.
6. Verify the customer's dashboard and Refresh behavior. Service visibility does
   not activate sending, purchase numbers or replace consent/readiness checks.
   Ownership transfer and website reassignment require renewed release.

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
| GET `/platform/accounts`, `/platform/businesses`, `/platform/websites` | Searchable directories: `q`, `page`, `pageSize` (25 default, 100 maximum). |
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

E2 needs its customer **production** Clerk publishable/secret keys, `CLERK_ISSUER`,
`CLERK_INSTANCE_ID`, and `CLERK_WEBHOOK_SIGNING_SECRET`. Configure Clerk's
user.created/user.updated/user.deleted events to the deployed E2 webhook endpoint.
Keep the webhook outside authenticated page protection; signatures authorize it.

CRM's public `HOSTING_API_BASE` points to the E2 `/api/web-hosting` endpoint.
`HOSTING_ALLOWED_ORIGINS` must list exact E2/CRM browser origins. Add a Render
preview origin only if it is intentionally used for staff hosting operations; add
the same origin to R2 PUT CORS. No server credentials belong in `dist/config.js`.

When needed, reconcile existing Clerk users with the server-only script **from
the E2 checkout**, not from `opek-sms`:

```powershell
node --env-file=.env.local scripts/reconcile-platform-accounts.mjs
node --env-file=.env.local scripts/reconcile-platform-accounts.mjs --apply --mapping=C:/private/reviewed-mappings.json
```

Use --application=customer or --application=crm with that app’s matching issuer, publishable key and server secret for the run. The default is read-only.
The mapping file contains reviewed `{issuer,subject,accountId}` entries for existing
legacy rows; no email-based merges occur. It must stay outside committed files.
The pre-signup inventory recorded zero users and no backfill. This historical
observation predates fresh account creation and the administrator bootstrap; it
does not describe the later account count. Reconcile each realm independently as
accounts are created, using a fresh inventory for any future operation.

Canonical authorization and customer release checks are already enforced with
both compatibility flags false. The retained `platform_rollout_report(crm_issuer)`
and `activate_platform_registry(crm_issuer)` procedures belong to the separate
legacy transition/cleanup workflow; they are not required to make new grants,
revocations or service visibility effective. Before any future cleanup, reconcile
identities and permission differences, inspect current definitions and obtain the
required external backup. This release did not run cleanup or assign the retained
website.
The local `/web-hosting` route now redirects directly to the independently authenticated CRM; configure `CRM_HOSTING_URL` for its Websites entry point.

Run a controlled published pilot with messaging disabled before testing intended
automation separately. Observe submission/attribution errors and duplicate intake
counts without logging contact data. Never reactivate sending as a migration step.

Cleanup is [E2 platform-cleanup.sql](../../E2local-main/supabase/maintenance/platform-cleanup.sql), intentionally outside automatic
migrations. Verify an external backup, successful cutover/pilot and remaining
dependencies before setting its transaction gates. The script archives the three
legacy access tables privately, verifies copies, removes compatibility callers,
and aborts on remaining dependencies. It never uses CASCADE. Profile/intake/history
tables and still-used compatibility columns remain intact.

## Historical verification

Database tests cover real migrations, issuer isolation, retry/stale-event/deletion
handling, account identity preservation, ownership and permission cutoffs, all three
form presets, shared forms, connection retirement, denied browser reads, suspension,
last-administrator protection, global staff ownership and guarded cleanup.

HTTP tests cover tenant-independent platform routes and authenticated actor binding.
Real Clerk signatures are tested. Upload tests cover folder/ZIP paths, traversal,
duplicates, expansion limits and root index.html. Synthetic local browser inspection
covers directories, access editing, website details and connection empty states.
At that rollout, **87 E2 tests** and **190 SMS tests** passed, along with targeted E2 lint,
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
SVG XML and whitespace checks passed. CRM static deployment is now verified; see the release entry below.

## Historical frontend releases — September 29 and 30, 2026

Earlier September 30 release: `deploy-crm` source **99f8c9a** was recorded live in
Render deployment **dep-dauk8iflk1mc73d7co20**, rebuilt with cleared cache in
confirmed Micah's workspace. HTML and app/auth/theme/logo assets returned 200
and matched source. This includes the existing branded separate login screens
and documented independent Google configuration. E2 source **95004c2** is Ready
on Vercel (**dpl_3CbGR7vf6j7p9HG7f2tQn96dGPAd**) with dashboard caching and
the simplified Refresh control. Public E2 pages returned 200; unsigned dashboard
data requests redirected to sign-in. Both production builds succeeded.
Render still reports a repository-access warning and one high dependency-audit
finding; the build succeeded. No database/reset SQL, website publishing,
account grants or messaging changes were executed. Staff bootstrap and the
authenticated pilot were pending at this point. Later records at the top of this
guide supersede the release identifier and confirm administrator bootstrap; the
published authenticated integration pilot remains outstanding.

Manually retriggered the static site `wpacquisition-crm` in the confirmed
Micah's workspace. Render deployment `dep-dau7il9srm7s73b40mb0` built commit
`b5d25c14862a20fc34009439260956d97b24802a` from `deploy-crm` and became live
at 2026-09-30 02:52:17 UTC (September 29, America/Denver).
The public `https://crm.e2local.com` HTML, app module, platform module, dashboard
stylesheet and wordmark returned 200 and matched the deployed source after
normalizing line endings. Authenticated staff/customer workflows and E2 hosting
API/webhook release were not verified by this static deployment check.

Auto-Deploy is enabled on the correct branch, but the preceding GitHub push had
produced no deployment. Build logs warn that Render does not have access to the
repository; a public clone still succeeded. Restore the Render GitHub app/repository
credentials to address future automatic deployments. No permission expansion,
account assignments, messaging activation or database changes were performed.

## Account and business data reset — September 29, 2026

Historical record only. Later account creation and administrator bootstrap
supersede the empty-account observations below; this is not a reset procedure.

The user reset Clerk and requested deletion of all database accounts and their
records, explicitly including CRM businesses and operational data, while keeping
website data. The reviewed live inventory contained 4 accounts and 2 businesses.
The transaction was tested with ROLLBACK, then committed. No tables, functions,
policies, indexes or migration history were dropped or changed.

Post-commit reads verified zero account identities, accounts, onboarding profiles,
canonical/legacy memberships, staff/admin grants, businesses, contacts, messages,
bookings, form definitions/submissions, jobs and business-provider records.
The reset cleared operational intake, consent, usage, audit, knowledge, webhook,
voice and queue history as well as public contact/pricing requests. Business-linked
Vault secrets were removed except secrets referenced by retained global configuration.

One hosted website and one deployment remain. Their saved content, details, slug,
source metadata, manifest and publication/preview references were compared inside
the transaction and preserved. Owner/business links and the ownership cutoff were
cleared. Required creator strings now use `account-reset:2026-09-29` rather than
old Clerk subjects. R2 objects, external provider accounts/numbers and external
archives were not deleted. An HTTP check of the hosted domain returned 403 from
the current client, so external serving was not independently confirmed by this
reset; no hosting or Worker changes were made.

Pricing definitions, global worker/email configuration, runtime rows and queue
structure remain. Canonical authorization switches remain OFF. Historical rollout
counts in earlier entries describe the pre-reset data and must not be reused.
New businesses will need fresh configuration and form connections.

### Restore staff access to a fresh account

After configuring the login split, create the new CRM Clerk account and visit
the CRM to provision its verified account record. Customer E2 identities cannot
receive staff grants. Check `platform_account_identities` for its exact production issuer,
subject and account UUID and verify the account is active. Explicitly choose that
new account as the administrator; do not infer authority from email or grant it to
the first signup automatically. A staff/bootstrap SQL action must add its canonical
`platform_staff_grants` record and, while compatibility authorization is OFF, its
matching subject in `sms_private.admins`. No business membership or website
ownership is granted automatically. Recreate the intended businesses and assign
the retained website through the CRM after staff access is restored.

## October 5 availability update

CRM Booking setup now supports multiple daily windows, structured exceptions and
slot previews. SMS booking is now independently gated by the Inbound AI pilot; see [Inbound AI](INBOUND_AI.md). A separate restricted
voice bridge supports new-booking preparation/confirmation after phone verification
and a fresh caller confirmation. Activation defaults off. See
[Booking availability](BOOKING_AVAILABILITY.md) for contracts, migration order,
caller workflow and actual validation. Earlier legacy `opek` voice-bridge setup
instructions do not activate the new registered-business endpoint.

## Voice Agent workspace

Staff can manage voice configuration, calls/recordings, qualified leads and booking attribution. See [Voice CRM](VOICE_CRM.md). Configuration publication applies to new calls; availability stays in Booking setup.

## Forms and automation dashboard

CRM Dashboard and Forms list all forms for the selected business, including drafts
and archived forms. Search by name, description, type or ID, or use Form status.
Summary totals always cover all forms; filtering only changes the displayed list.
Each card shows all-time submission count, automation state/version, form type,
custom fields and recorded dates. Expand Form details for its ID, version, submit
button and field labels. Open form edits or previews the form; Submissions and
Automation open those tabs directly when the user has read access.

An Active automation is the saved sequence setting, not a guarantee that SMS can
send: consent, business sending settings and delivery eligibility still apply.
Archived submissions remain in totals. Missing counts are Unavailable and missing
creation dates are Not recorded. Refresh reloads the current business data.
This CRM-only frontend release uses the existing form-workspace API; E2 site
connections, customer permissions and shared submission attribution are unchanged.
Released in CRM Render deploy dep-db472am0tbcc73dcaueg (October 9, 2026 UTC).

## Voice Agents setup (local, pending release)

The redesigned Voice Agents library supports new CRM drafts, existing deployed
agent selection, call history and a guided customer-release checklist. Business
records have the same Voice panel and an Open Voice Agents shortcut. See
[CUSTOMER_VOICE.md](CUSTOMER_VOICE.md#voice-agents-library-and-guided-release)
for creation, runtime-connection boundaries and rollout order.
