# Automation activity

## Conversation controls and activity MCP — October 16, 2026 (local)

Stage 2 adds 13 tools and seven separate grants: AI pause/resume, same-contact
message reassignment, eligible failed handoff alert retry, activity reports,
tags and explicit same-customer attribution. Lead/handoff owner and status edits
already exist and remain the canonical supported fields. The local catalog has
72 tools and 49 permissions. Strict generated input schemas are also enforced
inside private database wrappers. Private schema storage and helpers are denied
to application roles.

Activity changes advance a separate shared activity_revision on form_runs, never
SMS generation. Tag/attribution edits require both counters plus source revisions.
AI controls preserve unread state and run lifecycle; reassignment checks both
thread revisions and cancels stale AI work. Alert retry locks related jobs and
rejects leased, uncertain or submitted work. It can queue a staff alert, so live
verification must not invoke it. Retry receipts and audits remain transactional.

Local isolation/retry/rollback tests and disposable PostgreSQL concurrency checks
pass. Full CRM: 628 passed / 29 existing skips; paired: 63 passed; relevant E2:
27 passed; both checks, frontend build and 65-file Edge bundle passed. CRM migration
20261016191603_crm_mcp_conversation_activity.sql has passed a guarded rollback-only
live rehearsal against 138 reconciled entries but is NOT applied or released yet.
No E2 runtime or contract change is required. No customer records or SMS were
changed for verification. See docs/MCP_ROLLOUT.md and ignored data/activity-*.

## Conversation actions production status — October 16, 2026

The four CRM migrations 20261016180739, 20261016181809, 20261016183011 and
20261016183855 are applied. MCP and the CRM permissions UI are live at commit
7ea1dc8fe1d1e2abc366d6dc9f76bdfb295c937c, with 49 discoverable tools.
conversation_reply grants preview/reply; conversation_mark_read separately grants
selected-message read updates. Neither implies metadata/message-read permission.
The existing all-business admin connection has both grants (revision 7).

Fresh Codex verification used only reads and preview: Opek remains at conversation
revision 1, five messages and one unread reply; preview queued nothing and both
test runs remain stopped with no next send. No messages were marked read or sent.
Read the current revision before any explicitly requested mutation and reuse the
same payload/idempotency key after an uncertain response. A queued reply receipt
is not proof of provider acceptance or delivery. Earlier local-only entries below
describe implementation-time state; the production release is now recorded in
PROJECT_RECORD.md. No E2 migration or runtime release is needed.

## MCP reply takeover and delivery — October 16, 2026 (local only)

crm_reply_to_conversation uses canonical staff reply queuing and pauses AI on the
explicit general/group conversation. It does not start/stop runs, change consent,
enroll contacts or mark inbound messages read. Its database/queue receipt is atomic
with revision and audit; queued does not mean provider-accepted or delivered.
An identical retry returns the original receipt without another job or takeover.
The worker still rechecks dispatch eligibility, including consent changes after
queuing. Preview remains side-effect-free apart from gateway audit/use records.

## MCP reply preview and workflow state — October 16, 2026 (local only)

crm_preview_conversation_reply reads eligibility under conversation_reply without
creating messages, jobs, attempts, runs or retry receipts. It never changes
generation, shared revision, read timestamps, AI pause or consent. aiWillPause
describes the effect of a future successful staff reply, not an effect of preview.
Consent/worker changes invalidate stale thread revisions. Business/sender readiness
is checked afresh. Transactional staff replies remain distinct from campaign consent
and automation sending hours. Private audits omit the proposed reply and phone.

## MCP selected-message read state — October 16, 2026 (local only)

crm_mark_conversation_messages_read changes only selected inbound read_at values
and their shared conversation revision. It never changes generation, AI pause,
consent, run state or queued SMS. New inbound messages after selection stay unread.
Worker changes invalidate stale requests; a busy selected-message row returns a
temporary failure that can be retried with the identical key/payload. The private
audit includes previous/result revisions and changed IDs/count, without bodies.
Migrations 20261016180739 then 20261016181809 remain pending; no live changes here.

## Conversation revisions — October 16, 2026 (local only)

The pending MCP action foundation exposes shared conversation revisions and
records them in private detail-read audits. Message, read-state, contact/group
and conversation changes invalidate snapshots. Automation generation remains a
separate workflow fence: marking read must not invalidate an otherwise eligible
queued send. Reserved reply/mark-read grants and strict contracts do not expose
executable tools yet. No run, consent, delivery or activity state was changed live.
See [CRM MCP](CRM_MCP.md) and the project records for pending migration
20261016180739 and local checks.

## Conversation-read MCP released — October 16, 2026

CRM migration 20261016174527 is applied; MCP and frontend commit eaae604 are live.
The existing all-business admin connection has the separate conversation_read
and conversation_messages_read grants, preserving all other grants. Codex
discovered 46 tools and verified Opek's one conversation, five messages and one
unread message through ten read-only calls. Read state and domain hashes are
unchanged; both test SMS runs remain stopped with no next send. No SMS was sent.
E2 runtime/schema is unchanged. See both project records and CRM_MCP.md for
separate local checks, migration and release receipts. Earlier local-only notes
are historical checkpoints.

## MCP conversation reads — October 16, 2026 (local only)

Conversation metadata and explicitly requested message pages now have separate
MCP grants (`conversation_read` and `conversation_messages_read`). They do not
confer run-activity, enquiry or lead/handoff access. Counts use the selected
business and exact thread, never phone-only attribution across threads. Reads
preserve unread state, consent, AI controls, run state and queues. Provider
acceptance remains distinct from delivery. Pending migration 20261016174527 and
matching service/frontend release are not applied; see [CRM MCP](CRM_MCP.md).

## Lead/handoff MCP release — October 16, 2026

CRM migrations 20261016164055 (reads), 20261016165709 (shared revisions) and
20261016170649 (assignment/status writes) are now applied. CRM frontend and MCP
commit 0fe6b40 are live; the existing all-business admin connection has the six
independent lead/handoff grants. Codex discovery and ten read-only calls verified
the release. No enquiry record edit or SMS occurred; both test runs remain stopped.
E2 runtime/schema is unchanged. Earlier local-only notes are historical. See both
project records and CRM_MCP.md for separate migration, deployment and test receipts.

## MCP lead/handoff edits (local implementation, October 16, 2026)

Independent assignment/status tools update existing leads or handoffs through the
canonical revision-checked operation. They preserve SMS runs, consent, bookings
and the other resource. Native handoff status events occur once on an actual
transition; identical retries return the transactional receipt. Private MCP audit
adds previous_revision and changed_fields beside the resulting revision, actor,
connection, target, request and outcome. It excludes owner labels and customer
content. This does not authorize alert retries or message sending. See CRM_MCP.md
for the forward-only release order; this increment remains local/unapplied.

Local revision protection (October 16) supersedes the null-revision checkpoint
below: scoped MCP lead/handoff reads now expose canonical record counters and
audit the detail revision. Worker and staff updates advance the same counter;
stale CRM saves return conflicts. No attribution, alert retry, run/AI control or
new MCP mutation is introduced. Both pending CRM migrations remain unapplied.

Local lead/handoff MCP reads (October 16) add scoped list/detail tools under
independent lead_read and handoff_read grants. Explicit enquiry references are
validated at both ends; phone matches never create links. Existing statuses and
owner labels are read without changing attribution, SMS/AI state or alerts.
Revision is null until the future shared write-protection step. Four assignment
and status grants are reserved with no callable writes. CRM migration
20261016164055 remains unapplied. See [CRM MCP](CRM_MCP.md).

## Enquiry MCP released — October 16, 2026

Both enquiry migrations (20261016061921, 20261016063330) are applied and CRM
MCP/frontend commit 3c85353 is live. Codex discovers all 36 tools, including
crm_list_enquiries and crm_get_enquiry under enquiry_read, and
crm_get_enquiry_status under the separate enquiry_status_read permission.
The existing admin connection has both reads; other connections receive no grants
automatically. Opek's two existing submissions were verified: no consent means
CONSENT_REQUIRED/no run; the consented submission's version 1 run is stopped with
no next send. Both submissions have zero recorded booking/handoff links. SMS state
and linked outcomes remain distinct. Both test runs remain stopped; collection
and future-consented follow-ups remain enabled. No SMS or domain changes were
made during release verification. E2 schema/runtime is unchanged. See
PROJECT_RECORD.md for exact migration/deploy IDs and separate local/live checks.
The local-only enquiry notes below describe earlier implementation checkpoints.

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
