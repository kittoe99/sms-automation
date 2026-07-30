# opek-sms

SMS automation foundation for **Opek Junk Removal** — Twilio Messaging + DigitalOcean App Platform (RPS autoscaling 1–3).

## Live

| | |
|--|--|
| App | https://opek-sms-zllz4.ondigitalocean.app |
| Health | https://opek-sms-zllz4.ondigitalocean.app/health |
| DO App ID | `65c82719-4bef-4306-90e0-dccadbeb5f17` |
| Repo | https://github.com/kittoe99/sms-automation.git (`main`) |

## Twilio

| | |
|--|--|
| Transactional Messaging Service | `MGae253c080173f100ca791069a215564a` |
| Sender (toll-free, approved) | `+18777574365` |
| Inbound webhook | `POST /webhooks/twilio/inbound` |
| Status callback | `POST /webhooks/twilio/status` |

Voice/AI local number `+18313187139` stays on ElevenLabs — do not move it into this service.

## Foundation only (wired later)

1. Outbound transactional sends (booking confirm / reminder) via `src/lib/twilioClient.js`
2. `TWILIO_AUTH_TOKEN` secret on DO → turn `TWILIO_VALIDATE_SIGNATURE=true`
3. Message log persistence (Supabase)
4. Marketing Messaging Service + A2P (previous MARKETING campaign failed on opt-in / MESSAGE_FLOW)
5. Campaign / drip automation

## Local

```bash
cp .env.example .env
npm install
npm run dev
```
