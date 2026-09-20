# Supabase SMS deployment

The active backend runs entirely in WPacquisition (`wxamwhfmelxqahkdtcci`). Render is optional static frontend hosting only. No Render workers are required. The existing website tables and owner registration remain separate from `sms_*` CRM data.

## Execution

- `crm-api`: Clerk-authenticated admin API. Sending durably creates an outbox message and returns HTTP 202.
- `twilio-webhook`: validates Twilio signatures, records inbound SMS/delivery/call events and acknowledges without sending a reply.
- `business-events`: verifies business-specific HMAC credentials and persists booking/quote changes.
- `automation-worker`: at most 25 jobs per invocation, stops claiming after 35 seconds.
- `sms-worker`: at most five submissions per invocation, stops claiming after 40 seconds; each provider request has a 20-second timeout and no transport retries.
- `ai-worker`: one grounded Responses request plus tenant-scoped hybrid retrieval; strict output validation and a 40-second timeout; saves through the SMS outbox after checking its conversation generation.
- `provisioning-worker`: one durable provisioning job. Creating a CRM business automatically queues a dedicated Twilio subaccount and Messaging Service under the parent billing account. Provider mutations are checkpointed; uncertain operations require reconciliation. It never buys numbers, submits paid registration, or enables sending during business creation.
- `knowledge-worker` and `embedding-worker`: bounded draft extraction and 1,536-dimensional embedding batches. Imported data is never live before approval.
- `handoff-worker`: converts a durable handoff into one deduplicated staff-alert SMS job.
- `compliance-worker` and `compliance-session`: number search/purchase, embeddable registration, status polling, reconciliation, sender/webhook checks, and a delivered activation canary.

Workers authenticate using separate bearer secrets and use scoped database logins. Platform JWT verification is disabled because each endpoint performs its own Clerk, HMAC, Twilio-signature or worker-token verification. Requests with a missing/incorrect worker token cannot claim work.

Cron calls `sms_private.dispatch_edge()` every five seconds. It first performs bounded scheduling/lease recovery, then uses `pg_net` to wake consumers only for ready queues. Worker admission is capped by database slots (120-second expiry): SMS 4, automation 2, AI 2, provisioning 1 by default. Each queue has its own enable switch. Expired queue leases recover independently; an expired in-progress SMS submission becomes `submission_unknown`, never an automatic resend.

The scheduler batch is configurable (default 500 due enrollments per tick, maximum 5000). Concurrency is configurable per queue (1–64). These are safety settings, not measured throughput guarantees. Load-test database contention, callbacks, queue age, provider latency and peak traffic before raising limits. This deployment has not been validated for hundreds of thousands of simultaneously active businesses.

## Secrets

Run `node scripts/prepare-edge-secrets.js` after placing provider credentials in local `.env`. The ignored file `data/edge-secrets.env` contains scoped database URLs, existing Clerk settings, per-worker tokens, callback URLs and optional provider keys. Import it into WPacquisition Edge Function Secrets. Never commit `data/`, `.env` or generated secret SQL.

AI additionally requires `OPENAI_API_KEY`; its configured generation model is `gpt-5.4-mini-2026-03-17` and its embedding model is `text-embedding-3-small`. AI stays disabled while that key is missing. Provisioning uses the existing Twilio master credential only in the provisioning handler. Business SMS submissions and compliance operations retrieve tenant-specific credentials from Vault and never inherit the master sender.

The OpenAI key is configured in WPacquisition and the AI queue is enabled. Individual business AI settings remain opt-in.

Supabase project secrets are shared across functions in the same project. Separate database roles restrict normal code paths; they do not provide a hard security boundary against a compromised sibling function reading another role's environment variable. Stronger runtime isolation requires separate projects or external compute.

Worker bearer secrets must match the Vault secrets referenced by `sms_private.edge_config.secret_id`. Rotation must update both locations. Do not output their values in logs.

Each business can designate one enabled AI setting as its default inbound profile. The webhook prefers an enabled setting for the contact's active automation enrollment, then falls back to that business default. This lets the AI answer inbound texts without enrolling the contact in a marketing sequence. STOP/opt-out state, a paused thread, stale conversation generations, and disabled business sending still block replies. Generated text always enters `sms_send_jobs`; the webhook and AI worker never submit directly to Twilio.

## Clerk and frontend

Approved CRM administrator: `kofikittoe35@gmail.com`, Clerk subject `user_3Il5aqL9gpjc9z02DA6HoBWt2zL`. Existing Clerk application is WPS Canvas, development instance. Its native Supabase integration and WPacquisition third-party Clerk connection are enabled. Admin login and the local dashboard were verified, including the delivered canary and Live indicator. Production launch still requires a production Clerk instance and correct allowed frontend origins. Creating a CRM business requires no owner registration.

Build the static frontend with `CRM_API_BASE`, `SUPABASE_URL` and the public `SUPABASE_PUBLISHABLE_KEY`, using `npm run build:frontend`. The API base is `https://wxamwhfmelxqahkdtcci.supabase.co/functions/v1/crm-api`. `render.yaml` contains only the optional static site. The local legacy Express server is a disconnected preview and refuses production startup.

## Rollout and controls

1. Apply additive migrations in order; already-applied files are immutable. `db:assemble` now requires the filename of a new empty migration created by the Supabase CLI.
2. Import existing business definitions with sending disabled. Never import website contacts as SMS consent.
3. Deploy all functions with the repository import map; configure secrets, Clerk and frontend origins. Follow `GROUNDED_AI_ROLLOUT.md` for the new queues and canary sequence.
4. Verify worker tokens reject unauthorized requests and authorized idle requests return a paused/empty result without sending. Test valid/invalid webhooks with mocked providers.
5. Disable the former DigitalOcean scheduler before enabling this one. Configure Twilio callbacks only during controlled cutover.
6. Enable selected `edge_config` queues and `runtime.edge_enabled` after endpoint verification. Enable `runtime.scheduler_enabled` and one configured business only for an explicitly approved canary recipient.
7. Verify outbound delivery, inbound replies, STOP, schedules and outage recovery before enabling additional businesses.

Rollback: set `runtime.edge_enabled=false`, `runtime.scheduler_enabled=false` and disable business sending. A submission already accepted by Twilio cannot be recalled. Keep the ledger and reconcile uncertainty; never replay accepted jobs.

The operational panel shows scheduler state, heartbeats, job counts and actionable failures. Empty queues do not wake workers, so an old worker heartbeat while idle is not itself an outage. Monitor queue age and progress alongside heartbeats. PostgreSQL queue durability remains authoritative even if a pg_net wake request is lost; the next Cron tick can wake another bounded consumer.

## Validation

`npm test`, `npm run test:workers`, Deno checks for all entrypoints, frontend build, and dependency audit. SQL regression tests use PGlite with queue/Vault/Cron/HTTP test doubles; live smoke tests verify the actual scoped roles and deployed functions. Mocked-provider tests do not prove live delivery or peak capacity.

Live cutover verified 2026-09-18 UTC. One AI job produced an SMS outbox record; Cron dispatched the SMS worker; Twilio accepted one submission and signed callbacks recorded `sent`, late `queued`, then `delivered` without status regression. Message ID: `4a0e6cf6-5476-4f25-89d1-310a7c818619`.

Twilio's Messaging Service now routes inbound and status webhooks to WPacquisition Edge Functions. A bad signature returned 403; a signed inbound event persisted; replaying the same SID remained idempotent; and signed STOP suppressed the contact, recorded consent evidence, and left no pending work. The obsolete DigitalOcean hostname no longer resolves. Opek is active with sending and Supabase scheduling enabled; Bello Moving remains pending and disabled. The test recipient remains opted out after the STOP verification, the deployment-canary AI setting remains disabled, and there are no active enrollments, failed jobs, or uncertain submissions at cutover.

Default inbound AI was enabled for Opek on 2026-09-18 UTC using the Quote follow-up instructions as its business fallback. The test recipient's thread was unpaused, but its STOP suppression remains intact; it must send START before a later inbound message can receive an AI response.
