# Inbound SMS agent

## Release status — October 10, 2026

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
before live activation. Other businesses default off. Frontend deployment is
pending Render workspace confirmation. Detailed synthetic artifacts and review
are in ignored `data/inbound-agent-*.json`.

## Runtime and controls

The verified Twilio webhook queues only `sms-agent-v1` jobs for an enabled
business. Each message runs a short-lived worker using direct HTTP to OpenAI
Responses, model `gpt-6.1-sol`, low reasoning, standard (`default`) service tier,
`store:false`, and encrypted reasoning continuation. Each run allows four model
requests, three tools, a 35-second model/action deadline and 4,096 output tokens
per request. Customer replies are separately limited to 600 characters. Transient
failures retry through the existing queue, up to three total attempts.

Staff use **Inbound AI** for revision-checked off/shadow/live settings, business
instructions, a separate booking permission, approved knowledge and shared
**Service availability** links. Only the Opek pilot may enable shadow/live.
Live also requires an operator-recorded validation gate. A manual reply pauses
that conversation until explicit resume. STOP, new messages, staff takeover and
settings revisions fence tools and the final provider submission. Queued inputs
coalesce with a two-second delay; the existing queue serializes business/phone.

The five tools are `lookup_bookings`, `check_availability`, `prepare_booking`,
`confirm_booking` and `request_staff_help`. Identity comes exclusively from the
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
