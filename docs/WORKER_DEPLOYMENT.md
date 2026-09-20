# Supabase queue + Render worker deployment

WPacquisition (`wxamwhfmelxqahkdtcci`) owns Postgres, PGMQ, Cron, the authenticated API, and webhooks. Render background workers are the primary long-running queue consumers. The existing website tables and owner registration remain separate from `sms_*` CRM data.

## Execution

- `crm-api`: Clerk-authenticated admin API. Sending durably creates an outbox message and returns HTTP 202.
- `twilio-webhook`: validates Twilio signatures, records inbound SMS/delivery/call events and acknowledges without sending a reply.
- `business-events`: verifies business-specific HMAC credentials and persists booking/quote changes.
- `wpacquisition-automation`: three Standard instances with concurrency 32. It renders saved templates only and never loads conversation history or calls OpenAI.
- `wpacquisition-sms`: five Standard instances with concurrency 32; each provider request has a 20-second timeout and no transport retries.
- `wpacquisition-inbound-ai`: two Standard instances with concurrency 8 for contact-aware inbound replies.
- `wpacquisition-automation-drafts`: one Standard instance with concurrency 2. A single structured Responses request generates a complete sequence for dashboard review.
- `wpacquisition-support-jobs`: low-volume provisioning, compliance, handoff, knowledge-ingestion, and embedding queues.
- `provisioning-worker`: one durable provisioning job. Creating a CRM business automatically queues a dedicated Twilio subaccount and Messaging Service under the parent billing account. Provider mutations are checkpointed; uncertain operations require reconciliation. It never buys numbers, submits paid registration, or enables sending during business creation.
- `knowledge-worker` and `embedding-worker`: bounded draft extraction and 1,536-dimensional embedding batches. Imported data is never live before approval.
- `handoff-worker`: converts a durable handoff into one deduplicated staff-alert SMS job.
- `compliance-worker` and `compliance-session`: number search/purchase, embeddable registration, status polling, reconciliation, sender/webhook checks, and a delivered activation canary.

Workers authenticate using separate bearer secrets and use scoped database logins. Platform JWT verification is disabled because each endpoint performs its own Clerk, HMAC, Twilio-signature or worker-token verification. Requests with a missing/incorrect worker token cannot claim work.

Cron calls `sms_private.dispatch_edge()` every five seconds. It performs set-based, tenant-fair scheduling and lease recovery first. After a Render queue passes cutover, disable that queue in `sms_private.edge_config`; keep the Edge implementation deployed but disabled as an emergency fallback. Expired queue leases recover independently; an expired in-progress SMS submission becomes `submission_unknown`, never an automatic resend.

Set `scheduler_batch_size` to at most 5,000. Every Render worker uses Supavisor transaction pooling, a maximum pool of 12 database connections, 30-second lease renewal, and a 120-second graceful shutdown. The capacity target is 20,000 businesses and two million automated texts/day, but the 300 jobs/second acceptance target must pass the load test before production rollout.

## Secrets

Run `node scripts/prepare-edge-secrets.js` after placing provider credentials in local `.env`. The ignored file `data/edge-secrets.env` contains scoped database URLs, existing Clerk settings, per-worker tokens, callback URLs and optional provider keys. Import it into WPacquisition Edge Function Secrets. Never commit `data/`, `.env` or generated secret SQL.

Inbound AI and automation drafting require `OPENAI_API_KEY`. `AUTOMATION_DRAFT_MODEL` selects the small structured-output model; the drafting worker generates the whole sequence in one call and records tokens and estimated cost. Scheduled sends and appointment reminders do not need the OpenAI key. Provisioning uses the existing Twilio master credential only in the provisioning handler. Business SMS submissions and compliance operations retrieve tenant-specific credentials from Vault and never inherit the master sender.

The OpenAI key is configured in WPacquisition and the AI queue is enabled. Individual business AI settings remain opt-in.

Supabase project secrets are shared across functions in the same project. Separate database roles restrict normal code paths; they do not provide a hard security boundary against a compromised sibling function reading another role's environment variable. Stronger runtime isolation requires separate projects or external compute.

Worker bearer secrets must match the Vault secrets referenced by `sms_private.edge_config.secret_id`. Rotation must update both locations. Do not output their values in logs.

Each business can designate one enabled AI setting as its default inbound profile. The webhook prefers an enabled setting for the contact's active automation enrollment, then falls back to that business default. This lets the AI answer inbound texts without enrolling the contact in a marketing sequence. STOP/opt-out state, a paused thread, stale conversation generations, and disabled business sending still block replies. Generated text always enters `sms_send_jobs`; the webhook and AI worker never submit directly to Twilio.

## Clerk and frontend

Approved CRM administrator: `kofikittoe35@gmail.com`, Clerk subject `user_3Il5aqL9gpjc9z02DA6HoBWt2zL`. Existing Clerk application is WPS Canvas, development instance. Its native Supabase integration and WPacquisition third-party Clerk connection are enabled. Admin login and the local dashboard were verified, including the delivered canary and Live indicator. Production launch still requires a production Clerk instance and correct allowed frontend origins. Creating a CRM business requires no owner registration.

Build the static frontend with `CRM_API_BASE`, `SUPABASE_URL` and the public `SUPABASE_PUBLISHABLE_KEY`, using `npm run build:frontend`. The API base is `https://wxamwhfmelxqahkdtcci.supabase.co/functions/v1/crm-api`. `render.yaml` defines the static site plus the five worker services. Configure each `WORKER_DATABASE_URL` with the queue-specific scoped role through Supavisor's transaction pool.

## Rollout and controls

1. Apply additive migrations in order; already-applied files are immutable. `db:assemble` now requires the filename of a new empty migration created by the Supabase CLI.
2. Import existing business definitions with sending disabled. Never import website contacts as SMS consent.
3. Deploy the API/dashboard and the draft worker first. Confirm generation, polling, review, edit, quota, and save behavior.
4. Migrate existing automations in place; the migration preserves saved messages, removes `aiDraft`, and marks delivery deterministic.
5. Cut over Render workers one queue at a time: drafting, automation, SMS, then inbound AI. For each queue, verify fresh heartbeats and draining before disabling its Edge dispatcher.
6. Canary internal businesses, then 1%, 10%, 50%, and 100% of tenants. Do not advance while oldest scheduled-send age exceeds one minute or any duplicate/unknown submission is unexplained.
7. Load-test 300 automation/SMS jobs per second for 15 minutes and require no loss/duplicates and p95 scheduled-to-Twilio acceptance under five minutes.

Rollback a consumer by stopping its Render service and re-enabling only its matching Edge queue. To stop all new work, set `runtime.scheduler_enabled=false` and disable business sending. A submission already accepted by Twilio cannot be recalled. Keep the ledger and reconcile uncertainty; never replay accepted jobs.

The operational panel shows scheduler state, heartbeats, job counts and actionable failures. Empty queues do not wake workers, so an old worker heartbeat while idle is not itself an outage. Monitor queue age and progress alongside heartbeats. PostgreSQL queue durability remains authoritative even if a pg_net wake request is lost; the next Cron tick can wake another bounded consumer.

## Validation

`npm test`, `npm run test:workers`, Deno checks for all entrypoints, frontend build, and dependency audit. SQL regression tests use PGlite with queue/Vault/Cron/HTTP test doubles; live smoke tests verify the actual scoped roles and deployed functions. Mocked-provider tests do not prove live delivery or peak capacity.

Live cutover verified 2026-09-18 UTC. One AI job produced an SMS outbox record; Cron dispatched the SMS worker; Twilio accepted one submission and signed callbacks recorded `sent`, late `queued`, then `delivered` without status regression. Message ID: `4a0e6cf6-5476-4f25-89d1-310a7c818619`.

Twilio's Messaging Service now routes inbound and status webhooks to WPacquisition Edge Functions. A bad signature returned 403; a signed inbound event persisted; replaying the same SID remained idempotent; and signed STOP suppressed the contact, recorded consent evidence, and left no pending work. The obsolete DigitalOcean hostname no longer resolves. Opek is active with sending and Supabase scheduling enabled; Bello Moving remains pending and disabled. The test recipient remains opted out after the STOP verification, the deployment-canary AI setting remains disabled, and there are no active enrollments, failed jobs, or uncertain submissions at cutover.

Default inbound AI was enabled for Opek on 2026-09-18 UTC using the Quote follow-up instructions as its business fallback. The test recipient's thread was unpaused, but its STOP suppression remains intact; it must send START before a later inbound message can receive an AI response.
