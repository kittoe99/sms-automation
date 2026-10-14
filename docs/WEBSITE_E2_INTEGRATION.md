# Website forms and E2 enquiries

## Create and deploy a website from CRM

The Deployments workflow and October 14 read/lifecycle hardening are local
implementation. Consult both project records for actual deployed revisions. The
new CRM requires the paired E2 site-detail API before its frontend release; see
[hardening release](HARDENING_RELEASE.md).

1. Open **Platform → Websites → Create website**. Enter a name and an available
   E2 Local subdomain. This saves an unpublished website; no business is inferred.
2. Open its **Deployments** tab (selected by default). Select a folder, ZIP, or ready-to-host files containing
   lowercase `index.html` at the root, then choose **Upload and preview**.
   Limits: 500 files, 20 MB per file, 50 MB expanded total. Compile source projects
   first; this workflow does not run Next.js, npm scripts, or server applications.
   Uploads run at most four requests at once, with a 120-second batch deadline.
   Navigating to another CRM tab does not wait for or cancel a submitted upload.
3. Open **Preview** and review the uploaded site. Choose **Publish** on that
   ready version to serve it at `https://<subdomain>.e2local.com/`.
4. The Deployments tab shows publication status and **Visit website**. Publishing an
   earlier ready version restores it; **Unpublish** removes public delivery while
   preserving saved versions. Find Unpublish in **Settings**. Failed builds leave the live version unchanged.
   **More** on each version contains View files and Delete version; live/building
   versions remain protected from deletion.
   Deployment history is paginated, normally 25 versions per page. Publication
   status is independent of the current page; an unavailable storage check is
   shown as unavailable rather than claiming the site is unpublished.
5. To give a customer dashboard access, deliberately assign the intended business
   and release its Website service from business setup. Public publication and
   customer service visibility are separate controls.

E2 owns the hosting API, R2 build/storage and delivery Worker. CRM owns the staff
interface. See [E2 hosting operations](../../E2local-main/docs/web-hosting.md).
The paired `tests/hosting-lifecycle.test.mjs` executes the real CRM file preparer,
E2 routes/build and Worker using in-memory database/storage adapters. It covers
creation, preview, publish, restore, unpublish, failed-upload recovery and rejected
requests; it does not prove cloud connectivity. No new migration was required
for the October 10 lowercase-root validation fix, whose E2/CRM validation changes
could release independently. The October 14 detail-read contract is a separate
dependency: deploy E2 before the new CRM frontend.

## Hosting reads and tab ownership

CRM's staff website directory remains the paginated CRM `/platform/websites`
read. Opening a website now requests
`GET /api/web-hosting/:siteId?page=1&pageSize=25`, returning
`{site,page,pageSize,total,totalPages}`. `site` contains only the requested page
of `deployments`, plus `liveDeploymentId` and `publicationStatus`. E2 validates
the live ID against the same site even if it is outside the page. Its R2 manifest
read is capped at five seconds, including body handling.

E2's root `GET /api/web-hosting` returns
`{sites,page,pageSize,total,totalPages}` with metadata only, default 25 and maximum
100 sites. It no longer scans all deployment histories or reads every site's
publication manifest. Both endpoints retain CRM staff authorization. E2 owns
the read model and `20261014061728_hosting_read_indexes.sql`; do not copy that
migration into CRM.

Each retained Websites page owns its DOM, selected subtabs and draft. Leaving
it aborts unfinished reads and prevents late repainting of another page. Writes
can complete in the background; return to the page and use its refresh hint to
load saved state. If a write times out, inspect the site/deployment before
retrying because the server may have accepted it. Session/business changes
discard retained drafts and media and re-authorize the next workspace.

The Leads form picker explicitly requests the website's assigned business even
when another business is selected in the CRM toolbar. That request bypasses the
selected-business cache. Server-side business permissions and same-business
connection validation still decide which forms may be linked.

## Competing or interrupted hosting changes

The October 14 local E2 changes serialize prepare/build/publish/unpublish/delete
operations per website. A 409 `hosting_busy` means another operation is running;
wait and refresh its state. A 409 `hosting_recovery_required` means the result
cannot be confirmed. Do not repeatedly publish, delete, or restart the build to
clear it. Expiry does not prove that a delayed R2 write stopped.

The E2 operator must stop the original invocation, inspect the authoritative
publication pointer/files and database state, and reconcile the exact observed
token/generation with evidence. Follow [operation recovery](../../E2local-main/docs/web-hosting.md#operation-recovery).
Malformed publication metadata blocks deployment cleanup before files are removed;
only an absent pointer establishes an unpublished site. Already-issued staging
upload URLs remain valid until expiry, so late uploads may leave temporary orphan
staging files subject to the configured lifecycle cleanup.

E2 owns `20261014071224_hosting_operation_fencing.sql`. Drain old hosting
mutation invocations before applying it, then deploy the matching API before
reopening changes. Old unfenced hosting code is incompatible with the new write
guards. The [E2 release guide](../../E2local-main/docs/reliability-release.md)
records this and the customer-query/contact migrations; they remain local and
unapplied for this review.

Historical October 1, 2026 linking release: canonical business membership and individual live-service status govern customer access. CRM API **v38** and the paired linking migrations are deployed. See [Business lifecycle](BUSINESS_LIFECYCLE.md), [complete implementation/release evidence](CRM_LINKING_RELEASE.md) and [staff workflow](STAFF_CRM.md). Legacy table-editor assignments are historical procedures, not the current authorization path.

## Historical initial release state

September 30 reconciliation of existing records: the shared E2 migration
`website_sms_enquiries` was recorded live as `20260929221427`, with `web-form`
version 7. The latest E2 project record names E2 `d6515e5` and CRM `1de5387`
as released, including customer enquiry/booking readers and hosting UI. Manual
business/owner/form pairing and a controlled published authenticated pilot remain
outstanding. These are recorded observations, not new live checks.

## Submission and attribution

The canonical migration is in the E2 repository:
`supabase/migrations/20260930050000_website_sms_enquiries.sql`. Do not copy or
reapply it as a second SMS migration, and do not replay local migration history
over the shared live database.

Use a website-specific iframe URL:
`https://crm.e2local.com/embed.html?form=<formId>&connection=<connectionId>`.
The connection is stored in `hosting_site_forms` and created by an authorized
administrator in the CRM after explicit business/website assignment.
Web Hosting → Leads supplies the complete snippet and existing resize script.
Legacy Form Builder snippets omit connection and remain available in SMS only.

Public GET/POST `/web-form/<formId>` accepts optional `connection`. Invalid,
mismatched, disabled, or unavailable connections do not fall back. New private
RPCs call the current submission function and create an immutable attribution
record in the same transaction. Failed attribution rolls back the submission
and intake. Retry fingerprints include the validated connection; cross-website
UUID reuse and attaching old submissions are rejected.

Answers, label snapshots, consent, opt-outs, rate limits, time-zone conversion,
and SMS/email automation remain owned by SMS. Connections establish intended
website association, not proof of physical browser origin. Customers have only
read access in E2; SMS memberships and Clerk sessions are not automatically
created or synchronized. No existing customer site/business was paired and no
production enquiry was sent during implementation.

The E2 reader requires completed onboarding, current ownership, active business
permission, active form connection, and submission after the current ownership
assignment. Reassignment hides earlier history from the new owner; staff can see
attributed history. Existing unattributed submissions remain in SMS.

Run `node --test test/webFormBuilder.test.js test/webFormSubmissions.test.js
test/websiteEmbed.test.js` for form/embed regressions. In E2 run
`npm run test:enquiries`; its integration database tests load this checkout's SMS
migrations in PGlite and apply the real E2 migrations. Both checkouts are needed;
set `SMS_PROJECT_ROOT` for a non-sibling SMS location. Verification passed: 66
E2 tests, 12 SMS form/embed tests, 22 SMS automation/email/embed checks (three
embed tests overlap), E2 lint/TypeScript/build, and SMS frontend build. Live
transactional verification used disabled sending and rolled back all test data.

Full manual setup and current frontend rollout/pilot status are recorded in the
E2 repository's `docs/sms-integration.md`. Release order: shared migration, SMS
Edge and embed frontend, E2 frontend, then a manually chosen controlled pilot.
No automatic sending activation is included.

## Operational bookings in E2

E2 also implements a read-only Bookings page over `sms_bookings`. Canonical E2
migration `20260930060000_dashboard_bookings.sql` is live as **20260930001422**;
do not copy/reapply it from SMS. `dashboard_account_businesses.bookings_enabled`
defaults false. Staff must explicitly enable it alongside `enabled` for the
completed E2 account and intended tenant. This grants that business's entire
operational booking history independently of website ownership; it creates no
SMS membership or sending permission. Revoke it separately during ownership or
business-access changes.

The service-only `read_dashboard_bookings` RPC returns curated customer/contact,
appointment, status, service address, source, and extra-answer fields; metadata
is excluded. Business/status filters and pagination remain authorization-scoped.
Website booking submissions stay in E2 Leads and automation intake; no operational
booking is inferred or created from a form request. Scheduling/cancellation
remain in SMS. No SMS application code or functions needed changing for this
read integration.

The original booking implementation recorded 74 passing E2 tests, targeted lint,
TypeScript/build, and rolled-back permission/status checks with temporary
sending-disabled data. Its earlier “frontend remains local” note is superseded
by the releases recorded above. See [E2 bookings](../../E2local-main/docs/bookings.md)
for the contract and [E2 project record](../../E2local-main/PROJECT_RECORD.md) for
later release evidence. E2's September 30 dashboard cache revisions update
customer reads without replacing SMS form or worker functions.

## Separate application logins (released)

The separate-login release record describes different Clerk applications for E2
customers and CRM staff. Same emails are allowed as independent issuer-qualified accounts.
Shared businesses/forms/enquiries/bookings remain; customer owners/viewers and
CRM staff/operators are separated by database issuer checks. Migration
`20260930110000_separate_login_realms.sql` was recorded live as `20260930054730`,
with dedicated keys, issuer-bound database authentication, lifecycle subscriptions,
CRM API version 35 and compliance-session version 10. Later records confirm an
explicit CRM administrator bootstrap; it is no longer a pending general setup
step. The authenticated integration pilot and intended assignments remain.
## Customer website update requests — deployed

CRM Websites → Update requests reads the latest 100 requests for the website's
current business and lets staff set Received, In progress, Needs information or
Completed, plus a customer-visible reply. It uses E2's staff-authenticated
`GET/PATCH /api/web-hosting/:siteId/requests` endpoint. Updates are revision-checked;
customer text/replies are escaped. No publish action or notification is implied.

Released: E2 migration `20261009053203` is applied; E2 `67a320a` and CRM
`7c43c2e` are live. No CRM migration, storage bucket or DNS change was made. Customer Assets/Domain connection
remain previews. See [full workflow and validation](../../E2local-main/docs/website-workspace.md).
