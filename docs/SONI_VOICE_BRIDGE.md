# Soni voice agent CRM bridge

Soni's LiveKit worker lives in `../voice agent`. The CRM side is the `voice-agent`
Edge function, a scoped Postgres login, and tenant-bound RPCs in
`20260926010000_voice_agent_bridge.sql`. The worker signs each request with an
HMAC. The Edge function fixes the business to `opek`; the model cannot select
another tenant or query SQL directly.

## Capabilities

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

1. Apply the new migration to project `wxamwhfmelxqahkdtcci` and verify it
   completes. The migration creates a no-login `sms_voice` role with RPC-only
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
   worker. The agent keeps GPT-Live/Vesper and GPT-6 Sol/high with WebSearch.
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
   the exact destination number. Set `SONI_VOICE_WEBHOOK_URL` to its exact HTTPS
   URL. Generate a distinct SIP username and password (12–128 letters, numbers,
   `_`, or `-`), and set `SONI_SIP_USERNAME` and `SONI_SIP_PASSWORD` as Edge
   secrets. Create a LiveKit inbound trunk restricted to that number with the
   same SIP credentials, and create an individual dispatch rule bound to the
   trunk with `roomConfig.agents[0].agentName=soni`. Point only Twilio's
   **voice** webhook for that number to `soni-voice-inbound`; leave its
   Messaging Service, SMS callbacks, and the separate ElevenLabs number intact.
   The agent reads the caller's `sip.phoneNumber` attribute. The checked-in
   LiveKit JSON files are `../voice agent/telephony/opek-inbound-trunk.json`
   and `../voice agent/telephony/opek-dispatch-rule.json`. Supply the SIP
   credentials to `lk sip inbound create` and bind the returned trunk ID with
   `lk sip dispatch create ... --trunks <trunk-id>`.

The LiveKit inbound trunk and dispatch rule are long-lived and should be
created once. The dispatch rule must name `soni` explicitly because the worker
uses explicit dispatch. [LiveKit's Twilio Voice guide](https://docs.livekit.io/telephony/accepting-calls/inbound-twilio/)
and [dispatch rule guide](https://docs.livekit.io/telephony/accepting-calls/dispatch-rule/)
describe this TwiML approach. This route handles inbound calls; it does not
support SIP REFER or outbound calls.

## Current inbound route

Connected on 2026-09-26. Opek's existing Twilio voice number
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

Run `node --test test/voiceAgentBridge.test.js` and `npm test` here, and
`uv run python -m unittest test_agent -v` in `../voice agent`. After deployment,
confirm an unsigned voice request returns 401, a signed Console inquiry appears
once in Quote Requests, no voice intake enrolls in an SMS automation, a booking
only confirms in an enabled ZIP/time, and a caller-requested test text enters the
Opek outbox. Check the LiveKit worker is Running and that a Console greeting
works before testing the phone line. Use a controlled test call for final
Twilio-to-LiveKit routing verification.
