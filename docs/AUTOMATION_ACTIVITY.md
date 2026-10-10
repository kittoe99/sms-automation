# Automation activity

Staff reporting lives at `?view=automation-activity`, beside Forms. SMS readers
can inspect reports; existing CRM management permission is required for tags,
attribution and sequence controls. No customer E2 page or service grant changes.

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
