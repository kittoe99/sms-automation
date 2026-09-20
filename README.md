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

- Quote follow-ups run over six steps, only between 9am and 7pm in `BUSINESS_TIME_ZONE`.
- A normal customer reply postpones the next quote follow-up for at least 24 hours.
- STOP removes all active automation enrollments; opting back in does not silently restart them.
- Creating a booking ends quote follow-ups and enrolls a dated appointment reminder.
- Updating a booking reschedules its reminder; cancelling it removes the reminder.
- Expired appointments are removed without sending a stale reminder.
- The scheduled runner executes every 15 minutes and scans beyond its processing batch so future-dated rows do not hide due work.

External quote and booking systems can publish lifecycle events through
`POST /api/internal/automation-event` using `X-API-Key`. Supported types are
`quote.created`, `booking.created`, `booking.updated`, `booking.confirmed`, and
`booking.cancelled`.

### Custom automation groups

CRM users can create custom automation groups from **Automations → Create group**.
Rules support daily, every other day, every 3 days, weekly, monthly, and custom
day/week/month intervals, with 1–30 sends and an account-local send window. A specific
first-send date/time can be scheduled for one-time or multi-step campaigns. Every step
can have a different delay and message. Templates support `{{first_name}}`, `{{name}}`,
and `{{phone}}`. Custom groups use the same contact consent, STOP suppression,
claim/retry, delivery tracking, and automatic completion logic as the built-in quote
sequence.

Every system or custom group also has optional administrator-authored AI instructions.
When enabled, instructions for all active groups in which a replying contact is enrolled
are added to the AI request as trusted system context. They supplement rather than
replace platform safety, consent, privacy, and tool constraints. Delayed AI jobs restore
the inbound message's tenant context before resolving those instructions.

Local development defaults to `data/automation-groups.json` (override with
`AUTOMATION_RULES_FILE`). App Platform uses the shared `sms_automation_groups` Supabase
table so web and scheduled-runner instances see the same definitions. Apply
`supabase/migrations/20260910_sms_automation_groups.sql` followed by
`supabase/migrations/20260910_sms_security_hardening.sql` before deploying and set
`AUTOMATION_RULES_STORE=supabase`. Existing message and enrollment records continue to
use their current Supabase tables.

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
