# SMS user/business linking: implementation and release

Status: **deployed and verified October 1, 2026 (America/Denver)**. Migration
filenames and some earlier log entries use October 2 UTC; they refer to this same
release. This document consolidates the paired `opek-sms` CRM and `e2-local`
implementation, deployment evidence and operational boundaries.

Companion records: [CRM project record](../PROJECT_RECORD.md),
[E2 project record](../../E2local-main/PROJECT_RECORD.md),
[CRM business lifecycle](BUSINESS_LIFECYCLE.md), and
[E2 business services](../../E2local-main/docs/business-services.md).

## Registration through customer release

1. A customer completes E2 Personal and Business Info. Registration atomically
   saves the original submission, creates or reuses one canonical business, and
   links the verified customer account as its primary owner.
2. CRM displays that business as **Awaiting admin setup**. Registration creates
   no SMS provider or provisioning job. The customer sees the business name and
   **We're setting up your services**.
3. A CRM administrator extends the prefilled profile through **Businesses** or
   **Business context**. Both edit one persisted draft. **Save draft** preserves
   work; **Save reviewed profile** approves the operational facts.
4. The administrator explicitly adds SMS, enquiries or bookings, or creates/links
   a website. Added services start hidden from the customer.
5. The administrator selects **Set live** separately for each intended service.
   **Hide from customer** reverses that visibility. Website publication, provider
   readiness, sending activation and consent remain separate controls.

Ownership is established by verified account/business links, never by matching
names or email addresses. The retained unassigned website is not automatically
attached to the registered business. Transfers reset customer service visibility;
website reassignment resets that website's release.

## Authorization and operator access

Every CRM decision uses the verified CRM issuer/subject, active account status,
enabled canonical staff grants and enabled canonical business memberships.
Revocation takes effect for subsequent authorized reads/writes regardless of
`auth_cutover` or `customer_cutover`. Conflicting legacy grants cannot restore
denied access. Legacy tables and both switches were retained without grant
migration or cleanup.

| Caller | Permitted workspace | Writes and restrictions |
| --- | --- | --- |
| Canonical CRM administrator | All businesses and staff directories | Profile review, provisioning and operational mutations remain subject to their normal business guards |
| CRM SMS-read operator | Only permitted businesses; overview, contacts, messages, conversations, calls, bookings, automation data and form reads | No sending, provisioning, profile approval, global diagnostics or other operational mutations; form editing needs its separate grant |
| CRM forms-only operator | Only permitted form workspaces | Can edit forms; cannot read SMS messages or form submissions without SMS-read access |
| Customer owner/viewer | E2 customer services permitted by ownership/membership and individual service release | Customer ownership never grants internal CRM/SMS access |
| Unrelated customer, suspended account or deleted identity | No unauthorized workspace access | Denied by identity/account and business authorization checks |

`/auth/me`, `/tenants` and `/businesses` load workspaces directly from canonical
session lookup. Existing response fields remain available, including accurate
`smsRead` and `formsManage` flags. Forms-only operators can enter their editor
without an administrator-only business-directory request.

The UI hides unavailable navigation/actions and does not automatically mark
conversations read for SMS-read operators. Database functions enforce mutation
restrictions independently of the UI. Realtime SELECT policies use the same
canonical SMS access decision. A phone-based conversation lookup resolves an
existing conversation for a reader; only an administrator may initialize a
missing conversation.

## Shared profile contract

`platform_business_setup` holds the shared draft, reviewed profile reference and
optimistic revision. Both editing entry points and the existing onboarding/profile
approval API routes use the same workflow.

- A draft save merges supplied fields into the persisted draft, increments its
  revision and leaves approved facts unchanged.
- Review atomically updates the approved profile version, setup record, business
  name/time zone, audit trail and applicable customer-cache revision.
- The original `dashboard_business_profiles.profile` submission stays intact.
  Fields omitted by an editor are retained.
- Writes require the expected setup revision. Missing or stale revisions return
  **409 Conflict**. Refresh and reconcile the draft before retrying.
- Failed API/network saves retain unsaved input and show an error. Production
  does not report a successful local-only save.

CRM paths below are relative to the `crm-api` function. They require a verified
CRM session; tenant routes also require `X-Tenant-ID`. These are contracts, not
production smoke-test instructions.

| Endpoint | Contract |
| --- | --- |
| GET `/onboarding` | Shared draft in `onboarding`, `revision`, review/completion metadata and `approved` facts |
| POST `/onboarding` | Profile fields plus `revision` and `intent: "draft"` or `"review"`; omitted intent defaults to review |
| POST/PATCH `/platform/business-profile/draft` | `{tenantId, revision, profile}` |
| POST/PATCH `/platform/business-profile/review` | Same shape; atomic review |
| POST `/profile-versions` | Profile fields plus setup `revision`; creates a draft and returns `setupRevision` |
| POST `/profile-versions/{id}/approve` | `{revision}`; approval passes through the shared setup workflow |
| GET `/provisioning` | Sanitized setup state includes `serviceAdded` |
| POST `/provisioning/details` | Administrator-only; rejects a business without an initialized SMS provider |
| POST `/twilio/provision` | Administrator-only retry; rejects before Add SMS and queues no job |

## Explicit SMS addition

Before SMS is added, the CRM shows **SMS has not been added** and links to that
business's setup. It does not imply background provisioning is underway.
Explicit **Add SMS**, after profile review, initializes one provider and the
deduplicated bootstrap job. Repeated additions do not create duplicate providers
or bootstrap jobs. Adding SMS does not set it live for the customer or activate
sending. The customer-facing SMS service remains a read-only summary.

## Migration ownership and applied order

Shared Supabase project: `wxamwhfmelxqahkdtcci`. Existing account, registry,
separate-login and dashboard-cache migrations are prerequisites. Earlier local
timestamps have recorded live aliases; never replay either repository's history.

| Applied order | Owning repository | Migration | Status |
| --- | --- | --- | --- |
| 1 | CRM | `20261001235349_business_service_prerequisites.sql` | Previously applied lifecycle prerequisite |
| 2 | E2 | `20261001235352_business_registration_services.sql` | Previously applied owner-linked registration and service release |
| 3 | CRM | `20261002024327_sms_workspace_access_guards.sql` | Applied; scoped readers and provider guards |
| 4 | E2 | `20261002024330_canonical_crm_access_profiles.sql` | Applied; canonical authorization and shared profile contract |
| 5 | CRM | `20261002031422_read_only_conversation_lookup.sql` | Applied follow-up; reader lookup cannot create conversations |

The first two new migrations were compared against 22 live function definitions,
then rehearsed in a transaction that rolled back. Application preserved service,
provider/job, membership, staff-grant and compatibility-setting state. The lookup
follow-up received its own live comparison and rollback rehearsal; the final
definition hash matched the rehearsed result.

The release coordinated database changes, CRM API and static assets with E2.
An old profile editor lacking revisions will fail closed with 409, so reverting
only the frontend is not a complete rollback. Recover with a reviewed forward
migration or a coordinated compatible application/database change; do not replay
historical SQL or run the separate legacy-cleanup script as rollback.

## Verified deployed versions

| Component | Verified release |
| --- | --- |
| CRM static site | [crm.e2local.com](https://crm.e2local.com), Render `dep-davi1apsrm7s73c39bn0`, **live**, frontend commit `4dd63fc` |
| CRM repository head | `d1aa8bb`; adds the applied SQL lookup guard and release documentation; frontend assets are unchanged from `4dd63fc` |
| CRM API | `crm-api` **v38 ACTIVE**; `/auth/config` reports the CRM realm; unauthenticated `/auth/me` returns 401 |
| E2 production | [www.e2local.com](https://www.e2local.com), Vercel `dpl_kqawguS3mJBQ3H3SDLNi41qSLJTj`, **READY**, commit `fe009ce` |
| Shared database | All three linking/access follow-up migration versions confirmed present |

The deployment recheck fetched `index.html`, `app.js`, `platform.js`,
`profileClient.js` and `workspacePermissions.js` from the CRM domain: all returned
200 and matched the current committed assets after line-ending normalization.
The E2 domain returned 200. No additional deployment was pending. Render needed
a manual clean-cache deployment after no automatic build appeared; the later
SQL-only follow-up required no frontend/API redeploy.

## Verification evidence and limits

| Verification | Result |
| --- | --- |
| Complete CRM suite | **202/202 passed**, rerun after the lookup guard |
| Complete E2 suite | **132/132 passed**, rerun after the lookup guard |
| Builds | CRM frontend and E2 production build passed |
| E2 static checks | TypeScript and full lint passed |
| Combined database/handler tests | Both migration histories; administrators, SMS-read/forms-only operators, customer owners, unrelated customers, suspended accounts and deleted identities |
| Permission regressions | Both switch values, conflicting legacy grants, immediate revocation, cross-business denial and authenticated RLS used by Realtime |
| Lifecycle regressions | Shared drafts/review, stale/concurrent revisions, retained fields, ownership transfer, website reassignment, release/hide, cache and realm isolation |
| Provisioning regressions | No job before Add SMS; repeated Add SMS creates one provider/bootstrap job |
| Synthetic browser walkthrough | Real handlers with paired PGlite database; profile synchronization, conflict input retention, reader controls and forms-only saves |
| Authenticated production walkthrough | Staff startup/Realtime, correct owner-linked business, both profile prefills; separate customer login shows setup notice with hidden unreleased assets; Refresh preserves the result; no browser console errors |

Production operator identities and real provider sending were not exercised.
The production walkthrough did not add services, change ownership, publish a
website or activate messaging. Those transitions were covered with isolated data,
not performed against the retained live assets.

The last production recheck found one business and one enabled owner link, with
zero services, released services, assigned websites, providers and jobs. Both
compatibility flags remain false. Security Advisor remained **0 errors, 5 existing
warnings and 36 informational suggestions** after rerun. The existing Render npm
audit high-severity warning remains; dependencies were not changed. Unrelated
local documentation and development-preview edits were preserved.
