# Soni voice agent CRM bridge

## October 12 production rollout status

CRM migrations are applied as `20261012202507 staff_voice_overview` and
`20261012202514 voice_setup_flow`; `crm-api` version 58 is ACTIVE. CRM frontend
commit `c43600a` is live in Render `dep-db6k4uavcj2c7389muug` at
https://crm.e2local.com; authenticated library and call-history checks passed. E2 application code is unchanged. The local-only/pending
notes below are historical and superseded by this status. Existing customer
Voice visibility stays draft until staff explicitly enable access.

This guide covers the Opek-specific bridge in this checkout. The external Soni
worker is maintained in the sibling `voice agent` project. See the
[API reference](API_REFERENCE.md#voice-and-internal-workers),
[configuration](CONFIGURATION.md#voice-configuration) and
[project record](../PROJECT_RECORD.md) for interfaces and evidence boundaries.

Soni's LiveKit worker lives in `../voice agent`. Its current deployed lookup path
is the separate `voice-lookup` gateway described below. The older `voice-agent`
write bridge remains available separately; its capabilities are not exposed by
the current phone worker. In that legacy bridge, the CRM side is the `voice-agent`
Edge function, a scoped Postgres login, and tenant-bound RPCs in
`20260926010000_voice_agent_bridge.sql`. The worker signs each request with an
HMAC. The Edge function fixes the business to `opek`; the model cannot select
another tenant or query SQL directly.

## Voice and toll-free SMS approval

Toll-free SMS verification does not gate voice. Existing signed number/business
routing stays available while SMS is pending or rejected. The October 11 local
connection correction permits pending voice-capable numbers and preserves their
voice configuration. It does not create additional Soni agents or broaden this
bridge's configured Opek business/number. SMS approval and sending gates remain
separate. See [Twilio connections](TWILIO_CONNECTIONS.md) for rollout status.

## Legacy write bridge capabilities

- Contact and Quote Request submissions enter the existing automation intake
  tables with `source=voice`. They are visible in the CRM. Voice submissions do
  not start automatic text enrollments or grant marketing consent.
- Existing contact, quote, and booking details require a code sent to the
  customer's phone. Updates are limited to contact name/email and quote summary.
  Verified bookings can be rescheduled or cancelled after a spoken recap and a
  later affirmative response.
- A new job booking checks an enabled service, market, ZIP, local hours,
  duration, shared resource capacity, and lead time. The final confirmation
  rechecks availability under a resource-pool lock. The booking is mirrored into
  the Booking automation intake once; voice intake remains unenrolled in texts.
  A new booking to a different callback number, or from a Console session with
  no caller number, requires SMS verification first. Dumpster rental requires a
  size-specific `variant` rule.
- Texts use `sms_private.outbox` and the existing approved Opek sender path.
  Soni reads the destination and exact text, then sends only after the caller's
  later affirmative response. A queued text is not a delivered text. Existing
  opt-out and sending controls remain in force.

## Deployment order

1. Reconcile the existing `20260926010000_voice_agent_bridge.sql` migration
   against project history before applying any new additive change to
   `wxamwhfmelxqahkdtcci`. The bridge migration creates a no-login `sms_voice` role with RPC-only
   privileges and no direct table privileges. It adds a rule editor to the CRM
   Booking setup page. Rules default to disabled.
2. With `MIGRATION_DATABASE_URL` for this exact project, run
   `node scripts/bootstrap-voice-role.js` once. It creates `sms_voice_login`
   and writes `VOICE_AGENT_DATABASE_URL`, `SONI_BRIDGE_SECRET`, and
   `SONI_OTP_SECRET` to ignored `data/voice-agent-credentials.env`. Keep that
   file out of source control and rotate it if exposed.
3. Set those three variables as Supabase Edge secrets, then deploy `voice-agent`
   with JWT verification disabled per `supabase/config.toml`. Deploy the updated
   `crm-api` as well. The voice endpoint authenticates every request with a
   timestamped HMAC signature. Add `SUPABASE_URL` and the same
   `SONI_BRIDGE_SECRET` to the Soni LiveKit worker secrets, then deploy the
   worker. Its model and voice configuration are owned by the external project;
   this documentation pass did not inspect or change that runtime.
4. Deploy the CRM frontend after `npm run build:frontend`. In Booking setup,
   create one rule for each service/market and dumpster size. Enter exact ZIP
   coverage, time zone, resource pool, duration, capacity, notice, weekly hours,
   and exceptions. Review existing future bookings before enabling a rule.
   Future unclassified bookings block voice availability for the local day.
   Enabling a rule with existing future unclassified bookings is rejected until
   those bookings are reconciled. Do not invent capacity or service times.
5. Use the approved Opek Twilio toll-free line `+18777574365` for inbound
   voice. Deploy `soni-voice-inbound` with JWT verification disabled; it
   validates Twilio's signature against Opek's existing credential and checks
   the exact destination number. Set `SONI_VOICE_TENANT_ID` to the registered
   business that owns the approved provider account (the legacy default is `opek`).
   Set `SONI_VOICE_WEBHOOK_URL` to its exact HTTPS
   URL. Generate a distinct SIP username and password (12–128 letters, numbers,
   `_`, or `-`), and set `SONI_SIP_USERNAME` and `SONI_SIP_PASSWORD` as Edge
   secrets. Create a LiveKit inbound trunk restricted to that number with the
   same SIP credentials, and create an individual dispatch rule bound to the
   trunk with `roomConfig.agents[0].agentName=voice-agent-phone`. Point only Twilio's
   **voice** webhook for that number to `soni-voice-inbound`; leave its
   Messaging Service, SMS callbacks, and the separate ElevenLabs number intact.
   The agent reads the caller's `sip.phoneNumber` attribute. The checked-in
   current LiveKit dispatch file is `../voice agent/deploy/phone-dispatch.json`.
   Supply the SIP
   credentials to `lk sip inbound create` and bind the returned trunk ID with
   `lk sip dispatch create ... --trunks <trunk-id>`.

The LiveKit inbound trunk and dispatch rule are long-lived and should be
created once. The dispatch rule must name `voice-agent-phone` explicitly because the worker
uses explicit dispatch. [LiveKit's Twilio Voice guide](https://docs.livekit.io/telephony/accepting-calls/inbound-twilio/)
and [dispatch rule guide](https://docs.livekit.io/telephony/accepting-calls/dispatch-rule/)
describe this TwiML approach. This route handles inbound calls; it does not
support SIP REFER or outbound calls.

## Recorded inbound route

The September 26, 2026 deployment record describes this connection; it was not
rechecked live during documentation reconciliation. Opek's existing Twilio voice number
`+18777574365` sends POST requests to
`https://wxamwhfmelxqahkdtcci.supabase.co/functions/v1/soni-voice-inbound`.
The signed webhook returns TwiML for the LiveKit SIP endpoint
`65qezov0v3b.sip.livekit.cloud`. LiveKit inbound trunk
`ST_Zv8sKYn4EHMZ` is restricted to that number; dispatch rule
`SDR_va9AjKUeqSjo` binds the trunk to agent `soni`. SIP credentials are
stored in ignored `data/soni-telephony-credentials.env` and as Supabase Edge
secrets. Do not create a second trunk or rule for this route. The signed webhook
returned TwiML in a synthetic test, an invalid signature returned 403, and
the worker was Running. A physical test call is still needed to verify PSTN
audio and dispatch end to end.

## Verification

### October 4, 2026 route restoration

Live Twilio inventory confirmed the existing toll-free number is approved and
voice-capable. The current LiveKit project had no inbound trunk or dispatch rule;
the September 26 IDs above are historical. The current agent is
`voice-agent-phone`, cloud ID `CA_H8mbfRdWKWJV`, version `d6P5JWi7NpUf`, using
Vesper and the sibling project's saved voice/brain prompts with GPT-Live-1 and GPT-6.1 Sol.
Inbound trunk `ST_wuu4MFmMMfdG` and dispatch rule `SDR_KjBLwj6ZZg4h` now route the
approved number into separate caller rooms in project `p_65qezov0v3b`.

The signed webhook rejected the real account with `Unknown account` because
its legacy `opek` tenant guard no longer matched the registered provider owner.
The handler now checks the configured `SONI_VOICE_TENANT_ID`, retaining exact
destination, provider ownership, signature, and SIP credential checks.
`soni-voice-inbound` version 5 is ACTIVE with JWT verification remaining disabled
for Twilio's signature-authenticated webhook. Only this function was deployed,
using the downloaded live shared modules to preserve unrelated local edits.
No migrations, business/provider reassignment, SMS callback changes, or CRM/E2
frontend releases were performed. This phone deployment does not implement the
legacy CRM tool bridge described above.

Validation: 25 focused CRM tests and 16 paired E2 checks passed. The live signed
webhook returned 200 and the correct SIP host/credentials; unsigned requests
returned 403. The cloud greeting audio check passed and the agent is Running.
Physical PSTN audio remains a manual call check. Cloud audio/transcripts are
recorded through LiveKit Agent Insights; local browser archives remain separate.

For the legacy write bridge, run `node --test test/voiceAgentBridge.test.js` and `npm test` here. After deploying that separate bridge,
confirm an unsigned voice request returns 401, a signed Console inquiry appears
once in Quote Requests, no voice intake enrolls in an SMS automation, a booking
only confirms in an enabled ZIP/time, and a caller-requested test text enters the
Opek outbox. Check the LiveKit worker is Running and that a Console greeting
works before testing the phone line. Use a controlled test call for final
Twilio-to-LiveKit routing verification.

### October 5, 2026 deployed read-only lookup gateway

The current phone worker, LiveKit production version `f3pBiwBsMUYb` (Running), now uses
`voice-lookup`, not the legacy write bridge.
It is fixed to the approved number's registered owner,
`biz-1c0c09ce-819e-4795-86b9-0e457ab92f58` (Opek Junk Removal). Provider ownership
is rechecked on every database operation. Only approved active business facts
and knowledge are returned. The customer's name/phone and up to ten bookings
require SMS verification bound to this call and phone; no booking mutations or
general outbound texts are exposed. The worker requires later affirmative caller
permission after its verification question before queueing a code. Codes expire
after five minutes, allow three attempts, and are rate limited. The existing SMS
outbox preserves sending and opt-out checks; queued is not delivered.

Migrations `20261005200000_voice_agent_read_lookup.sql` and
`20261005203000_voice_lookup_boundary.sql` were applied individually and recorded
in the shared project's migration history, in that order. The second migration
isolates the login from older `sms_private` routines with inherited PUBLIC
execution. `sms_voice_lookup_login` has no direct customer-table privileges,
no superuser/bypass-RLS rights, and no `sms_private` schema usage. Its four
`voice_lookup_api` wrappers execute scoped internal functions as their owner.
The migration deliberately does not change privileges of existing clients.

Edge `voice-lookup` version 2 is ACTIVE with JWT verification disabled; exact
timestamped HMAC authentication and an operation allowlist replace JWT here.
It uses `VOICE_LOOKUP_DATABASE_URL`, `SONI_LOOKUP_SECRET` and
`SONI_LOOKUP_OTP_SECRET`. LiveKit receives only the Supabase URL and HMAC secret,
never the database login or admin/application keys. Recovery credentials are in
the ignored sibling `.local/voice-lookup-secrets.env`. Rotating the gateway key
requires updating Edge and LiveKit/local worker together.

The saved persona still describes Mile High Moving, while the approved sender
and database belong to Opek. Saved prompts were preserved; runtime rules prohibit
silently assigning Opek facts to a different business. Staff should reconcile
the persona using the existing live prompt publishing UI.

Focused validation: `node --test test/voiceLookup.test.js test/voiceAgentBridge.test.js`
(5 checks), the sibling Python suite (36 checks), and paired E2 account, services,
linking/access and booking tests (24 checks) passed. Synthetic database fixtures
cover actual outbox queueing, verification, scope, approved profiles, expiration
and denied legacy/internal functions. Live signed business lookup succeeds;
unsigned requests and unverified customer lookup are denied. Production contact,
booking and message totals were unchanged. No real verification SMS or customer
record lookup was performed; PSTN audio and real SMS delivery still need a
controlled caller test. CRM/E2 application runtimes and existing phone route
were not released or changed by this lookup deployment.

## October 5 availability update

CRM Booking setup now supports multiple daily windows, structured exceptions and
slot previews. SMS booking is now independently gated by the Inbound AI pilot; see [Inbound AI](INBOUND_AI.md). A separate restricted
voice bridge supports new-booking preparation/confirmation after phone verification
and a fresh caller confirmation. Activation defaults off. See
[Booking availability](BOOKING_AVAILABILITY.md) for contracts, migration order,
caller workflow and actual validation. Earlier legacy `opek` voice-bridge setup
instructions do not activate the new registered-business endpoint.

## Voice CRM runtime

The current phone worker now has a separate, restricted configuration/call/lead runtime bridge. Legacy write tools and the lookup role are unchanged. See [Voice CRM contracts and rollout](VOICE_CRM.md).

## Customer dashboard release

The owner-only E2 Voice dashboard is controlled separately from agent publishing.
See [Customer Voice](CUSTOMER_VOICE.md) for setup, access, retention and the paired
forward migration order. This is locally implemented; the new migrations and
frontends are not yet deployed.

## Staff workspace discovery and customer release

The October 12 local CRM workspace additions are documented in
[CUSTOMER_VOICE.md](CUSTOMER_VOICE.md#historical-october-12-workspace-implementation).
Voice Agent now links directly to the selected business record at Services.
Add Voice / Set live is a customer release operation for an already registered
agent, not generic LiveKit deployment assignment. The existing Opek initializer
and external runtime scope are unchanged. See the paired project records for
local validation and pending migration/API/frontend rollout.

The subsequent Voice Agents redesign adds persisted CRM drafts and a picker of
CRM-connected deployments. It does not provision LiveKit workers, broaden the
Opek runtime scope, or transfer another business's deployment. New drafts must
receive the existing external runtime/phone setup before publishing; null
deployment/phone drafts are excluded from customer visibility and readiness.
