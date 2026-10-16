# Grounded SMS AI and Twilio registration

The new default-off [Inbound AI agent](INBOUND_AI.md) supersedes the generation
path below for `sms-agent-v1` jobs only. It uses GPT 6.1 Sol and five narrow tools.
Older AI jobs remain disabled; knowledge approval and embedding workflows remain.
The inbound backend/frontend were released October 10 and Opek was enabled in
shadow; live activation still requires the documented pilot gate. These are
recorded release observations, not a fresh live inspection. The legacy generation
instructions below are historical; use [Inbound AI](INBOUND_AI.md) for current settings.

The original additive migration `20260919010000_grounded_ai_knowledge.sql` seeded
grounded AI, dispatch, scheduling and business sending disabled. Later migrations
extend this implementation. For an existing deployment, reconcile applied history
before deploying a change; do not reapply the original rollout wholesale. Current
runtime/configuration references are [architecture](ARCHITECTURE.md) and
[configuration](CONFIGURATION.md); prior release observations are in the
[project record](../PROJECT_RECORD.md).

## Runtime responsibilities

- `knowledge-worker` reads approved public HTTPS origins or tenant-prefixed private Storage objects. It creates an extracted draft and never changes the active version.
- `embedding-worker` embeds draft chunks in batches with `text-embedding-3-small` at 1,536 dimensions. Additional batches are queued until every chunk is complete.
- `ai-worker` performs tenant-scoped hybrid retrieval, asks for a strict structured response with `store:false`, validates evidence IDs, and uses a transparent handoff fallback.
- `handoff-worker` creates one deduplicated staff-alert outbox message. The CRM task remains durable if the alert fails.
- `compliance-worker` owns Twilio number purchase, status polling, reconciliation, sender/webhook verification, and activation-canary orchestration.
- `compliance-session` creates/resumes Twilio Compliance Embeddable sessions and returns the short-lived session token without storing it.

All provider writes have a before/after checkpoint. `submission_unknown` is terminal for automatic execution and must go through reconciliation.

## Source fetching and job limits

Website enrichment and knowledge ingestion share `src/lib/publicHttps.js`.
It accepts public HTTPS on port 443, rejects credentials and private/reserved
addresses (including IPv4-mapped IPv6), and validates every redirect. The crawler
also keeps every page and redirect on the source origin. The production transport
connects directly to the validated IP while retaining the original TLS certificate
identity, SNI and HTTP Host; it does not let `fetch` resolve the hostname again.
There is no fallback to an unpinned transport. `node:https` must be supported by
the runtime. The transport requests identity encoding and rejects servers that
return compressed bodies despite that request.

Each source request has a 12-second deadline including DNS, headers and streaming
body reads. Streaming byte limits are 1.5 MB for enrichment, 2 MiB per crawled page
and 10 MiB for a private knowledge file. Enrichment's Firecrawl call has a 25-second
limit and a bounded 2 MiB JSON response; the entire enrichment operation has a
30-second budget. Storage downloads never follow redirects with service credentials.

Knowledge reads and asynchronous document extraction share a 30-second deadline
across all five crawl pages or one file. Expiry aborts network/body work, prevents
late extraction results from completing the job and lets the existing runner
schedule a retry and release its slot. Completion has the existing database
statement timeout; the work budget leaves room before the 40-second knowledge
batch budget and 120-second lease/slot expiry. Byte and extracted-text limits are
also enforced. Supabase Edge does not support Web Workers, so JavaScript timers
cannot interrupt synchronous parser CPU; its platform CPU/memory limits remain
the final bound. CPU-heavy document extraction belongs in an isolated parser
service if it becomes a frequent workload. No provider SMS retry behavior changes.

These are local implementation guarantees. Before releasing, run the network and
knowledge regression tests and a controlled public-HTTPS import in the target Edge
runtime to verify its Node TLS compatibility. No production source imports or
deployments were performed during this hardening work.

## Required secrets

Configure `SMS_SENDER_DATABASE_URL`, `SMS_AUTOMATION_DATABASE_URL`, `SMS_AI_DATABASE_URL`, the eight worker bearer secrets listed in `.env.example`, `OPENAI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, Clerk settings, and the existing Twilio master provisioning credentials. Link each queue's bearer secret to `sms_private.edge_config.secret_id` before enabling that queue.

For per-tenant estimated costs, set the four optional rate values in `.env.example`
from separately verified provider rates. The runtime treats these as estimates;
it does not fetch pricing. The secret-preparation helper fills fixed AI defaults,
so an omitted local value does not necessarily leave the generated deployment
unconfigured. Review generated settings privately before importing.

Twilio Compliance Embeddable access is an account-level prerequisite. The server integration is included; the returned `inquiryId` and `sessionToken` are intended for Twilio's `@twilio/twilio-compliance-embed` client. Sensitive legal answers go directly to Twilio and are not persisted by this application.

## Rollout

1. Confirm the required migration definitions are already applied or apply only the intended new additive change; deploy the affected knowledge, embedding, handoff, compliance or session functions with their dependencies.
2. Configure and verify the new scoped database URLs and worker tokens while every new `edge_config` row is disabled.
3. Backfill validation is automatic for completed business profiles. Review the active profile in AI knowledge.
4. Enable knowledge and embedding queues. Import sources, inspect extracted drafts, then explicitly approve each version.
5. Enable grounded AI with `shadowMode=true` for the canary automation group. Shadow runs record retrieval and validation but do not send replies, create leads, or alert staff.
6. Review the operations metrics and an evaluation set of at least 50 supported and 20 unsupported/adversarial questions. Require no cross-tenant retrieval or unsupported direct answer.
7. Set `shadowMode=false` for Opek only. Verify reply deduplication, lead/handoff deduplication, staff alert behavior, and p95 latency before adding another tenant.
8. Complete the appropriate Twilio branch, confirm every paid action, deliver the activation canary, and call activation only after readiness reports no reasons.

Rollback is independent: disable a business's grounded AI setting, individual Edge queues, compliance automation, or sending. Do not delete approved versions, job history, AI runs, or uncertain remote operations.

## Knowledge and active SMS AI MCP — October 16, 2026 (local)

Stage 5 adds twelve tools and nine independent grants. Local catalog: 103 tools /
72 permissions. Source/version reads are scoped and bounded, with explicit IDs and
paginated extracted text. Manual text is untrusted content. Creation queues indexing;
refresh, archive and version approval are independent and revision protected.
Duplicate origins conflict instead of overwriting. Shared triggers fence browser,
worker and MCP changes. Archive rejects in-flight indexing, cancels pending jobs,
and audits affected versions/jobs; archived knowledge cannot be resurrected by a
stale worker. Structured profile knowledge stays in the profile-review workflow.

Private file uploads use a committed upload intent and a 60-second, one-use adapter
ticket. The restricted database login can mint tickets only for its own authorized
intent; CRM Edge consumes them after rechecking identity, grants and business scope.
Storage credentials remain in Edge. Signed upload URLs are ephemeral responses,
never audit or retry-receipt content. Storage URLs expire after two hours and do not
permit overwrite; uploaded size/MIME must match the intent before indexing. Intent
expiry is 24 hours. Lost signing responses recover the same intent with the same
idempotency key and a fresh URL. No OAuth token is forwarded as a browser session.

AI reads do not insert defaults. Instruction edits preserve mode/booking activation;
activation is separately granted and retains canonical pilot, reviewed-profile and
live-validation prerequisites. No tool sets the private validation flag or queues
an SMS. AI instruction content is excluded from mutation receipts and audit.

Local CRM 651 passed / 29 existing skips; paired 63; relevant E2 15; both project
checks and frontend/66-file Edge bundle pass. Real PostgreSQL concurrency covers
same-key indexing/settings retries, worker lock/revision conflicts, archive versus
refresh, interrupted transactions and one-use upload races. Migration 20261016200143
is reconciled against 141 entries and rollback-rehearsed, not yet applied. Release
order: migration, CRM Edge adapter, MCP environment/service, frontend. No E2 runtime
release required. Live smoke checks use only reads and existing previews.
