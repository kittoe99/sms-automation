# Supabase SMS automation

The active implementation uses WPacquisition Postgres, durable queues, Cron and bounded Edge workers. Start with [the deployment guide](docs/WORKER_DEPLOYMENT.md). Render is optional static frontend hosting only. The DigitalOcean instructions below are retained for cutover reference and are not the current deployment path.

# opek-sms

SMS automation foundation for **Opek Junk Removal** — Twilio Messaging + DigitalOcean App Platform (RPS autoscaling 1–3).

## Live

| | |
|--|--|
| App | https://opek-sms-zllz4.ondigitalocean.app |
| Health | https://opek-sms-zllz4.ondigitalocean.app/health |
| DO App ID | `65c82719-4bef-4306-90e0-dccadbeb5f17` |
| Repo | https://github.com/kittoe99/sms-automation.git (`deploy-crm`) |
| Gradient agent | `opek-sms-agent` (Ministral 3 14B, tor1) |

## AI SMS agent

- **Gradient™ AI Agents** — conversation / replies (`GRADIENT_AGENT_*`)
- **App Platform** — Twilio webhooks, eligibility gates, SMS send, CRM pause
- **Supabase** — enrollments, message store, `agent_bookings` only (not the agent runtime)

Eligible when not opted out and AI not paused. Enrollment in `quote-requests` / `appointment-reminders` is optional enrichment (category tagging), not required for replies.

**Call button (Messaging):** starts an ElevenLabs outbound call from `+18313187139` with SMS thread + CRM context injected into Macy’s follow-up/close prompt. Pauses SMS AI for that thread.


## Twilio

| | |
|--|--|
| Transactional Messaging Service | `MGae253c080173f100ca791069a215564a` |
| Sender (toll-free, approved) | `+18777574365` |
| Inbound webhook | `POST /webhooks/twilio/inbound` |
| Status callback | `POST /webhooks/twilio/status` |

Voice/AI local number `+18313187139` stays on ElevenLabs — do not move it into this service.

## Platform status

1. ~~Outbound transactional sends via `src/lib/twilioClient.js`~~ → **`POST /api/send`** (API key required)
2. ~~Twilio/ElevenLabs webhook signature validation~~ → enabled and fail-closed; both webhook secrets are required in production
3. ~~Message log persistence (Supabase)~~
4. Marketing Messaging Service + A2P (previous MARKETING campaign failed on opt-in / MESSAGE_FLOW)
5. ~~Campaign / drip automation~~ → quote follow-ups and appointment reminders are active

## Multi-tenant foundation

Platform administrators can now create **pending** businesses and provision a
dedicated Twilio subaccount + Messaging Service. Credentials are encrypted at rest,
webhooks route by Account SID, and ambiguous creation attempts require reconciliation.
Registration and multi-business activation remain deferred; the existing data-isolation
guard is still enforced. See [Multi-business Twilio setup](docs/multi-tenant-twilio.md).

The app has a business-account registry, an `X-Tenant-ID` request context, a workspace
selector, tenant-tagged new messages, and tenant-filtered WebSocket events. Opek remains
the default account.

This is intentionally a foundation, not a completed security boundary. The service now
fails closed if `TENANT_ACCOUNTS_JSON` activates more than one account. Before enabling
multiple businesses, add `tenant_id` to every persisted table, scope every query and
unique key by it, enforce Supabase RLS, provide per-tenant Twilio/ElevenLabs credentials,
and then update the remaining capability flags in
`src/lib/tenantContext.js`.

## Security controls

- CRM APIs require a server-verified Clerk session. A tenant can be bound to an active
  Clerk Organization using `clerkOrganizationId` or `clerkOrganizationSlug`; a single
  account may omit that mapping for backward-compatible personal sessions.
- Server integrations use a timing-safe API-key check; production keys must be at least
  32 characters.
- Twilio and ElevenLabs webhooks fail closed. Twilio verification cannot be disabled in
  production, and production requires the canonical `PUBLIC_BASE_URL`.
- Browser application scripts are same-origin except for Clerk's versioned UI/runtime
  loaded from the instance-specific Frontend API, with CSP, anti-framing, no-sniff, HSTS,
  referrer, and permissions-policy headers. Only Clerk's documented API, challenge,
  image, telemetry, and fraud-protection origins are allowlisted.
- WebSocket access tokens are carried in the WebSocket subprotocol rather than URLs, and
  connections validate their browser origin.
- Database read failures do not fall back to a process-wide memory cache.
- Sensitive messaging actions and authentication checks have bounded request rates.
- `supabase/migrations/20260910_sms_security_hardening.sql` enables RLS and removes
  browser-role access to service-owned SMS tables and CRM RPCs.

## Automation lifecycle

Four fixed intake tables start SMS automations at the database level:
`sms_automation_contacts`, `sms_automation_quote_requests`,
`sms_automation_bookings`, and `sms_automation_reviews`. Each business has one
editable intent and schedule per type. New Contact and Reviews rules start at one
send after one day; Quote Request starts on submission within the business send
window, then follows up every two days for six total sends (days 0, 2, 4, 6,
8, and 10); Bookings starts at one reminder 24 hours before a confirmed appointment.
The send count is editable from 1 to 30. Every due job asks AI for a fresh draft
using the exact source row and current conversation; reusable templates are not sent.

Staff can add and inspect rows under **Automations**, or trusted integrations can
insert them through `POST /api/automation-intake/{contacts|quote_requests|bookings|reviews}`.
`GET` on the same path lists recent rows. `PATCH /api/automation-intake/bookings/{id}`
changes a booking's status or appointment. Name and phone are standalone; extra
context is a JSON object in `details`. Supply a stable `Idempotency-Key` or
`sourceRecordId` on retries. Trusted direct database inserts run the same trigger.
The operational `sms_quotes` and `sms_bookings` tables mirror new records into
their intake tables; old records are not backfilled.

Records without a valid phone or required marketing consent, or whose contact
has opted out, remain in the intake table with a skip reason and do not send.
Requested bookings wait for confirmation; changes reschedule reminders and
cancellations stop them. Newer rows replace active sequences of the same type.
Quote Requests stop Contact nurture, confirmed Bookings stop Contact and Quote
follow-ups, and Reviews stop obsolete booking reminders. Existing inbound AI
settings and previously sent messages are unchanged.

### Web Forms submission storage

Website Contact, Quote Request, and Booking submissions are stored in
`sms_web_form_contact_submissions`, `sms_web_form_quote_request_submissions`, and
`sms_web_form_booking_submissions`. Each row has a business `tenant_id`, a UUID,
required `name`, E.164 `phone`, and `email`, plus object-valued `details` for
website-specific answers. Booking rows also require an exact `appointment_at`
timestamp. The database assigns `automation_group_id` and
`automation_intake_id`; callers must not choose an automation group.

Trusted database inserts create a matching automation intake row in the same
transaction. Contact and Quote Request rows require `sms_opt_in=true` and
nonblank `consent_evidence` to start SMS automation; a prior opt-out still
prevents sending. Booking rows enter the confirmed booking reminder flow on
submission. Changes to `details` on a saved Web Forms row do not restart an
automation; the intake row keeps the original submitted answers. Business
memberships control read access.

### Form Builder and website embeds

**Form Builder** in the dashboard has one Contact, Quote Request, and Booking form
per business. Admins can edit the title, description, button, enabled state, and
up to 20 ordered custom fields. Name, Phone, Email, optional SMS consent, and the
Booking appointment time are fixed. Each form has a stable public ID and iframe
snippet. Saving changes the live form without replacing existing snippets.
Disabling a form stops its public configuration and submissions.

Custom answers are saved in `details`. Each submission saves the form version and
field-label snapshot so historical answers stay readable after edits. The public
Edge endpoint validates the preset and answers, converts Booking times in the
business time zone, stores consent evidence, and lets the database trigger choose
the existing automation group. Unchecked Contact and Quote Request forms save
without SMS enrollment; Booking forms submit as confirmed.

During testing, the public `web-form` Edge endpoint accepts requests from all URL
origins. The dashboard retains its framing and origin restrictions; only
`/embed.html` permits framing. The iframe snippet includes automatic resizing and
a fixed-height fallback. See [deployment setup](docs/WORKER_DEPLOYMENT.md#web-forms-deployment).

## Server-to-server send (quotes)

```bash
curl -sS -X POST 'https://opek-sms-zllz4.ondigitalocean.app/api/send' \
  -H 'Content-Type: application/json' \
  -H "X-API-Key: $OPEK_SMS_API_KEY" \
  -d '{
    "phone": "+15551234567",
    "body": "Hi — your Opek quote is ready: $219.",
    "categoryId": "quote-requests",
    "name": "Jordan"
  }'
```

Requires `OPEK_SMS_API_KEY` on the SMS server. Opt-outs still block sends; marketing consent is not required for this transactional path.

## Local

To prepare an empty CRM before connecting record storage, set `CRM_DATA_MODE=empty`
and `AUTOMATION_RULES_STORE=file` in `.env`, then restart. Record tabs return empty
lists, customer actions and webhooks wait for storage, and automation definitions
and editors continue using local files. No existing database records are deleted.
To reconnect, clear `CRM_DATA_MODE`, configure the database credentials, choose
the automation store, and restart.

```bash
cp .env.example .env
npm install
npm run dev
```

For isolated local webhook testing only, set `TWILIO_VALIDATE_SIGNATURE=false`.
Production health checks return `503` until the required Twilio, Supabase, Clerk, and
API-key configuration is present. Copy this app's publishable and secret keys from the
Clerk Dashboard into `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`; do not copy Antra's
keys unless both products are intentionally meant to share users. Add the deployed URL
as an allowed Clerk origin/redirect. For a Clerk Organization-backed account, set
`DEFAULT_TENANT_CLERK_ORGANIZATION_ID` (or the slug) so the active organization becomes
the tenant membership boundary.

Appointment reminders use `BUSINESS_TIME_ZONE`
(`America/Denver` by default) and require an appointment date when enrolled manually.

### No-login device preview

Run `npm run demo` for a separate read-only CRM on `http://127.0.0.1:8081`
(`DEMO_PORT` overrides the port). It serves synthetic contacts for two sample
businesses without loading Clerk, Supabase, Twilio, or AI clients. All writes,
unknown APIs, webhooks, and WebSockets are blocked. Point a temporary device-testing
tunnel at this port, not the live CRM on port 8080. Live CRM authentication is
unchanged; switching sample businesses is only a preview, not production tenancy.
