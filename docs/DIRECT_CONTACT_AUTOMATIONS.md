# Direct contact automations

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
