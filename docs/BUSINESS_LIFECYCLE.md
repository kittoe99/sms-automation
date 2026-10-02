# Business registration and service release

Deployed October 1, 2026: both shared database migrations, CRM API version 37,
CRM `0638dcf` and E2 `9581ea2` are live. Compare this CRM with `../E2local-main` (package
`e2-local`) whenever changing registration, ownership or customer service access.

## Customer to CRM workflow

1. The customer completes Personal and Business Info in E2 Local. One transaction
   saves their submitted profile, completes onboarding, creates one canonical
   business, and attaches their verified account as its primary owner. Retries
   reuse the business. Names and email addresses never determine ownership.
2. The business appears in CRM **Businesses** with **Awaiting admin setup**. Its
   customer sees the business name and “We're setting up your services.” No SMS
   provider, provisioning job, forms or automation groups are created at registration.
3. An administrator opens the business and extends the prefilled profile. The
   original customer submission remains available separately. **Save draft**
   preserves work; **Save reviewed profile** approves the operational profile.
   Draft changes do not replace the last approved facts.
4. The administrator explicitly adds SMS, enquiries or bookings, or creates/links
   a website. Services start **Draft · hidden from customer**. SMS addition
   initializes its provider and queues the existing deduplicated Twilio bootstrap.
   Enquiries/bookings do not provision Twilio. Setup/configuration remains in the
   corresponding CRM tools.
5. The administrator selects **Set live** for each service that the customer
   should see. **Hide from customer** reverses that visibility. Both actions are
   audited and reject stale revisions.

Set live controls dashboard visibility only. It does not publish a website,
purchase a number, enable SMS sending, or bypass operational readiness and consent.
Released SMS is a read-only business number/status summary in E2. Voice and email
remain outside this customer release registry.

## Ownership and release rules

- New administrative setup starts with **Set up registered business**, selecting
  an active E2 customer with completed onboarding. Blank, ownerless business
  creation is no longer available through the CRM API.
- Service addition/release requires an active customer owner and a reviewed
  profile. Enquiries also require an enabled website/form connection before release.
- Website enquiries require both the enquiry service and the source website to
  be live, plus the connection/ownership history rules. Counts and filter choices
  use the same authorized source as rows. Bookings release independently.
- Customer owners can view released services. Other customer members require the
  explicit matching website/enquiry/booking permission. Raw CRM messaging tools
  and provider secrets are never granted by customer ownership or service release.
- Ownership transfers reset all business services to hidden. Website reassignment
  resets that website's release; unlinking removes its customer service entry.
  A subsequent administrator release is required for the new owner/business.
- Suspended/deleted customers cannot read services. Hiding an existing service
  remains available while its owner is suspended.
- Customer authorization always uses the canonical service registry, regardless
  of the existing compatibility switches. CRM staff/operator authorization also uses canonical grants immediately; legacy
  tables and switches remain for the separate cleanup process.

## Existing registrations and assets

The E2 migration reconciles active completed customers from verified primary-owner
memberships or explicit website-owner links. It creates a business when no strong
link exists. Multiple candidates or conflicting owners are flagged in the CRM
customer detail; the administrator must select the intended existing business.
It never guesses from business name/email. Historical businesses and service
resources are preserved. Existing linked websites, SMS providers, form connections
and bookings become draft service entries. They require profile review and explicit
release before customer display. Reconciliation is repeatable and starts no new
provider jobs. Historical unassigned websites stay unassigned until linked.

## Coordinated rollout

1. Compare both migration histories with the live catalog and recorded timestamp
   aliases. Do not replay either repository's historical migrations.
2. Apply CRM `20261001235349_business_service_prerequisites.sql` first, then E2
   `20261001235352_business_registration_services.sql`, with the existing account,
   registry, separate-login and dashboard-cache migrations already present.
3. Deploy the updated CRM `crm-api` adapter and static assets together with the E2
   application. The new UI requires both migrations. Database release immediately
   hides unapproved existing assets, so coordinate the rollout with admin review.
4. Review reconciliation issues and existing assets in CRM. Complete/review each
   extended profile and explicitly release intended services. Do not activate
   sending or publish websites merely to test customer visibility.
5. Run a controlled authenticated pilot for onboarding, staff review, individual
   service release/hide, ownership transfer and customer refresh. The October 2 staff/customer walkthrough is complete; changing real services,
   ownership or provider activation remains a separate operational action.

E2 browser snapshots use schema version 2. Registration, profile, provider,
ownership and service changes invalidate applicable cache revisions; navigation,
focus return or Refresh revalidates them. An already open page is not continuously
pushed new state.

## Verification

Both migration histories are exercised together in E2's
`tests/business-services-database.test.mjs` using the CRM PGlite harness. Tests
cover atomic retries/rollback, no onboarding provisioning, service idempotency,
profile activation, stale writes, realm/access isolation, both compatibility modes,
cache invalidation, transfers, website reassignment, independent release filters,
and existing-data reconciliation. E2 rendered-component tests cover hidden cards,
navigation, counts/activity, direct links and the SMS summary. CRM adapter and
profile normalization tests exercise the new request contract.

See both project records for actual test results and deployment status. Local
PGlite checks do not replace Supabase deployment checks, provider integration
verification or the authenticated pilot.


## CRM access and shared profile contract (October 2 follow-up)

Apply CRM `20261002024327_sms_workspace_access_guards.sql` before E2
`20261002024330_canonical_crm_access_profiles.sql`, after the October 1 lifecycle
pair. Never replay migration history on the shared database. Compare live function
definitions and rehearse the exact forward migrations transactionally first.
Coordinate crm-api and CRM static assets; the profile write contract now requires
an expected setup `revision` (409 on missing/stale values). Reverting only the UI
would leave old profile submissions failing closed.

Canonical CRM issuer/subject, active status, enabled staff grants and enabled
operator memberships are authoritative regardless of compatibility flags. Global
staff see all businesses; SMS-read operators see scoped read screens; forms-only
operators see their form editor. Customer ownership never permits internal tools.
Operational writes, profile review, provisioning and global diagnostics remain
staff-only. Forms require their distinct permission. Realtime SELECT policies
consult the same canonical SMS decision, so revocation applies to further reads.

Businesses and Business context edit one server draft. Save draft changes no
approved facts; Save reviewed profile atomically updates approved version, setup,
name/time zone, audit and customer-cache revision. Both entry points merge omitted
fields and preserve the original registration. Refresh before retrying a conflict;
failed saves retain input and cannot report a local-only success.

Without an initialized SMS provider, setup says **SMS has not been added** and
links to Businesses. Retry/setup-detail writes create no jobs. Explicit **Add SMS**
remains retry-safe and initializes one provider/bootstrap job. **Set live**,
website publication and sending activation stay independent administrator actions.

`tests/crm-linking-access.test.mjs` in E2 executes the CRM handler against both
migration histories; CRM profile-client tests verify revision/error behavior and
read-only capabilities. See both project records for actual release and browser
verification evidence. These changes do not assign retained websites, release
services or activate messaging.


The October 2 release is applied and verified (see both project records). The
additional CRM migration `20261002031422_read_only_conversation_lookup.sql`
requires the CRM access guards and prevents phone-based GET lookups from creating
conversations for read-only operators. It was separately compared, rehearsed and
applied after the paired authorization release. Existing conversations remain
readable within the permitted business. Full combined suites passed afterward.
The production staff/customer walkthrough confirmed owner linking and hidden
unreleased services without adding or activating any real services.
