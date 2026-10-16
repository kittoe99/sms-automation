# Form-first SMS automation

Local MCP lead/handoff reads (October 16) inspect existing operational records
through independent lead_read and handoff_read permissions. They do not create a
lead or handoff from a submission, invent a submission sales stage, grant consent
or start follow-ups. Only validated explicit run associations appear; submission
answers remain controlled by enquiry_read. Migration 20261016164055 is local and
unapplied. See [CRM MCP](CRM_MCP.md) for schemas and permission boundaries.

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

Enquiry MCP step 2 (October 16, local only) activates the separate
enquiry_status_read capability through crm_get_enquiry_status. Exact submission
identity scopes intake and SMS state plus recorded response/booking/handoff counts.
Those facts remain independent: stopped SMS is not a declined enquiry, and an
appointment request is not a confirmed booking. Only active SMS exposes a next
send time. Status reads expose no answers or message bodies and never enroll/send.
Both enquiry migrations remain unapplied. See [CRM MCP](CRM_MCP.md).

Enquiry MCP step 1 (October 16, local only) adds separately granted
`crm_list_enquiries` and `crm_get_enquiry`. They expose scoped saved submission
summaries and historical answers through `enquiry_read`, including retained
inactive/archived form history. Recorded consent and requested appointment time
are facts, not sending eligibility or confirmed bookings. `enquiry_status_read`
is reserved for the next increment. Existing SMS submission-reference tools keep
their permissions and output. Reads do not enroll, send or alter domain data.
See [CRM MCP](CRM_MCP.md) for schemas, bounds and release prerequisites.

## Forms MCP production release — October 15, 2026, 11:19 PM Denver

The forms milestone is deployed. This release record supersedes the historical
local/unapplied checkpoints below. Implementation is committed in the CRM release
worktree C:/Users/kofik/.codex/worktrees/crm-mcp/opek-sms; unrelated dirty main CRM
work remains untouched. No E2 schema or runtime deployment was required.

**Applied migrations:** reconciled 121 live records with both repositories and
the previous alias inventory. Two remote-only historical entries were already
present in the prior release snapshot. An isolated exact-version CLI catalog
used already-applied history markers and only the five new source files. Dry run
listed exactly five; two rollback rehearsals (before and after the apply correction)
verified the prerequisite guards. No history repair, replay, role/seed/Vault
change or unrelated AI-default migration was applied. Production now has 126
migration records. Source and applied versions are identical for this release:

| Version | Migration |
| --- | --- |
| 20261016040535 | crm_mcp_form_reads |
| 20261016041950 | crm_mcp_form_drafts |
| 20261016043205 | crm_mcp_form_preview |
| 20261016044442 | crm_mcp_form_apply |
| 20261016045607 | crm_mcp_form_collection |

All 19 inspected live function hashes match the tested paired definitions.
Private helpers/table access remains denied to API/MCP roles. Security advisors:
69 informational findings, 5 pre-existing warnings, 0 errors. The one new INFO
is RLS enabled with no policies on the deliberately private mcp_form_drafts table;
no new warning or error was introduced. The Supabase connector required renewal,
so the already-authenticated CLI applied the migrations to wxamwhfmelxqahkdtcci.

**Releases:** commit 95e432ac1da97d1e5c2e76ea4336bccf8f2634ee is live on
[MCP deploy dep-db8r69ks728c73aph4eg](https://dashboard.render.com/web/srv-db84ogivcj2c73874e20/deploys/dep-db8r69ks728c73aph4eg)
and [CRM frontend deploy dep-db8r770n74is73chjfbg](https://dashboard.render.com/static/srv-dandjcp42hec73e569pg/deploys/dep-db8r770n74is73chjfbg)
in the previously confirmed Micah workspace. The frontend produced no automatic
deploy/event after the branch push; one explicit deployment of the verified commit
completed. Both the served permission module and bundled grant labels were verified.
Health/discovery return 200; unauthenticated MCP returns the expected 401 challenge.
No MCP application error logs appeared after rollout. CRM API source is unchanged,
so its existing grant administration routes needed no redundant Edge deployment.

**Access and Codex verification:** on explicit user authorization, canonical admin
save added all six form grants to existing all-business connection
dd79bf79-c164-4493-a099-35654f7f7c12. Revision is 3, with 21 total permissions;
existing scope/grants were preserved, and the grant change is audited. New
connections still start pending without grants. Two fresh Codex app-server OAuth
sessions verified discovery/reconnection, all 33 tools, strict schemas, read/write
annotations and mutation retry/revision requirements. Ten read-only calls covered
access, scoped/empty form lists, missing-form and missing-business denials; all ten
have correct actor/connection/request attribution. No form mutation tool ran.

Live has zero forms and zero saved drafts, so successful detail/preview and mutation
paths were not exercised against production or seeded just for verification. They
remain covered by local tests. No expiry-driven token-refresh scenario was forced.
Before/after hashes of business, forms, follow-ups, runs and email enrollments match.
Counts remain 1 SMS run, 4 messages (2 outbound), and 2 SMS-send jobs. No collection
activation, enrollment, follow-up enablement or SMS send occurred during this release.

**Local verification:** corrected apply writes only validated definition columns
to avoid an unchanged enabled flag firing email lifecycle cancellation. Regression
fixtures preserve active/paused email on inactive, active and no-email forms.
Full CRM: 516 passed / 29 existing skips / 0 failed; focused apply/collection: 23;
paired contracts: 63; relevant E2 tests: 28; PostgreSQL concurrency scenarios: 17.
Both projects' required checks, frontend build and 65-file Edge packaging passed.
Release verification artifacts are in the worktree's ignored data/forms-* files;
credentials and customer message content are not included in these records.

## Forms release preflight — October 15 (before application)

The five CRM forms migrations were reconciled against 121 live migration records,
including source/remote aliases and two unchanged remote-only historical entries.
The exact-version CLI dry run lists only 20261016040535, 20261016041950,
20261016043205, 20261016044442 and 20261016045607. No history repair or replay is
needed. The unrelated main-checkout AI-default migration is excluded. Both Render
services still run 0e0728c, so deploying the existing release worktree preserves
the production baseline and leaves newer unrelated local work untouched.

Preflight corrected the still-unapplied apply migration: it now writes only
validated definition columns. The full canonical saver also writes enabled even
when unchanged, which fires the email lifecycle trigger. Pure draft validation
retains canonical field rules/normalization while avoiding that unintended effect.
Regression fixtures cover active and paused email across inactive, active and
no-email forms. Historical step-4 notes below describe the original local approach;
this correction is the release implementation. Collection control still invokes
its intended pause/cancel safeguards. No public/shared saver or E2 contract changed.

Corrected local verification: 516 CRM passes / 29 skips, 63 paired passes,
23 focused apply/collection passes, 17 PostgreSQL concurrency scenarios, CRM
checks, frontend build and Edge packaging. Production rehearsal rolled back and
matched all 19 expected functions, including the existing E2-owned staff guard.
The user authorized all six form grants for the existing all-business admin
connection. Actual migrations, grant activation, deployments and Codex verification
will be recorded separately after success. No live form or messaging mutation ran.

Forms MCP step 5 (October 15, local only) adds `crm_set_form_collection_enabled`
under independent `form_activate`. Explicit business/form IDs, current form and
draft revisions (0 if absent), a boolean enabled state and retry key are required.
Activation uses applied content and rejects enabled SMS follow-ups or active form
SMS runs; it never applies drafts, enables follow-ups, resumes runs or sends.
Deactivation pauses active form SMS runs and cancels active/paused form email
enrollments using the existing generation safeguards. Follow-up flags remain
unchanged. Known in-flight SMS are reported because they may still deliver.
Fresh draft metadata advances on state changes; stale drafts remain stale.
Effect audits include affected generations, and retries/rollback cover all effects.
All five forms migrations remain unapplied; no production forms or SMS changed.
See [CRM MCP](CRM_MCP.md#forms-milestone-step-5--collection-activation-and-deactivation-october-15-local-only).

Historical forms MCP step 4 (October 15, local only) adds `crm_apply_form_draft` under
`form_publish`. It applies the saved definition with both current revisions and
a retry key, preserving collection/consent state and all SMS/email activity.
Current SMS field references must remain valid; historical answers and run snapshots
stay intact. Stale bases conflict and are not rebased. The applied draft is retained
with advanced revision/base metadata for further editing. Collection activation
remains a later, separately granted step. See [CRM MCP](CRM_MCP.md#forms-milestone-step-4--explicitly-apply-saved-drafts-october-15-local-only).


Historical forms MCP step 3 (October 15, local only) adds `crm_preview_form` under the
independent `form_preview` grant. It previews a saved draft using explicit business,
form and current applied/draft revisions. Structured fields and inert embedded
HTML show fixed/custom fields and unchecked canonical consent choices. No sample
submission, contact lookup, collection change, automation simulation or SMS occurs.
Outdated draft bases/archives are labeled; mismatched revisions conflict. Apply
and activation remain future steps. See [CRM MCP](CRM_MCP.md#forms-milestone-step-3--saved-draft-previews-october-15-local-only).


Historical forms MCP step 2 (October 15, local only) adds `crm_create_form` under
`form_create` and `crm_save_form_draft` under `form_edit`. Creation produces an
inactive canonical form and a separate private draft. Draft edits never change
the applied form, public collection, consent, SMS/email state or E2 snapshots.
Both require retry keys; edits require applied and draft revisions. A draft based
on an older applied version conflicts and awaits explicit reconciliation in a
later step. Preview, apply and activation remain unimplemented. The CRM editor
continues to edit applied forms directly. Details and forward migration order:
[CRM MCP](CRM_MCP.md#forms-milestone-step-2--inactive-creation-and-separate-drafts-october-15-local-only).

Historical forms MCP step 1 (October 15, local only) adds `crm_list_forms` and `crm_get_form`
under the new independent `form_read` grant. They expose scoped applied form
definitions, field order, collection state and current revisions. They do not
read submissions, change forms, simulate submissions, or affect SMS. Separate
form drafts and create/edit/preview/apply/activate tools remain future increments;
five reserved grants are visible but provide no tools yet. Existing connection
grants are unchanged. See [CRM MCP](CRM_MCP.md#forms-milestone-step-1--local-scoped-reads-october-15)
for input bounds, isolation and the new unapplied forward migration.

Release update (October 14): all five SMS MCP increments are deployed, with
independent grants available in AI connections. Codex verification used reads
only and sent no SMS. Applied aliases and releases are in [CRM MCP](CRM_MCP.md);
the local-only notes below describe the earlier implementation checkpoints.

Local MCP step 5 adds run inspection/activity (`automation_activity`), pause/stop
(`automation_run_pause_stop`) and resume (`automation_run_resume`). Controls use
explicit business/run IDs, current generation and transactional retry keys;
resume also checks current contactRevision, consent/STOP, business sending,
form/follow-up state, appointment time and unresolved provider sends. Terminal
runs cannot resume. Existing published snapshots and other runs stay intact.
Activity pages expose state/delivery facts without submission answers or bodies.
Pausing/stopping cannot recall already submitted SMS. All five SMS migrations
remain local, unapplied and unreleased. See [CRM MCP](CRM_MCP.md).

Local MCP steps 1–2 add scoped reads (`automation_read`), first-draft creation and
replacement (`automation_draft`), and simulation (`automation_preview`). Drafts
require current sequence/form revisions and retry keys. Preview accepts saved
drafts, published rules or unsaved rules with explicit business-local time and
sample answers. The shared simulation observes Continue's 30-minute wait and
existing enquiry blocks. It creates no leads, contacts, runs or sends. Public
form creation remains in the CRM workflow; publication and enabling are separate.
Step 3 now adds saved-draft publication (`automation_publish`) and form follow-up
state changes (`automation_enable`), both with sequence/form revisions and retry
keys. Publication preserves enabled state: an enabled form uses the new version
for future submissions, while existing runs retain their version. Enabling
requires published rules and a collecting form; it does not enroll history or
resume paused runs. Disabling pauses active runs for that form. These increments
are not released. See [CRM MCP](CRM_MCP.md).

Local MCP step 4 adds historical submission enrollment under
`automation_run_start`. Read fresh run-start context, then provide sequence/form
and contact revisions, the submission fingerprint and explicit overlap choice.
Recorded consent, STOP, enquiry blocks, enabled form/follow-ups, business sending
and appointment cutoffs are checked. Already-enrolled submissions return their
existing run without resuming/restarting it. Replacing selected overlaps also
requires `automation_run_pause_stop`; stops and enrollment commit together.
The CRM enrollment wrapper now takes the phone lock before the form lock, matching
public submissions/MCP. This increment is local only and sends no messages during
verification; production scheduling/sending remains with the existing workers.

Forms own SMS follow-ups. Fixed SMS groups and legacy AI-written replies are retired.
The legacy groups, messages, intake records and AI settings remain available as
historical data and for the separate email integration; they cannot dispatch SMS.

The new [Inbound AI agent](INBOUND_AI.md) is a separate, default-off Opek pilot.
It handles eligible inbound questions and new bookings. It never restarts a
paused form reminder or legacy sequence; Pause/Continue still belongs to the form.

## Layout and drafts

Create form is expandable. Form details are available on demand; the directory
keeps submissions, follow-up status and main actions visible. **Archive form**
retains history and supports Restore as draft. Switching inner tabs retains
unsaved editor panels; explicit Refresh asks before discarding retained drafts.
Save important work before reloading, signing out or changing businesses.

The follow-up editor shows Messages, Timing, optional repeats and Preview & test.
Save draft, Publish changes and Turn on follow-ups remain separate operations.
No sending, enrollment or publication rules changed with this layout.

## Workflow

1. Open **Forms**, create a named contact, quote or appointment form, and edit its fields.
2. Save and enable the form when it is ready to collect submissions. Existing embeds
   retain their public IDs; multiple forms may share the same field starter.
3. Open **Follow-ups** (also available through **SMS → Automations → Form messages**). Copy a preset or add messages, choose a trigger and reply policy,
   and configure each message's delay, total sends and repeat interval.
4. Review the message previews and sequence summary. Save a draft, publish a version,
   then **Turn on follow-ups** for future submissions. **Preview & test** is expandable;
   a test does not switch Text replies into Automatic replies mode.
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

## Deactivate, delete and restore a form

Local October 10 frontend changes, not yet released: open **Forms → Open form**
(or open its Automation tab). Editors now have **Deactivate form** for a live form
and **Delete form** in the workspace header. Both show an inline confirmation with
Cancel before changing saved state. Unsaved editor changes are discarded only
when the action succeeds and reloads the form.

- **Deactivate form** disables public collection, pauses active SMS runs and cancels
  active email enrollments using the existing form-save transaction. It preserves
  the saved fields, history and published sequence setting. To reactivate, enable
  the form in Form settings and save; new submissions can enroll if the saved
  sequence is enabled, but previously paused runs require individual resumption.
- **Delete form** performs the existing recoverable archive. It disables collection
  and the sequence, stops active/paused runs, and cancels active email enrollments.
  Submissions, message history, sequence versions and website attribution remain
  stored. Messages already handed to a provider cannot be recalled.
- The default **Current forms** filter excludes deleted forms. Select **Deleted
  forms**, open the form, then **Restore as draft**. Restoration does not enable
  collection, enable the sequence, or restart stopped runs.

History totals still include deleted forms. Inactive forms no longer count as
active automations. Existing form-editor permissions apply; this adds no messaging
or automation-management grant. Requests stay pinned to their original business,
controls prevent duplicate actions, and errors leave the form available to retry.
No migration, Edge API release or E2 runtime change is required; release the CRM
frontend. Existing migration order below remains unchanged.

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
- Legacy group/business SMS AI mutation endpoints return 410 and legacy AI
  outbox requests are rejected. The current AI worker can process the separate
  `sms-agent-v1` inbound agent when its off/shadow/live gates allow it; the
  historical October 3 shutdown below does not disable the newer pilot.

## Historical October 3 migration and release

These forward migrations were released in this order. This is the original
cutover procedure, not an instruction to reapply them or turn off today's
independently configured inbound agent:

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

Test replies use the business's current **Inbound AI** mode. Shadow records a
proposed reply in **Inbound AI > Recent runs** without sending it. Starting a new
test or clearing previous test history does not enable Live mode; the separate
[Inbound AI validation gate](INBOUND_AI.md#forward-release-and-rollback) still applies.

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

Release verified October 10: AI worker 38; remote migration `20261010184313`; CRM `56a83d3`, Render `dep-db58fv5ckfvc739auub0` live at 18:46:31 UTC. Opek coordination is shadow-only; other businesses remain off. Live activation has not occurred. See both PROJECT_RECORD files for validation scope and remaining operational gates.

## Automation activity reporting

The Automation activity tab beside Forms reports accepted/delivered messages,
responses, bookings, pauses and handoffs. Staff can tag individual enquiries and
correct primary booking attribution. These reporting actions do not send messages
or change follow-up templates. Sequence and AI resume remain independent; STOP
cannot be overridden. See [Automation activity](AUTOMATION_ACTIVITY.md).


## Direct contact sequences

Staff can assign versioned enquiry follow-ups without a form. Contact blocks
apply to form and direct enquiry runs; appointment reminders stay separate.
See [Direct contact automations](DIRECT_CONTACT_AUTOMATIONS.md) for controls,
reply policies, attribution, rollout and rollback.


### October 14 production form reset

All five managed form definitions and their form test history were permanently
removed at the user's explicit request. No submissions remained. Existing form
links no longer collect data; create new forms before reconnecting collection or
follow-ups. This one-time database purge does not change normal Archive/Restore
behavior. See `PROJECT_RECORD.md` in each repository for verified scope.

October 14: form and contact Continue enquiry messages share the 30-minute wait
after customer/accepted AI replies in every AI mode. AI behavior is configured
once under SMS → AI replies. See [unified SMS behavior](INBOUND_AI.md#october-14-unified-sms-behavior).
## Optional instant form acknowledgment — October 16, 2026

Submission sequences may opt into `instantAcknowledgment: true` with zero delay
on their first message. That first send is due immediately even outside sending
hours. Repeats of that message and all later steps still use the configured business
window. Appointment and direct-contact sequences cannot enable this option. Omitted
or false preserves existing behavior, and existing published snapshots are unchanged.

This is a scheduling exception, not a consent exception: unchecked submission SMS
consent, contact STOP/consent, overlap, reply/quiet-wait, staff pause, sending readiness,
generation, lease and provider retry protections continue to apply. Normal queue and
provider processing can delay acceptance; immediate does not promise instant delivery.
The editor, saved-draft MCP schema and both preview paths preserve the option.

CRM owns forward migration `20261016055448_form_instant_acknowledgment.sql`.
Requires the five released forms MCP migrations and the current paired E2 baseline;
no E2 contract migration is needed. Never replay migration history. Deployment and
Opek draft configuration status are recorded separately in `PROJECT_RECORD.md`.
