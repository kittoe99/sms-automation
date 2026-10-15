# Direct contact automations

Release update (October 14): the full SMS MCP milestone is deployed and its 26-tool
catalog verified through Codex. Independent grants are available in AI connections.
No live run or message was created for verification. See [CRM MCP](CRM_MCP.md)
for applied migration aliases and release IDs; local-only notes below are historical.

Local MCP step 5 adds scoped run inspection/activity (`automation_activity`),
pause/stop (`automation_run_pause_stop`) and resume (`automation_run_resume`).
Every control requires explicit business/run IDs, current generation and a retry
key. Resume also requires current contactRevision and rechecks consent/STOP,
enquiry blocks, business sending, direct runtime and unresolved sends. It retains
the original version, message position and overlaps; finished runs require new
enrollment. Activity distinguishes provider acceptance from delivery and omits
bodies/customer context. Provider-submitted SMS may still arrive after pause or
stop. All SMS increments remain unapplied and unreleased. See [CRM MCP](CRM_MCP.md).

Local MCP steps 1–2 expose discovery (`automation_read`), unpublished template
creation and draft editing (`automation_draft`), and simulation
(`automation_preview`). Draft writes require retry keys and edits require current
revisions. Preview supports draft, published or unsaved rules, explicit local
time, and either sample data or a scoped contact with its current revision.
Optional request context renders `{{request}}`; validation now accepts this
existing runtime token. Simulations return at most 50 sends and observe consent,
STOP, enquiry blocks and reply policies without creating contacts or runs.
Step 3 adds `crm_publish_sms_automation` under the independent automation_publish
grant. It publishes only the saved draft using its current revision and a retry
key; no edit payload is accepted. Existing runs retain their snapshots and
publication never starts a run. Steps 4–5 add separate start/resume/pause-stop tools.
These increments leave existing grants and production unchanged. See
[CRM MCP](CRM_MCP.md).

Local MCP step 4 adds `crm_get_sms_run_start_context` (automation_read) and
`crm_start_sms_automation_run` (automation_run_start). Starts pin a published
template and existing contact using current revisions, complete overlap
ID/generation references, explicit keep/stop_selected choice and a retry key.
Optional context and timezone-qualified startAt are supported; unsaved sequence
overrides are not. Consent/STOP, enquiry blocks, business sending and direct
runtime checks apply. stop_selected additionally requires automation_run_pause_stop
and only stops selected scoped overlaps, atomically with the new enrollment.
The response distinguishes scheduling from delivery. Both tools remain local and
unreleased; existing runs retain their immutable snapshots.

Open **SMS → Automations → Contact messages** for reusable templates. On a contact,
use **Manage follow-ups** for that person’s runs. Existing enrollment and consent
rules are unchanged.

Contacts → Manage automations shows current form and direct sequences. Manage
 direct templates opens the reusable library and Add SMS contact. Saving a contact
never grants consent. Staff can record existing consent with evidence, or use the
existing suppression workflow. STOP remains authoritative.

Publish a template, select it for a contact, customize the messages/timing and
request context, then preview and start. Local times use the selected business
 timezone. The preview shows at most 50 sends; delivery holds may defer them.
Existing runs keep their published version and override snapshot. Archiving a
 template prevents new enrollment and preserves existing runs.

When runs overlap, staff must explicitly keep them or stop selected runs. Pause
requires staff resume. Stop permanently ends that run. Stop all enquiry follow-ups
stops active/paused form and direct enquiry sequences and blocks future enrollment
for this business/contact. Allow future follow-ups does not restart anything.
Appointment reminders, AI pause and consent are independent.

Direct sequences support Pause/Continue/Stop on any inbound reply (default Pause).
Continue waits through the 30-minute quiet window after inbound or accepted AI
SMS, even when AI is off/shadow. Existing form quiet-window rollout is unchanged.
AI booking/decline/handoff actions still require scoped references and live
eligibility. Shadow actions never close or pause a sequence. An ambiguous reply
may stop multiple configured direct runs without attributing a response to each.
Explicit staff linking of a confirmed booking stops the linked direct run;
attribution corrections never resume previously stopped runs.

Automation activity includes origin/template filters, tags and timelines. The
form enquiry funnel retains its definition; direct automation conversions use a
separate first-accepted-message cohort. Booking attribution is primary and
explicit; phone alone never proves conversion. Test, appointment and shadow
activity remains separate.

## Interfaces and storage

`GET /contact-automations/{templates,read}` uses existing SMS-read permissions.
`POST /contact-automations/preview` performs no mutation. Staff-only POST actions
`save`, `publish`, `archive`, `enroll`, `run`, `block`, `edit` require
`Idempotency-Key`. Revisions/generations reject stale changes with HTTP 409.
Authorization derives actor/business from verified CRM context. Enrollment
compares the current overlap snapshot, template revision and contact revision.

Private `direct_templates`, `direct_versions`, `direct_operations` and
`contact_sources` support immutable snapshots, retry recovery and source history.
`form_runs.origin=direct` preserves worker/outbox run IDs while having no form or
submission. Existing sender and worker functions consume the extended contract;
no process stays alive between messages. Scheduler and final submission recheck
contact blocking, generation, consent, STOP and the direct runtime switch.

Browser/API phone normalization share `public/phoneNormalization.js`; SQL uses
an equivalent strict normalizer. Unqualified 10-digit numbers mean US/Canada;
international numbers require + or 00. Incomplete writes preserve contact
identity, nonempty name/email and metadata. Explicit revision-checked staff edits
can clear display fields. Names in legacy thread summaries are synchronized.
Source backfill records the current known source as a migration-time snapshot,
not an invented historical transition. Phone identity cannot be edited in place.

## Validation and rollout

Use `test/directAutomations*.test.js` and `scripts/test-direct-concurrency.js`
(disposable real PostgreSQL only), the CRM agent/form/conversation/activity/API
suites and paired E2 enquiry/booking/service-access/cache suites. The E2 combined
migration harness includes CRM migrations; never replay either remote history.

CRM owns `20261010210847_direct_contact_automations.sql`; prerequisite remote
Automation activity is `20261010191143`. See both project records for the actual
remote mapping and deployment state. No existing contact is automatically enrolled.
Opek AI stays shadow; all other businesses stay off.

Rollback direct enrollments/sends by setting
`sms_private.runtime.direct_automations_enabled=false`. Keep the migration,
contact blocks, stopped/paused runs, confirmed bookings and audit records. The
switch does not suppress appointment reminders or staff messages. Already
submitted provider messages require existing reconciliation.

Applied mapping: source `20261010210847` → remote `20261010212516`. CRM API 55
is active; see the project records for verified frontend release status.

Frontend verified LIVE: commit `03b9754`, Render `dep-db5aroijnfac739r7rpg`,
2026-10-10 21:28:14 UTC. Served source modules and app bundle match the tested
release. No direct templates/runs were created in production; Opek AI remains
shadow and all other businesses off.

October 14: form and contact Continue enquiry messages share the 30-minute wait
after customer/accepted AI replies in every AI mode. AI behavior is configured
once under SMS → AI replies. See [unified SMS behavior](INBOUND_AI.md#october-14-unified-sms-behavior).
