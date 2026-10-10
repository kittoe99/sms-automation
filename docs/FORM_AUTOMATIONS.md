# Form-first SMS automation

Forms own SMS follow-ups. Fixed SMS groups and AI-written replies are retired.
The legacy groups, messages, intake records and AI settings remain available as
historical data and for the separate email integration; they cannot dispatch SMS.

## Workflow

1. Open **Forms**, create a named contact, quote or appointment form, and edit its fields.
2. Save and enable the form when it is ready to collect submissions. Existing embeds
   retain their public IDs; multiple forms may share the same field starter.
3. Open **Automation**. Copy a preset or add messages, choose a trigger and reply policy,
   and configure each message's delay, total sends and repeat interval.
4. Review the message previews and sequence summary. Save a draft, publish a version,
   then enable that published version for future submissions.
5. Use **Submissions** to inspect answers and pause, resume or stop individual runs.
   Staff can explicitly start the published sequence for an eligible historical
   submission. Publishing alone never replays history.

Each message completes all its repeats before the next begins: A twice, B once,
then C 100 times is 103 total sends. Each message supports 1–1,000 total sends;
sequences support 1–50 messages. Repeat intervals are positive and finite.
Minutes/hours are elapsed time; days/weeks/months follow the business timezone.
Sending windows defer messages to the next eligible local hour. A paused or late
run resumes its next unsent occurrence without catching up in a burst.

The submission trigger starts after submission. Appointment sequences start before
a confirmed appointment and stop at the appointment or cancellation. Rescheduling
preserves accepted-send progress. Repeated submissions for the same form and phone
do not overlap an active/paused run; distinct appointments may have separate runs.

Ordinary replies pause by default; staff may choose Continue per form. STOP and
other provider opt-outs always suppress sending. Incoming texts stay in the inbox
for manual replies. Missing template fields pause a run instead of sending blank
or unresolved text. An uncertain provider submission must be reconciled before
resuming; acceptance advances the cursor exactly once.

Publishing creates an immutable version for future runs. Existing runs keep their
saved version. Presets are copied, so editing a form never edits other forms.
Archiving stops its runs and disables collection; restoring returns the form as a
disabled draft. New forms do not inherit the old category's email automation.

## Permissions and APIs

- CRM staff configure/publish/enable rules, save presets and control runs.
- Existing form editors create/edit/duplicate/archive forms without acquiring SMS
  read or automation-management access. SMS-read accounts can inspect sequences.
- E2 owners retain existing dashboard/service-release access; no new CRM login or
  email-based identity association is added.
- `GET/POST /api/web-forms` list/create forms; `PUT /api/web-forms/:id` saves fields.
- `POST /api/web-forms/:id/{duplicate,archive,restore}` manages form lifecycle.
- `GET /api/web-forms/:id/{automation,submissions}` reads tenant-scoped data.
- `PUT /api/web-forms/:id/automation/{draft,publish,state,preset-save,pause,resume,stop,enroll}`
  performs staff actions. Publish/draft require the observed revision.
- `GET /api/automation-presets` returns business presets; built-in starters ship
  with the editor. Legacy type-based form routes resolve only their original form.
- Legacy SMS AI mutation endpoints return 410. The AI worker makes no model calls,
  AI enqueue is disabled, and the send boundary rejects legacy AI outbox requests.

## Migration and release

Apply only these forward migrations, in this order:

1. CRM `20261003143731_form_first_sms_automation.sql`.
2. E2 `20261003145302_form_sequence_enquiries.sql`.

Prerequisites include E2 canonical access `20261002024330` and the paired SMS
summary migrations `20261003032940` / `20261003032943`. Verify live function
definitions against the paired baseline, pause the SMS/automation/AI dispatch
queues, and wait for in-flight provider calls to finish before applying changes.
Never replay either repository's history over the shared production database.

Deploy `crm-api`, `automation-worker`, `ai-worker` and both frontends. Restore the
previous SMS/automation dispatch settings after worker deployment; keep AI dispatch
off. Preserve business/provider sending settings. Existing active legacy runs are
paused for template review. A rollback should pause form dispatch and preserve the
new schema/data; do not restore an AI worker or reactivate legacy jobs.

Local validation covers 103-send ordering, immutable versions, deduplication,
consent/reply fencing, uncertainty, appointment changes, missing fields, calendar
boundaries, tenant permissions, legacy email compatibility and paired E2 access/cache
behavior. Historical tests that require SMS AI to be enabled are explicitly skipped
and retained for reference; replacement behavior lives in `test/formSequences.test.js`.

Release state: both forward migrations, CRM API v42, automation-worker v26,
ai-worker v31 and both frontends are deployed. Authenticated Forms and owner
dashboard views were verified. CRM application `0f1d6ea` and E2 `3ca64ba` are
the released application revisions; detailed validation and deployment evidence
is recorded in both project records. Existing forms have no automation enabled
until staff configures, publishes and enables a template sequence.

## Customer dashboard visibility

Released SMS businesses also expose their existing form submissions in E2 Local's
single **Leads** tab. Sending activation is independent of lead visibility. Owners
can filter by business or named form and expand answers; no copied submissions,
per-form tabs or automation controls are added to the customer dashboard.
Website attribution still requires website access and preserves ownership-history
cutoffs. Overview and SMS display the existing connected business numbers.

The customer-only reader and migration are E2-owned:
`20261003231755_customer_unified_leads`, after the paired CRM form-first and E2
service/form migrations. CRM submission, staff reads and messaging permissions
stay unchanged. See `../E2local-main/docs/business-services.md` for the release
contract. Apply only the forward migration; do not replay shared histories.

## Preview a submission and its automation

Open a form's **Form** tab and use **Preview & test**, or use **Test submission**
below its **Automation** editor. Fill the sample fields (or use sample answers),
select simulated SMS consent, and choose **Run simulation**. Expand **Test timing
& customer behavior** to choose a submission time or test a reply/STOP after the
first message. Booking forms also require an appointment time.

The Form panel uses unsaved fields with saved draft rules. The Automation panel
uses the current unsaved rules. Results show personalized texts, repeat numbers,
and estimated dates in the business timezone. Up to 200 occurrences are shown;
the full configured send count remains visible. Changed inputs/rules invalidate
the old result. Actual provider processing and late execution can shift times.

Simulation works for draft/disabled forms and explains live readiness separately.
It respects sample consent, existing opt-outs, missing fields and appointment
cutoffs, but never creates a real contact, lead, message, run or job. Publishing,
enabling and real customer submission remain separate actions. SMS-read accounts
can run simulations; forms-only editors cannot read automation rules.

API: POST /api/web-forms/:id/preview. Deploy only the CRM forward migration
20261004021248_form_automation_preview after paired form/access prerequisites,
then crm-api and the CRM frontend. There is no E2 migration for simulation.

## Send the actual test sequence

In **Form > Preview & test** or **Automation > Test submission**, enter your real
mobile number and sample answers, select SMS consent, and choose **Prepare real
SMS test**. Review the recipient, number of sends and first scheduled time, confirm
that you control the phone, then choose **Start real SMS test**. Standard Twilio
charges apply. Sample 555-01xx numbers cannot be used for real sending.

The full configured sequence runs on its actual schedule, including delays,
business sending hours, repeats, appointment cutoffs and reply/STOP behavior.
Simulation dates and simulated replies are ignored. A future first-send time means
no SMS is expected immediately. Unsaved Automation editor rules are copied into
an isolated run; the Form panel uses the saved draft. Publishing is not required.
Business SMS sending must already be enabled with a connected provider.

**Real SMS tests** shows scheduled time, provider acceptance, delivery and recent
message statuses, refreshing automatically while pending. **Stop test** prevents
future sends; an SMS already submitted to Twilio may still arrive. Replies can
pause tests and STOP ends them. Stop a paused test before starting a new one for
that form/phone. Uncertain provider submissions require reconciliation first.
Tests create consent/contact/message history, but no saved customer submission or
E2 Lead. Existing opt-out/consent restrictions are preserved.

GET/POST /api/web-forms/:id/test-runs read/start tests;
POST /api/web-forms/:id/test-runs/:runId/stop stops a test. Starting/stopping is
staff-only; reading uses existing SMS-read permission. Responses exclude secrets,
Twilio identifiers and raw errors. Start request IDs make transport retries safe.

Apply only CRM 20261004033035_form_live_test_runs after CRM 20261004021248,
CRM 20261003143731, E2 canonical access 20261002024330 and the current paired
20261003231755 Leads baseline. Deploy crm-api and the CRM frontend. Existing
workers call the updated shared functions; no worker code or E2 release is needed.
Never replay either history. No dispatch, provider or business activation setting
is changed by this migration.

## Enquiry coordination (October 10)

The inbound agent loads saved form-run context and accepted-message attribution.
Multiple possible enquiries require clarification; it never chooses the newest
submission alone. Only an explicit associated enquiry is closed after booking or
decline; appointment cancellation/rescheduling goes to staff. Decline evidence
must appear in the latest inbound text. Bare no, scheduling corrections and
ambiguous multi-form declines cannot close a run.

With live AI and coordination enabled, Continue submission follow-ups wait until
30 minutes after the latest inbound or accepted AI reply. Pending AI work also
holds them. Both generation and final send checks enforce the window; waiting
reuses the queue item without consuming attempts or advancing the sequence.
Sending-hour rules still apply. There is no catch-up burst or automatic restart
of paused runs. Appointment-triggered reminders keep their existing policies.

The Inbound AI view reports enquiry association, outcome/reason and quiet-until
(or proposed quiet-until in shadow). Shadow does not apply the new mutations;
ordinary webhook consent and Pause-on-reply policies still run as before.

Rollout: reconcile CRM/E2 histories, apply only the new CRM coordination migration,
deploy the updated AI worker and frontend, then enable coordination for Opek in
shadow. The operator-owned `inbound_ai_settings.coordination_enabled` switch
controls this rollout; update `revision` when changing it to fence in-flight runs.
Other businesses remain off. Turning AI mode off (with a revision increment)
disables new AI runs/pending AI sends and coordination; confirmed bookings,
stopped/paused runs and audit records remain. Disabling only coordination returns
Continue runs to their original schedules, so it is not a sending kill switch.
Staff never need a new OpenAI credential for this release. Keep the existing
server secret and live-validation gate. No E2 application release is required.

Verification commands: `node --test test/inboundCoordination.test.js`,
`node scripts/test-coordination-concurrency.js`, and
`node scripts/evaluate-coordination.js` (operator-injected API key or expiring
validation proxy; synthetic local data only). Also run the existing CRM agent,
form, booking and conversation suites and paired E2 enquiry/booking/access/cache
suites. Read both project records for actual deployment and activation state.
