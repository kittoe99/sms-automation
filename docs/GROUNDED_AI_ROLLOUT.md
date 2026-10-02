# Grounded SMS AI and Twilio registration

The migration `20260919010000_grounded_ai_knowledge.sql` is additive and leaves grounded AI, Edge dispatch, scheduling, and business sending disabled. Apply it before deploying the new functions.

## Runtime responsibilities

- `knowledge-worker` reads approved public HTTPS origins or tenant-prefixed private Storage objects. It creates an extracted draft and never changes the active version.
- `embedding-worker` embeds draft chunks in batches with `text-embedding-3-small` at 1,536 dimensions. Additional batches are queued until every chunk is complete.
- `ai-worker` performs tenant-scoped hybrid retrieval, asks for a strict structured response with `store:false`, validates evidence IDs, and uses a transparent handoff fallback.
- `handoff-worker` creates one deduplicated staff-alert outbox message. The CRM task remains durable if the alert fails.
- `compliance-worker` owns Twilio number purchase, status polling, reconciliation, sender/webhook verification, and activation-canary orchestration.
- `compliance-session` creates/resumes Twilio Compliance Embeddable sessions and returns the short-lived session token without storing it.

All provider writes have a before/after checkpoint. `submission_unknown` is terminal for automatic execution and must go through reconciliation.

## Required secrets

Configure `SMS_SENDER_DATABASE_URL`, `SMS_AUTOMATION_DATABASE_URL`, `SMS_AI_DATABASE_URL`, the eight worker bearer secrets listed in `.env.example`, `OPENAI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, Clerk settings, and the existing Twilio master provisioning credentials. Link each queue's bearer secret to `sms_private.edge_config.secret_id` before enabling that queue.

For per-tenant estimated cost reporting, set the four optional current-rate values in `.env.example`. Rates are configuration rather than hard-coded prices; if they are omitted, the dashboard reports token and segment usage and labels cost as unconfigured.

Twilio Compliance Embeddable access is an account-level prerequisite. The server integration is included; the returned `inquiryId` and `sessionToken` are intended for Twilio's `@twilio/twilio-compliance-embed` client. Sensitive legal answers go directly to Twilio and are not persisted by this application.

## Rollout

1. Apply the migration and deploy `knowledge-worker`, `embedding-worker`, `handoff-worker`, `compliance-worker`, and `compliance-session` alongside the existing functions.
2. Configure and verify the new scoped database URLs and worker tokens while every new `edge_config` row is disabled.
3. Backfill validation is automatic for completed business profiles. Review the active profile in AI knowledge.
4. Enable knowledge and embedding queues. Import sources, inspect extracted drafts, then explicitly approve each version.
5. Enable grounded AI with `shadowMode=true` for the canary automation group. Shadow runs record retrieval and validation but do not send replies, create leads, or alert staff.
6. Review the operations metrics and an evaluation set of at least 50 supported and 20 unsupported/adversarial questions. Require no cross-tenant retrieval or unsupported direct answer.
7. Set `shadowMode=false` for Opek only. Verify reply deduplication, lead/handoff deduplication, staff alert behavior, and p95 latency before adding another tenant.
8. Complete the appropriate Twilio branch, confirm every paid action, deliver the activation canary, and call activation only after readiness reports no reasons.

Rollback is independent: disable a business's grounded AI setting, individual Edge queues, compliance automation, or sending. Do not delete approved versions, job history, AI runs, or uncertain remote operations.
