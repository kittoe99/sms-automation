# Automation activity

Enquiry MCP step 2 (October 16, local only) adds crm_get_enquiry_status under
enquiry_status_read. It returns separate SMS state and recorded response, booking
and handoff counts for an explicit business/form/submission. Counts use existing
canonical attribution, including current booking cancellation and handoff status;
unlinked data, test/direct runs and simulated event proposals do not contribute.
Zero linked outcomes is not a claim that none exist. Status-only permission grants
neither answers nor automation_activity timeline access; message bodies are excluded. No
attribution edit, enrollment, scheduling, consent change or message send occurs.
The CRM migration 20261016063330_crm_mcp_enquiry_status.sql is local/unapplied,
following the enquiry-read migration. See [CRM MCP](CRM_MCP.md) for the contract.

Release update (October 14): the SMS MCP milestone is now deployed and verified
through Codex using reads only. All five migrations are applied under the remote
aliases in [CRM MCP](CRM_MCP.md). The implementation notes below are historical.

The pending local MCP step 5 exposes `crm_list_sms_runs`, `crm_get_sms_run` and
`crm_get_sms_run_activity` under the independent automation_activity grant.
Reads require an explicit business, scope related IDs/counts, cap pages at 100
and project event/state facts without message bodies or raw details. The event
timeline marks historical/simulated evidence; lifetime provider-accepted and
delivered counts remain distinct. Unlinked activity, cohort reports, tags and
attribution editing remain in the CRM UI. Separate resume and pause/stop grants
control runs with generation/retry checks and fresh consent checks on resume.
No migration, grants or release were applied. See [CRM MCP](CRM_MCP.md).

Staff reporting lives at `?view=automation-activity`, beside Forms. SMS readers
can inspect reports; existing CRM management permission is required for tags,
attribution and sequence controls. No customer E2 page or service grant changes.

## Simplified workspace (October 12, local)

The CRM page has one heading and Refresh control. Four summary cards show delivered
messages and customer replies within the selected dates, plus current active
follow-ups and open handoffs. Search and dates stay visible; **More filters** contains
form/template, status, response, booking, handoff, activity type and tags, with an
active-filter count. Apply submits filters; Reset restores defaults. Quick filters
remain directly accessible.

The enquiry list follows immediately. Customer tags appear beneath the customer,
and booking/handoff results share an Outcome column. Select a customer for the
existing timeline and actions. **Detailed metrics** expands the full message counts,
form/direct conversion metrics, definitions and workload breakdown below the list.
Disclosure state survives background updates; unapplied filter changes defer them.
No reporting definitions, permissions or API contracts changed. This redesign is
locally built and browser-checked; it has not been deployed.

## Reading the report

The default interval is the last 30 calendar days in the business timezone.
The end date is inclusive; SQL converts both local midnight boundaries with the
saved timezone, including 23/25-hour DST days. Reports return one `reportingAt`,
definitions and the timezone. Message activity counts actual events in those
dates. Provider acceptance and delivery are separate facts.

The funnel cohort contains distinct submission-triggered runs whose **first**
accepted automation message falls inside that interval. Response and conversion
outcomes include subsequent records through reporting time. Each enquiry counts
once. Conversion requires a currently confirmed booking with a primary enquiry
link; cancellation removes that conversion and remains separately visible.
An empty denominator displays a dash. Appointment reminders, tests and shadow
proposals never enter enquiry funnel totals.

Workload is current, independent of the date cohort. Other enquiry filters apply;
unlinked paused conversations and unresolved handoffs are included in an
unfiltered business workload. Tags match any selected tag; filter categories
combine. Unlinked activity supports date and customer search; it has no inferred
form, sequence or tag assignment. Shadow proposals have their own activity type.

Filters persist in session storage under the signed-in user and business. Result
data is not cached. Navigation aborts reads; late results cannot repaint another
business/user. Visible reports refresh every 30 seconds, with refresh deferred
while an input is focused so an in-progress edit is retained. Manual refresh is
always available.

## Attribution and actions

Private `activity_responses` records explicit or unambiguous accepted-message
context. Competing requests remain unlinked. A validated non-simulated agent
outcome can establish its response reference. Staff can resolve unlinked replies
and individual AI activity; this reporting association does not change AI drafts
or follow-up state.

`activity_bookings` permits one primary run per business/booking. Automatic links
require a successful agent commit carrying the validated enquiry reference.
Staff select an existing same-business, same-customer booking and supply its
current attribution revision. Corrections audit both the former and new enquiry.
Linking preserves the booking's recorded source/creator; absent creator details
display Unknown. Phone matching alone never creates a conversion.

Tags are business-scoped and have optimistic revisions for rename/archive.
They have no automation effect. Individual pause/resume calls the existing form
workspace guard under the coordination phone lock, checks generation and refuses
STOP-suppressed resume. AI pause/resume uses the existing separate conversation
API. Neither operation resumes the other channel or alters STOP.

## Storage and API

CRM migration `20261010185337_automation_activity.sql` requires the CRM inbound
coordination migration (remote `20261010184313`) and paired E2 access/cache
baseline. Only apply this new forward migration; never replay either history.

Private, RLS-enabled storage: `activity_events`, `activity_responses`,
`activity_bookings`, `activity_handoffs`, `activity_tags`, `activity_run_tags`.
No browser role or worker has direct table/report-helper access. The server-only
`automation_activity(verified_user, selected_business, action, input)` function
enforces SMS-read permission and management permission for mutations.

GET `/automation-activity/{report,summary,enquiries,timeline,unlinked}`;
POST `/automation-activity/{tag,tag_assignment,booking_link,response_link,activity_link,sequence}`.
The combined report returns totals and paginated enquiries from a common query.
Timeline requires a scoped run ID. Report inputs cannot override verified actor
or tenant. Reports never call the LLM.

Lifecycle triggers commit with their source records. Message IDs, action keys,
job IDs, run generations and attribution revisions deduplicate source events.
Duplicate callbacks and committed booking retries do not add results. Historical
backfill uses explicit recorded facts only: an undated delivery/status snapshot
is labeled historical and excluded from dated delivery counts. Historical replies
without explicit references stay unlinked; no transitions or conversions are
inferred from phone alone.

## Validation and rollout

`test/automationActivity*.test.js` covers metrics, first-contact cohorts, DST,
duplicates, cancellations, ambiguity, correction revisions, tags, historical
snapshots, STOP, shadow/test/reminder isolation, API identity and cross-scope
denial. `scripts/test-activity-concurrency.js` uses disposable real PostgreSQL to
check concurrent attribution, duplicate callbacks and STOP races. Run the CRM
agent/coordination/form/API suites and paired E2 enquiry, booking, service and
cache suites against the combined migration baseline.

Deployment status belongs in both PROJECT_RECORD files. This feature does not
activate live AI. Opek stays shadow; other businesses remain off. Rollback restores
the previous API/frontend, disables new AI runs/pending AI sends with the existing
off switch, and leaves reporting history, confirmed bookings and intentionally
paused/stopped enquiries intact. Never roll back by deleting these records.

Applied mapping: source `20261010185337_automation_activity.sql` is remote
`20261010191143_automation_activity`; do not replay either timestamp. API 54
serves these routes. The private-table no-policy INFO notices are intentional;
see [Supabase RLS advisory](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy).


## Reporting cost — local hardening

The pending CRM `20261014061007_queue_reporting_hardening.sql` migration adds a
private, transactionally maintained first-contact projection and its date index.
It backfills the first provider acceptance from existing message records once.
Reports select a narrow set of filter keys, calculate conversion details only
for the selected date cohort, and hydrate display details only for the requested
page. Unlinked candidate lists are also built after pagination. Current workload
counts remain across all dates; expensive quiet checks run only for active
enquiries, using indexed latest-message and pending-job probes.

The result fields, business-local dates, explicit attribution and permission
checks stay compatible. A regression with 80 historical completed runs and a
one-row current page verifies that quiet calculation does not run over all
historical rows. Real Postgres query plans and capacity still require a staging
measurement; PGlite verifies behavior rather than production throughput. See
[current SQL workflow](../supabase/sql/current/README.md).

## Direct contact sequence controls

Staff can assign versioned enquiry follow-ups without a form. Contact blocks
apply to form and direct enquiry runs; appointment reminders stay separate.
See [Direct contact automations](DIRECT_CONTACT_AUTOMATIONS.md) for controls,
reply policies, attribution, rollout and rollback.
