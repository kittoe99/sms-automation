# Booking availability and the phone agent

CRM staff manage **Service availability**. The Bookings page links to it. The new
[inbound AI implementation](INBOUND_AI.md) shares voice service schedules and
resource capacity; legacy SMS settings remain separate. E2 customers continue to read
operational appointments under their existing membership and service-release rules.

## Staff workflow

Configure up to eight windows per weekday. Use separate windows for breaks; no
overnight window is accepted. Date exceptions replace that day's weekly hours,
either closing the date or supplying replacement windows. Overlapping windows,
duplicate exception dates and out-of-range numbers are rejected. Voice exceptions
use the same editor as SMS and no longer require JSON.

Legacy SMS inherits the business-profile time zone. Shared voice/inbound-AI rules require their own IANA
time zone, service and resource pool. ZIP coverage and dumpster size are no
longer required. Enable only one schedule per service; market is a staff label.
The editor displays the actual time zone and does not infer local hours or change
the business profile. The current registered business remains on UTC until staff
review and change it through the profile workflow.

Set duration, capacity, minimum notice and maximum advance. Voice services sharing
a resource pool must share its capacity. Legacy SMS capacity counts confirmed bookings
at the same start instant; voice and inbound AI count overlapping confirmed jobs in the pool.
Future unclassified appointments retain the existing conservative voice blockers.
Dumpster rental retains its existing multi-day duration behavior.

Preview a date before saving. Legacy SMS suggestions advance by slot duration; shared service
suggestions advance by 15 minutes. The database checks each candidate using the
same predicate used for booking. Exact voice requests can use other start minutes.
Closed dates return no candidates. Unavailable candidates display zero remaining
capacity. Disabled schedules are explicitly hypothetical. Previewing never saves
settings, reveals customer details or reserves capacity. Changing a draft makes
its earlier preview stale. Separate drafts survive switching voice rules, saving
the other schedule, and retained CRM tabs. Saved values reload from the API.

Conversational SMS booking and its follow-ups remain disabled by the form-first
rollout. Retained configuration controls do not reactivate them. Website forms
remain requests/reminder intake; they do not reserve operational appointments.

## Interfaces and authorization

Existing GET/PUT `/booking-settings` and `/voice-booking-rules` contracts remain.
CRM adds administrator-only POST `/booking-availability/preview` with the normal
verified staff identity and `X-Tenant-ID`. Body:

```json
{"channel":"voice","localDate":"2026-10-12","rule":{"service":"junk_removal","timeZone":"America/Denver","resourcePool":"crew","durationMinutes":60,"capacity":1,"minimumNoticeMinutes":120,"maximumAdvanceDays":90,"enabled":false,"weeklyAvailability":{"1":[{"start":"09:00","end":"12:00"},{"start":"13:00","end":"17:00"}]},"dateExceptions":[]}}
```

Use `channel: "sms"` and `settings` containing the existing SMS settings payload
for SMS previews. Results contain `timeZone`, `localDate`, `configuredEnabled`,
`hypothetical`, `smsActive: false`, and `slots`. Each slot contains `localTime`,
`startsAt`, `endsAt`, `available`, and `remainingCapacity`.

The separate `voice-booking` Edge function requires timestamped HMAC requests,
using `SONI_BOOKING_SECRET` and the existing `X-Voice-Timestamp`/
`X-Voice-Signature` format. Envelope: `{action, callId, payload}`. The endpoint
pins the registered business and applies the existing provider/number scope.
Callers cannot supply a tenant, arbitrary operation, SQL, or existing booking ID.

| Action | Payload | Result |
| --- | --- | --- |
| `availability` | `service`, `localDate` | Configured state, time zone, eligible slots |
| `prepare` | Above plus `localTime`, `phone`, `name`, `address`, optional object `details` | Availability and expiring prepared reference/recap details |
| `confirm` | `holdId` only | Confirmed booking ID, appointment, time zone; retries return the same booking |

`sms_voice_booking_login` inherits only `sms_voice_booking`. Its API schema exposes
these three operations and grants no table access or `sms_private` schema access.
The existing `sms_voice_lookup` role retains its lookup-only boundary.

## Voice caller workflow

The sibling `voice agent/booking_tools.py` adds availability, preparation and
confirmation tools only when `VOICE_BOOKING_ENABLED=true` and both bridges are
configured. Lookup continues independently when booking is disabled.

1. Read actual CRM availability; collect service, location and customer details.
2. Use the existing consent-before-text workflow and verify the callback phone
   for this call. Caller ID is insufficient for new booking preparation.
3. Prepare the booking. This is a check, not a capacity reservation.
4. Speak the returned recap through the voice session and finish playback. An
   interruption or playback error prevents confirmation.
5. Require a subsequent, unambiguous affirmative caller reply. Corrections require
   a new preparation and recap. Confirm only the stored reference.

The database checks phone verification, call binding, five-minute expiry and rule
version. Confirmation holds the rule row and resource-pool transaction lock,
rechecks capacity, and creates one operational booking with its existing intake
mirror. It does not add marketing consent or an automatic voice SMS enrollment.
After an uncertain network outcome, retry the same confirmation; preparing a
replacement is blocked until that outcome is resolved. Definite validation
rejections release the local preparation. Success is announced only after the
database returns `confirmed`. Existing business/persona mismatch handling remains.

## Migration and rollout

CRM owns `20261006053509_booking_availability_voice.sql`. It follows the existing
SMS booking and slot-boundary migrations, voice bridge (live alias
`20260926141343`), and lookup migrations `20261005200000` then `20261005203000`.
Do not replay either CRM or E2 history. No E2 schema change is needed.

For a fresh deployment, run `scripts/bootstrap-booking-role.js` with a privileged
`MIGRATION_DATABASE_URL` after the migration. It creates a new restricted login
and stores credentials in ignored `data/voice-booking-credentials.env`; it refuses
to replace existing credentials. Set Edge secrets `VOICE_BOOKING_DATABASE_URL`,
`SONI_BOOKING_SECRET`, and `VOICE_BOOKING_ENABLED=false`. The voice worker receives
only `SONI_BOOKING_SECRET` and the disabled flag, not database credentials. Merge
these secrets into the existing deployment; retain lookup credentials and prompts.

Release order: database → CRM and booking Edge APIs → CRM frontend → voice worker.
Keep both Edge and worker booking flags false until staff configure real schedules
and a controlled caller pilot is ready. A disabled endpoint returns 503 and an
unsigned CRM preview returns 401. Roll back activation by disabling the worker and
Edge flags; retain bookings and the forward schema. Monitor endpoint failures,
capacity conflicts and duplicate confirmations without customer payload logging.

October 5 implementation verification: 48 selected CRM tests passed (two
intentionally disabled SMS tests skipped), 41 paired E2 tests passed, and all 41
voice-agent tests passed. The CRM production build passed. Browser checks of the
actual component in a synthetic fixture verified split windows, independent
drafts, save/reload and no horizontal overflow at 390px. These are not a real
phone-booking pilot or a simultaneous-session PostgreSQL load test.

Live migration was first checked in a rolled-back transaction, then applied and
recorded once. CRM and booking Edge APIs are deployed; the restricted login read
empty availability and denied direct tables/legacy private APIs. Security advisors
reported no errors. No live schedules, appointments or verification texts were
created. Frontend and voice-worker deployment completion is recorded in the
project records.

Verified release checkpoint: CRM API v49, booking Edge v1 and LiveKit worker
`rSSD7nP25dsn` are deployed. A temporary RTC probe verified existing lookup access,
Vesper, unchanged prompt revision and `voice_booking=false`; it did not start a
model conversation. The frontend was subsequently released as source dc9b49f in Render deployment dep-db29enbbc2fs73fpda40 on October 6; its deployed modules were verified. Production booking activation and
a physical phone pilot remain outstanding.

October 6 simplification: migration `20261006065213` is applied after the Voice
CRM migration. Frontend cce0e3a and LiveKit KsbH9doie9Ur are deployed. Agent
availability/preparation no longer require ZIP or size. Historical fields are
retained for compatibility; full service address remains required.
