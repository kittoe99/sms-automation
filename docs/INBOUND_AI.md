# Inbound SMS agent

Open **SMS → AI replies** and use **AI replies on**. Off sends no AI replies;
on responds to future eligible incoming messages using reviewed Business Info.
Pricing is optional: unsupported prices use the saved quote phone or website.
No mandatory shadow/pilot phase remains. The separate booking switch still
requires configured shared availability before the agent can offer appointments.

Turning on requires an active business, reviewed business information and a ready
SMS connection with sending already enabled. Consent/STOP, conversation pauses,
staff takeover, scoped tools and revision fences remain enforced. The control
does not backfill old messages or enable form follow-ups. Legacy shadow values
and liveValidated fields remain readable as historical evidence; they are not
activation prerequisites. See [Business Info](BUSINESS_PROFILE_FORM.md).

## MCP diagnostics (local implementation)

Scoped run list/detail reads are documented in
[AI reply diagnostics](AI_REPLY_DIAGNOSTICS.md). Diagnostics and message content
have separate grants; reads do not mark messages read or operate the agent.
Run completion, recorded reply and linked SMS delivery remain distinct.
The current agent does not record a Business Info version for each reply, so
historical provenance is explicitly unavailable. No worker behavior changes.

## Historical release — October 10, 2026

The backend is deployed to WPacquisition (`wxamwhfmelxqahkdtcci`). Direct project
access works despite the connector's incomplete project listing. Applied history
was reconciled across both repositories, then the forward migration was rehearsed
in a rollback transaction and applied as remote `20261010175821_inbound_sms_agent`
(local source `20261010171755_inbound_sms_agent.sql`). Do not apply it again under
the local timestamp. Deployed versions: AI worker 37, CRM API 53, SMS worker 20,
Twilio webhook 20. Deno checks and unauthenticated rejection checks passed.

The existing server OpenAI key has GPT 6.1 Sol access. All 70 real-model synthetic
scenarios completed and were reviewed by Codex: 50 supported tool/answer choices
matched, 20 adversarial replies remained within permissions, and shadow isolation
passed. A separate real-model/local-database booking conversation created exactly
one appointment after YES and did not duplicate it after another YES. Provider
acceptance was simulated; no real SMS was sent. Estimated model cost: $0.20767.
The temporary authenticated model probe was retired after evaluation with JWT
verification enabled and no remaining OpenAI access in its code.

Opek **shadow** and the AI queue are enabled. Live remains locked; Opek currently
has no shared service schedules, and its approved profile timezone is UTC.
Review actual timezone/hours/resource capacity and production shadow observations
before live activation. Other businesses default off. Frontend deployment
`dep-db583fks728c73c66stg` is live in Micah's Render workspace as of October 10,
18:19:53 UTC. The CRM page/navigation and served Inbound AI source/bundle were
verified against the release at `https://crm.e2local.com`. Detailed synthetic
artifacts and review are in ignored `data/inbound-agent-*.json`.

Isolated release source is published on `codex/inbound-sms-release`, commit
`1ffa88f14ccc177b8c7492274d4656ebd47dff24`. Its exact source builds and passes 56
targeted tests (three existing skips), with the paired E2 migration fixtures.
The active checkout's unrelated edits were excluded from that release commit.

## Runtime and controls

The verified Twilio webhook queues only `sms-agent-v1` jobs for an enabled
business. Each message runs a short-lived worker using direct HTTP to OpenAI
Responses, model `gpt-6.1-sol`, low reasoning, standard (`default`) service tier,
`store:false`, and encrypted reasoning continuation. Each run allows four model
requests, three tools, a 35-second model/action deadline and 4,096 output tokens
per request. Customer replies are separately limited to 600 characters. Transient
failures retry through the existing queue, up to three total attempts.

Staff use **AI replies** for revision-checked on/off settings, optional reply style,
a separate booking permission, approved Business Info and shared
**Service availability** links. Legacy shadow settings are retained for history. A manual reply pauses
that conversation until explicit resume. STOP, new messages, staff takeover and
settings revisions fence tools and the final provider submission. Queued inputs
coalesce with a two-second delay; the existing queue serializes business/phone.

The tools are `lookup_bookings`, `check_availability`, `prepare_booking`,
`confirm_booking` `request_staff_help` and `close_enquiry`. Identity comes exclusively from the
leased verified inbound job. Lookups return only that customer's appointment
references, services, times and statuses. Approved profile/retrieval content,
recent accepted messages, recent forms and the active draft provide context.
Customer form text cannot authorize tools or override policy.

Booking collects one missing field at a time. The database renders the exact
proposal and binds it to a conversation hold and service-rule version. Capacity
is not reserved. Confirmation requires a clear reply after provider acceptance of
that exact summary; corrections invalidate it. Expiry or changed availability
requires another check and proposal. Only a database commit renders a success
reply. Stable action keys and confirmed holds recover crashes and repeated YES
messages without duplicate appointments.

Voice and SMS share private prepare/confirm functions and the existing resource
pool lock, service schedule, timezone, exceptions, notice and duration rules.
Voice wrappers retain authentication/OTP and endpoint contracts. SMS records
`source='sms'` while keeping existing `voice_*` capacity fields for compatibility.
Existing intake hooks create the CRM/E2 appointment and reminder enrollment once.
E2 membership and released-service visibility remain required.

Cancellations, rescheduling and requests for a person create a deduplicated CRM
task and pause AI. Exhausted failures recover committed bookings first, then
create one task and an eligible fallback reply. The feature sends no automatic
outbound follow-up and never restarts form reminders or legacy sequences. Each
form's Pause/Continue policy continues to govern its own reminder run.

Shadow records proposals and simulated tool results without creating bookings,
draft sessions, customer changes, staff tasks, reminders or outbound messages.
The ordinary inbound webhook still records the customer's message and applies
the form's existing reply policy. Legacy AI jobs and retired group endpoints stay
disabled. Usage, estimated USD cost, latency and tool outcomes are stored in
private run/action records; stale cancellations appear on jobs. Logs omit keys
and message bodies. Historical audit data has existing staff-only access.

## Validation

Run `npm run test:inbound-ai` for the worker and database cases. Relevant CRM
worker/conversation/form/booking suites and paired E2 booking, enquiry,
service-access and cache suites use the local migration baseline. Real PostgreSQL
capacity tests use two independent sessions and test both voice-first and
SMS-first confirmations; the losing channel waits and refuses occupied capacity.
Provider, queue and Vault extensions are fixtures; no real SMS is sent.

For the optional local PostgreSQL runtime:

```powershell
npm install --prefix data/inbound-postgres --no-save --package-lock=false embedded-postgres@17.10.0-beta.17
npm run test:inbound-concurrency
```

This creates a disposable local cluster under ignored `data/inbound-postgres`,
bound to loopback port 55439, and stops it on exit. It never reads a production
database URL.

`npm run eval:inbound-ai` requires an injected `OPENAI_API_KEY`, verifies model
access, and evaluates 50 supported plus 20 unsupported/adversarial synthetic
scenarios against the real Responses API and isolated shadow database. Results
are written under ignored `data/` with human review pending. The evaluator does
not activate live mode. Review every proposed answer/tool outcome, then conduct
the Opek shadow pilot with approved real knowledge and schedules. Require zero
unauthorized disclosures, duplicate bookings, capacity violations and false
booking confirmations. Inventory and mocked tests are not live model validation.

## Forward release and rollback

1. Connect the Supabase account owning WPacquisition. Inspect the remote applied
   migration history against both repositories. Do not bootstrap or replay either
   history. Retain existing scoped database credentials and worker tokens.
2. Use CRM-owned `20261010171755_inbound_sms_agent.sql` as a single forward
   migration after CRM `20261006065213_simplify_agent_booking_fields.sql` and
   the existing paired baseline. That baseline includes CRM form-first
   `20261003143731` before E2 `20261003145302`, and subsequent paired account,
   service and booking migrations already recorded in both project records.
   Rehearse the forward SQL in a rollback transaction against the verified
   baseline; no E2 migration is added by this feature.
3. Apply the new migration once. Deploy the CRM API, Twilio webhook, AI and SMS
   workers and frontend with all new modes off. The edge bundler includes
   `src/workers/inboundAgent.js`; retain the existing scoped-role connections.
4. Create a dedicated OpenAI project API key and store it as `OPENAI_API_KEY` in
   WPacquisition Edge Function secrets. Never put it in public frontend config,
   commit it, or paste it into chat. Use API billing and project usage controls.
   The new model is pinned in code; legacy `OPENAI_MODEL` does not override it.
   Check Responses access to `gpt-6.1-sol` before enabling any business.
5. Review Opek's approved knowledge and actual service timezones/hours/capacity;
   this implementation does not infer or activate business schedules. Confirm
   the existing AI queue dispatcher/scoped credentials are ready, then enable
   Opek shadow only. Run/review the 70-case evaluation and shadow observations.
6. Only after the gate passes, record the evidence location and reviewer in both
   project records and set Opek's private `live_validated_at` through the operator
   database connection. The staff API intentionally cannot set this field.
   Switch Opek to live through revision-checked settings. Keep all others off.

Rollback changes Inbound AI to off, incrementing its revision. New runs and
pending versioned sends fail eligibility; confirmed appointments and audit
history remain. A message already accepted by Twilio cannot be recalled.
No destructive schema rollback is required. Record applied migrations, deployed
versions, model verification, shadow review and live activation separately.

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

Applied migration mapping: local `20261010183109_inbound_automation_coordination.sql` = remote `20261010184313_inbound_automation_coordination`. Do not reapply under the local timestamp.

Release verified October 10: AI worker 38; remote migration `20261010184313`; CRM `56a83d3`, Render `dep-db58fv5ckfvc739auub0` live at 18:46:31 UTC. Opek coordination is shadow-only; other businesses remain off. Live activation has not occurred. See both PROJECT_RECORD files for validation scope and remaining operational gates.

## Activity reporting

Automation activity reads durable agent/booking/message records without calling
the model. Shadow proposals remain visibly simulated and outside actual response
and conversion totals. Explicit primary enquiry attribution is audited and does
not alter a booking creator. See [Automation activity](AUTOMATION_ACTIVITY.md).


## Direct contact sequences

Staff can assign versioned enquiry follow-ups without a form. Contact blocks
apply to form and direct enquiry runs; appointment reminders stay separate.
See [Direct contact automations](DIRECT_CONTACT_AUTOMATIONS.md) for controls,
reply policies, attribution, rollout and rollback.

## October 14 unified SMS behavior

CRM migration `20261014210130_unified_sms_workspace.sql` follows the applied
October 14 shared baseline and direct-contact automation functions. Apply this
new CRM migration once before the frontend; no E2 migration or API change is
needed. The paired fixture fingerprint includes it. Do not replay either history.

AI reads the latest 30 inbound/accepted outbound messages for the verified
business and phone across old conversation groups, bounded at the incoming
message's timestamp. Queued/unaccepted, future, other-business and other-contact
messages are excluded. This does not merge or delete stored conversations.
Saving an enabled reply mode enables automation context/coordination as part of
that setting. Existing modes, approval flags and booking permissions are retained.
Continue form and contact enquiry runs use the same 30-minute wait after inbound
or accepted AI replies, including Off/Review only. Appointment policies, STOP,
manual takeover, explicit resume and immutable published versions are unchanged.

Local validation: 407 CRM tests passed (29 skipped), 63 paired tests passed,
18 follow-up targeted checks passed after final SQL/editor refinements. Build,
source checks and Edge bundle passed. Production release status is recorded in
both project records; the UI refactor alone does not enable live replies.

Applied mapping: local `20261014210130` = remote `20261014210940`. The three
function source hashes and API-only grants match the tested source. Do not apply
the local timestamp again. Opek remains Review only and unapproved.

Security advisor output before/after is unchanged: existing [RLS policy
notices](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy),
[extension placement](https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public)
and [existing public function grants](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable).
New settings wrappers remain private and callable only through the scoped API.

Frontend code `5fb1f2a` is live through docs-only successor `4919779` on
Render deployment `dep-db7v8asf7cus73ftt890` (October 14, 15:54 MDT).
After the outage recovered, all 18 production assets and runtime configuration
matched the tested build. See both project records and the local
`data/unified-sms-production-verification.json` evidence generated by
`data/unified-sms-verify.mjs`. Live replies remain subject to pilot approval.

## Knowledge and active SMS AI MCP — October 16, 2026 (local)

Stage 5 adds twelve tools and nine independent grants. Local catalog: 103 tools /
72 permissions. Source/version reads are scoped and bounded, with explicit IDs and
paginated extracted text. Manual text is untrusted content. Creation queues indexing;
refresh, archive and version approval are independent and revision protected.
Duplicate origins conflict instead of overwriting. Shared triggers fence browser,
worker and MCP changes. Archive rejects in-flight indexing, cancels pending jobs,
and audits affected versions/jobs; archived knowledge cannot be resurrected by a
stale worker. Structured profile knowledge stays in the profile-review workflow.

Private file uploads use a committed upload intent and a 60-second, one-use adapter
ticket. The restricted database login can mint tickets only for its own authorized
intent; CRM Edge consumes them after rechecking identity, grants and business scope.
Storage credentials remain in Edge. Signed upload URLs are ephemeral responses,
never audit or retry-receipt content. Storage URLs expire after two hours and do not
permit overwrite; uploaded size/MIME must match the intent before indexing. Intent
expiry is 24 hours. Lost signing responses recover the same intent with the same
idempotency key and a fresh URL. No OAuth token is forwarded as a browser session.

AI reads do not insert defaults. Instruction edits preserve mode/booking activation;
activation is separately granted and retains canonical pilot, reviewed-profile and
live-validation prerequisites. No tool sets the private validation flag or queues
an SMS. AI instruction content is excluded from mutation receipts and audit.

Local CRM 651 passed / 29 existing skips; paired 63; relevant E2 15; both project
checks and frontend/66-file Edge bundle pass. Real PostgreSQL concurrency covers
same-key indexing/settings retries, worker lock/revision conflicts, archive versus
refresh, interrupted transactions and one-use upload races. Migration 20261016200143
is reconciled against 141 entries and rollback-rehearsed, not yet applied. Release
order: migration, CRM Edge adapter, MCP environment/service, frontend. No E2 runtime
release required. Live smoke checks use only reads and existing previews.
