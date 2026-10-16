# Supabase SMS deployment

The active backend runs entirely in WPacquisition (`wxamwhfmelxqahkdtcci`). Render is optional static frontend hosting only. No Render workers are required. The existing website tables and owner registration remain separate from `sms_*` CRM data.

For configuration names and helper limitations, read [configuration](CONFIGURATION.md).
For local preview and tests, read [development](DEVELOPMENT.md). Prior deployment
observations are summarized in the [project record](../PROJECT_RECORD.md); the
steps below are procedures, not evidence of a new deployment.

The [October 14 hardening release](HARDENING_RELEASE.md#migration-ownership-and-release-order)
is locally implemented and lists all five owning forward migrations across CRM
and E2. Use that inventory and the [main E2 release guide](../../E2local-main/docs/reliability-release.md)
instead of applying an earlier partial list. Reconcile destination history before
applying only missing owning migrations. Drain old hosting mutation invocations
before the operation-guard migration and release the matching E2 API before
reopening changes. Release the new E2 site-detail API before the CRM frontend.
This review did not apply migrations, deploy functions or change live controls.

## Execution

- `crm-api`: Clerk-authenticated admin API. Sending durably creates an outbox message and returns HTTP 202.
- `twilio-webhook`: validates Twilio signatures, records inbound SMS/delivery/call events and acknowledges without sending a reply.
- `business-events`: verifies business-specific HMAC credentials and persists booking/quote changes.
- `web-form`: public form configuration/submission, optional E2 attribution, and email unsubscribe with a scoped database role.
- `email-worker` and `email-webhook`: independent email job processing and signed Resend delivery/suppression events; see [email rollout](EMAIL_AUTOMATIONS.md).
- `voice-agent` and `soni-voice-inbound`: Opek's HMAC CRM bridge and signed Twilio inbound SIP route; see [voice setup](SONI_VOICE_BRIDGE.md).
- `automation-worker`: at most 25 jobs per invocation, stops claiming after 35 seconds.
- `sms-worker`: at most five submissions per invocation, stops claiming after 40 seconds; each provider request has a 20-second timeout and no transport retries.
- `ai-worker`: new `sms-agent-v1` jobs use GPT 6.1 Sol Responses with four requests, three tools and a 35-second run deadline. Eligibility is checked again for tool mutations, outbox creation and SMS submission. Legacy AI jobs remain disabled. See [Inbound AI rollout](INBOUND_AI.md).
- `provisioning-worker`: one durable provisioning job. Explicit Add SMS after owner-linked registration and profile review queues a dedicated Twilio subaccount and Messaging Service under the parent billing account. Provider mutations are checkpointed; uncertain operations require reconciliation. It never buys numbers, submits paid registration, or enables sending during business creation.
- `knowledge-worker` and `embedding-worker`: bounded draft extraction and 1,536-dimensional embedding batches. Imported data is never live before approval.
- `handoff-worker`: converts a durable handoff into one deduplicated staff-alert SMS job.
- `compliance-worker` and `compliance-session`: number search/purchase, embeddable registration, status polling, reconciliation, sender/webhook checks, and a delivered activation canary.

Workers authenticate using separate bearer secrets and use scoped database logins. Platform JWT verification is disabled because each endpoint performs its own Clerk, HMAC, Twilio-signature or worker-token verification. Requests with a missing/incorrect worker token cannot claim work.

Email shares `AUTOMATION_WORKER_SECRET` and uses a separate once-per-minute
dispatcher and claim loop (five jobs, 20-second claim budget), sharing the
automation admission budget. Public forms use
validation/rate controls rather than a login. The other claim-loop budgets above
do not include the completion time of a job already started. See the complete
[worker inventory](ARCHITECTURE.md#worker-inventory).

Cron calls `sms_private.dispatch_edge()` every five seconds. It first performs bounded scheduling/lease recovery, then uses `pg_net` to wake consumers only for ready queues. Worker admission is capped by database slots (120-second expiry): SMS 4, automation 2, AI 2, provisioning 1 by default. Each queue has its own enable switch. Expired queue leases recover independently; an expired in-progress SMS submission becomes `submission_unknown`, never an automatic resend.

The scheduler batch is configurable (default 500 due enrollments per tick, maximum 5000). Concurrency is configurable per queue (1–64). These are safety settings, not measured throughput guarantees. Load-test database contention, callbacks, queue age, provider latency and peak traffic before raising limits. This deployment has not been validated for hundreds of thousands of simultaneously active businesses.

The hardening migration bounds email recovery and rotates tenant admission.
Scheduler cursors advance past ineligible due records instead of repeatedly
scanning the same prefix. Email attempts outside the safe provider-idempotency
window become uncertain rather than automatically resending. These controls
reduce starvation but do not guarantee equal throughput across provider
workloads. Review queue age and tenant progress under representative load before
changing limits. The activity projection's initial backfill is a one-time
migration operation whose duration must also be assessed on the target dataset.

## Secrets

Run `node scripts/prepare-edge-secrets.js` after placing provider credentials in local `.env`. The ignored file `data/edge-secrets.env` contains scoped database URLs, existing Clerk settings, per-worker tokens, callback URLs and optional provider keys. Import it into WPacquisition Edge Function Secrets. Never commit `data/`, `.env` or generated secret SQL.

The helper requires existing `data/worker-credentials.env`, preserves prior Edge
secrets and copies only an allowlist from `.env`; it does not configure every
function automatically. Voice credentials and optional enrichment settings need
separate handling. It also writes fixed model/callback values and fills AI cost
defaults. Review the [helper behavior](CONFIGURATION.md#operator-helpers-and-generated-files)
before importing; do not rerun bootstrap scripts to regenerate existing roles.

AI additionally requires server-side `OPENAI_API_KEY`. The new inbound model is pinned to `gpt-6.1-sol`; knowledge embeddings still use `text-embedding-3-small`. New inbound settings default off. Keep them off until credentials, deployment and shadow validation pass. Provisioning uses the existing Twilio master credential only in the provisioning handler. Business SMS submissions and compliance operations retrieve tenant-specific credentials from Vault and never inherit the master sender.

Earlier deployment notes recorded an OpenAI key and enabled AI queue in
WPacquisition. That state was not rechecked during documentation reconciliation;
inspect the intended environment before a rollout. Individual business AI
settings remain opt-in.

SMS automation uses published form/direct templates and the current run gates;
no OpenAI key or group prompt is required to render those SMS templates. Email
still uses its separate group instructions and provider configuration. The
Inbound AI agent has independent model, shadow/live and validation controls.
See [forms](FORM_AUTOMATIONS.md), [direct sequences](DIRECT_CONTACT_AUTOMATIONS.md)
and [Inbound AI](INBOUND_AI.md).

Supabase project secrets are shared across functions in the same project. Separate database roles restrict normal code paths; they do not provide a hard security boundary against a compromised sibling function reading another role's environment variable. Stronger runtime isolation requires separate projects or external compute.

Worker bearer secrets must match the Vault secrets referenced by `sms_private.edge_config.secret_id`. Rotation must update both locations. Do not output their values in logs.

The old group-default inbound AI selection is retired. Use the business's
revision-checked `/inbound-ai` settings. Legacy AI jobs remain rejected; current
agent replies enter the durable SMS outbox and recheck eligibility before send.

## Clerk and frontend

CRM uses the independent issuer `https://clerk.crm.e2local.com`; E2 retains
`https://clerk.e2local.com`. A historical reset removed previous identities and
grants, followed by a recorded explicit bootstrap of one fresh CRM administrator.
Do not repeat that bootstrap as routine deployment or reuse an old subject/email
as authority. Additional staff need explicit issuer-qualified grants; recovery is
described in [staff CRM](STAFF_CRM.md#restore-staff-access-to-a-fresh-account).
The release record names dedicated secrets/origins, CRM API version 35 and
compliance-session version 10, with worker/public-form credentials unchanged.
Current registration requires a completed customer owner account. Business creation alone creates no provider job; explicit Add SMS or an existing-sender connection is required. The version numbers above describe the historical login release, not the latest CRM API.

Build the static frontend with a public `SUPABASE_PUBLISHABLE_KEY` using
`npm run build:frontend`. `CRM_ENVIRONMENT` defaults to `production`, whose
reviewed manifest supplies CRM, Supabase, hosting and embed destinations.
Destination overrides must match that manifest. The builder replaces only its
own generated `dist/` after validating configuration. `render.yaml` contains the
optional static site and generated security headers. Run
`npm run headers:generate` after inline-script or reviewed policy changes, then
`npm run check`. Verify actual hosted CSP, framing, permissions and login/provider
flows before calling the release verified. The legacy Express server refuses
production startup.

## Web Forms deployment

For an initial installation, the original form schema starts with
`20260923060000_web_form_submissions.sql` followed by
`20260923070000_web_form_builder.sql`; later migrations extend it. For the shared
existing deployment, first reconcile applied history and deploy only missing
intended changes. The original builder migration seeded forms for existing businesses. Current
form-first businesses create named forms explicitly; legacy type routes resolve
only retained original forms. For first-time role setup, run
`node scripts/bootstrap-web-form-role.js` with `MIGRATION_DATABASE_URL` set. It
creates a dedicated login that inherits only the `sms_form_public` RPC grants and
writes its URL to ignored `data/web-form-credentials.env`. Run
`node scripts/prepare-edge-secrets.js` to include `WEB_FORM_DATABASE_URL` and a
random `WEB_FORM_IP_HASH_KEY` in `data/edge-secrets.env`; import the updated file
into Supabase Edge Function Secrets. Deploy the `web-form` function with JWT
verification disabled, since the public endpoint uses its scoped database role.
The `crm-api` function must also be redeployed for the authenticated builder
routes. Do not put the scoped URL or hash key into the frontend configuration.

The reviewed frontend manifest sets the public HTTPS origin serving `embed.html`
and `embed-resize.js`; any `PUBLIC_FORM_BASE_URL` override in Render must match it.
Form Builder copies an iframe snippet that can be pasted into any
test website. The public Edge endpoint uses wildcard CORS; `CRM_ALLOWED_ORIGINS`
still applies to the dashboard API. The public function accepts at most 16 KiB
of JSON, uses a honeypot, and atomically counts 10 attempts per 10-minute form/IP
bucket and 100 per-hour form bucket. A daily job removes expired buckets.

## Rollout and controls

1. Reconcile applied history and E2-owned aliases, then apply only the intended new forward migrations; already-applied files are immutable. `db:assemble` is retired and refuses to run. Maintained queue/reporting definitions live under `supabase/sql/current/`, separately from the one-time schema/trigger/backfill inputs. Validate their relationship with `node scripts/check-current-sql.js`; never run the bootstrap files as routine setup.
2. Import existing business definitions with sending disabled. Never import website contacts as SMS consent.
3. Package affected functions with the repository import map and complete dependency graph; configure secrets, Clerk and frontend origins. For this release, deploy the E2 hosting detail API before the CRM frontend. Follow the owning feature guide for migration, queue and pilot gates; `GROUNDED_AI_ROLLOUT.md` retains the older knowledge rollout.
4. Verify worker tokens reject unauthorized requests. Establish paused/empty controlled conditions before authorized worker calls: a valid request can process real jobs. Test valid/invalid webhooks with mocked providers. `smoke-edge.js` is a live worker invoker, not an offline readiness check.
5. Disable the former DigitalOcean scheduler before enabling this one. Configure Twilio callbacks only during controlled cutover.
6. Enable selected `edge_config` queues and `runtime.edge_enabled` after endpoint verification. Enable `runtime.scheduler_enabled` and one configured business only for an explicitly approved canary recipient.
7. Verify outbound delivery, inbound replies, STOP, schedules and outage recovery before enabling additional businesses.

SMS rollback: set `runtime.edge_enabled=false`, `runtime.scheduler_enabled=false` and disable business sending. Email has its own dispatcher/settings and requires separate controls when affected. A submission already accepted by Twilio cannot be recalled. Keep the ledger and reconcile uncertainty; never replay accepted jobs. See [operations](OPERATIONS.md#rollback-and-credential-rotation).

The operational panel shows scheduler state, heartbeats, job counts and actionable failures. Empty queues do not wake workers, so an old worker heartbeat while idle is not itself an outage. Monitor queue age and progress alongside heartbeats. PostgreSQL queue durability remains authoritative even if a pg_net wake request is lost; the next Cron tick can wake another bounded consumer.

Heartbeats are normalized per queue and old entries are pruned in bounded
batches. The panel's “queues recently active” count does not measure active
connections or process concurrency. Reporting reads are tenant-scoped; use
authorized database monitoring for shared resource capacity.

## Additional Voice deployment components

Deploy `voice-lookup`, `voice-booking`, `voice-runtime` and `voice-maintenance`
with their separate roles/secrets and flags. Maintenance uses its own Vault-backed
cron bearer, not the generic worker dispatcher. Bootstrap is first-install only.
Use [Voice CRM](VOICE_CRM.md), [Customer Voice](CUSTOMER_VOICE.md),
[booking availability](BOOKING_AVAILABILITY.md), and the complete
[configuration reference](CONFIGURATION.md#voice-configuration).

## Validation

Use `npm run verify:release` with the reviewed E2 checkout and public frontend
key for offline source/header/SQL checks, CRM and selected paired tests, frontend
build and secret-free Edge packaging. `npm run test:workers` is a focused test
alternative. The manually triggered paired CI workflow requires an exact E2 SHA
and private repository read access; it never deploys.

`node scripts/prepare-edge-deployment.js --bundle-only` packages the full allowed
relative import graph without reading Edge secrets or writing Vault SQL. The
ordinary mode remains an operator helper using existing secret files; its Vault
SQL initializes missing references and is not a rotation procedure.

Run Deno checks for all affected entrypoints and verify the public HTTPS
connection-pinning transport in the hosted runtime. SQL regression tests use
PGlite with queue/Vault/Cron/HTTP test doubles; inspect real PostgreSQL plans and
concurrency separately. Hosted tests must verify scoped roles, static headers,
Clerk/Persona, Realtime, media, uploads and public embeds. Mocked providers do not
prove live delivery or peak capacity. Follow the [hardening release gates](HARDENING_RELEASE.md)
and record only checks actually performed.

## Historical September 18 cutover evidence

The following observations are historical. Inbound behavior was replaced by the
form-first rollout and later gated inbound agent; do not use these paragraphs
as current activation instructions.

Cutover verification, September 18, 2026 UTC: one AI job produced an
outbox record, Cron dispatched the SMS worker, and signed callbacks recorded
`sent`, late `queued`, then `delivered` without regression. This is prior test
evidence, not a current environment health check.

Twilio's Messaging Service now routes inbound and status webhooks to WPacquisition Edge Functions. A bad signature returned 403; a signed inbound event persisted; replaying the same SID remained idempotent; and signed STOP suppressed the contact, recorded consent evidence, and left no pending work. The obsolete DigitalOcean hostname no longer resolves. Opek is active with sending and Supabase scheduling enabled; Bello Moving remains pending and disabled. The test recipient remains opted out after the STOP verification, the deployment-canary AI setting remains disabled, and there are no active enrollments, failed jobs, or uncertain submissions at cutover.

Default inbound AI was enabled for Opek on 2026-09-18 UTC using the Quote follow-up instructions as its business fallback. The test recipient's thread was unpaused, but its STOP suppression remains intact; it must send START before a later inbound message can receive an AI response.

## MCP knowledge upload adapter

Deploy the CRM-owned knowledge MCP migration before updating `crm-api`. Configure
`MCP_KNOWLEDGE_ADAPTER_URL` on the MCP service to the trusted HTTPS
`/functions/v1/crm-api/mcp/knowledge-upload` endpoint. No storage secret belongs in
the MCP environment. The endpoint accepts only a one-use database-authorized ticket;
ordinary CRM authentication and OAuth tokens cannot authorize it. Supabase signed
upload URLs expire after two hours and prohibit overwrite. See [the storage
contract](https://supabase.com/docs/reference/javascript/storage-from-createsigneduploadurl).
An unavailable signer leaves the committed intent recoverable with the same retry
key. Production release smoke checks must not prepare uploads or index sources.
