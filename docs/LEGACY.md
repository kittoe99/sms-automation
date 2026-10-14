# Legacy implementation reference

This guide preserves context for the former Express/DigitalOcean implementation. Use it only for isolated migration investigation. The supported production path is the static frontend plus Supabase Edge Functions described in the [README](../README.md).

## Historical components

| Component | Historical role |
| --- | --- |
| `src/index.js` and `src/routes/` | Express CRM/API, health checks, Twilio and ElevenLabs webhooks |
| `.do/` | DigitalOcean deployment artifacts |
| `src/lib/ai/` | Earlier SMS AI clients/context; some helpers may still be imported elsewhere |
| `src/lib/tenantContext.js` | Earlier tenant registry with fail-closed multiple-business guard |
| `src/workers/run.js` | Persistent Node queue runners; current production uses bounded Edge entrypoints |
| `supabase/legacy-migrations/` | Older schema definitions retained separately from current migration chain |

The old README named `https://opek-sms-zllz4.ondigitalocean.app` as the application, with a `/health` route and Gradient agent integration. These are historical identifiers, not verified current endpoints or deployment instructions. Earlier scale settings and AI-provider descriptions are not current architecture guarantees.

The ElevenLabs outbound call integration used a separate voice number and paused SMS AI for its thread. This does not establish a current Edge dialer: current Soni routing and bridge behavior are documented in [voice bridge](SONI_VOICE_BRIDGE.md). Do not move a provider number between services based on an old README.

## Isolated Express preview

`npm run start:legacy` starts Express; `npm run dev:legacy` uses Node watch mode. `src/index.js` explicitly throws if `NODE_ENV=production`. The mixed `.env.example` contains that value, so copying it unchanged and starting the legacy server fails by design.

For a separately configured, isolated development environment:

```powershell
$env:NODE_ENV = 'development'
$env:CRM_DATA_MODE = 'empty'
$env:AUTOMATION_RULES_STORE = 'file'
npm run dev:legacy
```

Inspect configuration before launching: the legacy process loads `.env`, and provider/storage integrations can have side effects when configured. `CRM_DATA_MODE=empty` is a legacy record-storage mode, not a production switch or a universal provider sandbox. It retains automation definition editors and does not delete database records. Prefer `npm run demo` for a no-credential read-only UI.

Legacy variables, including tenant registry, file stores, Twilio/ElevenLabs credentials, Clerk organization mapping and `OPEK_SMS_API_KEY`, are classified in [configuration](CONFIGURATION.md#legacy-and-development-only-settings).

## Historical interfaces

| Interface | Historical behavior |
| --- | --- |
| `/health` | Express readiness/configuration checks; no current Edge-wide equivalent |
| POST `/api/send` | API-key-authenticated transactional sending using `X-API-Key`; opt-outs remain enforced |
| `/webhooks/twilio/inbound`, `/webhooks/twilio/status` | Express provider callbacks; current callbacks use the signed Edge webhook |
| ElevenLabs webhook and calling routes | Retained Express integration; not interchangeable with Soni HMAC actions |
| Express WebSockets | Subprotocol tokens/origin validation; current browser refresh uses Supabase Realtime |

The current Edge `/crm-api/send` instead requires a CRM session, selected business and idempotency key, and creates **marketing-purpose** outbox work. Do not copy legacy curl examples into a new Edge integration. Use signed [business events](API_REFERENCE.md#provider-and-business-webhooks) for the implemented server-to-server booking/quote ingestion contract.

## Migration and worker caveats

The old multiple-business guard and missing isolation warnings apply to the Express foundation, not a claim that the current Edge implementation has no tenant isolation. Conversely, current canonical registry deployment still has explicit compatibility/cutover gates; see [staff CRM](STAFF_CRM.md).

`npm run worker:sms`, `worker:automation` and `worker:ai` run real consumers when supplied `WORKER_DATABASE_URL`. They are not required for static preview or current Edge operation. Avoid accidentally adding a competing consumer during migration work.

`db:assemble` only accepts the filename of a new empty migration created with the Supabase CLI. Its assembly inputs are historical SQL snapshots and may omit later replacements. Review the generated SQL against the latest definitions; never use it as a reset or whole-database reconstruction procedure. E2 shared migrations must stay in E2.
