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

## Foundation only (wired later)

1. ~~Outbound transactional sends via `src/lib/twilioClient.js`~~ → **`POST /api/send`** (API key required)
2. `TWILIO_AUTH_TOKEN` secret on DO → turn `TWILIO_VALIDATE_SIGNATURE=true`
3. ~~Message log persistence (Supabase)~~
4. Marketing Messaging Service + A2P (previous MARKETING campaign failed on opt-in / MESSAGE_FLOW)
5. Campaign / drip automation

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

```bash
cp .env.example .env
npm install
npm run dev
```
