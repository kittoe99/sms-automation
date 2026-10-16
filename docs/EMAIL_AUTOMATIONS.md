# Email automation rollout

Open **Follow-ups → Email**. Email retains its existing independent groups,
consent rules and send controls.

## Queue hardening — local, not released

CRM migration `20261014061007_queue_reporting_hardening.sql` and the updated
`email-worker` address recovery, send windows and shared worker admission. Apply
only this forward migration after reconciling the paired baseline; deploy the
worker with its new `handler.js` afterward. No provider sends or migrations were
performed as part of the local implementation.

Expired leases recover from both the regular scheduler and the email dispatcher,
even when no pending email exists. Terminal jobs pause only the matching current
enrollment generation/step and expose `pause_reason`; historical terminal jobs
are reconciled in bounded batches. A safe staff retry can resume a failed job's
paused enrollment only while no other enrollment is active for that address.
Escalation, group/form shutdown, unsubscribe and provider suppression also stop
paused enrollments and invalidate their old job generation. Uncertain submissions beyond the 23-hour retry horizon stay
held for provider reconciliation. Resend's idempotency key and frozen payload are
preserved throughout retries.

The dispatcher excludes already-created jobs before selecting its batch. It
visits up to 32 tenants, creates at most 10 jobs per tenant and 100 per tick, and
rotates tenants between ticks. Claims also rotate tenants, then take each tenant's
oldest eligible job. The email worker shares the `automation_jobs` admission cap,
uses at most five jobs with a 20-second claim-loop budget, and releases its slot
on success or failure. A provider call already started can finish after that
budget. `runtime.edge_enabled=false` now also stops email dispatch/admission;
existing email group/consent switches still govern individual deliveries.

Retries are scheduled into the enrollment snapshot's business-local send window.
The final send guard checks the window again after drafting or a backlog and
defers without consuming a retry attempt. It also rechecks the provider
idempotency horizon after a long pause. SMS uncertainty handling stays separate.

For staff steps, see [the user guide](USER_GUIDE.md#email). For variables and
safe operator checks, see [configuration](CONFIGURATION.md) and
[operations](OPERATIONS.md). Deployment observations below were recorded during
the original rollout and were not rechecked live during documentation work.

Email follows the four existing automation groups for each CRM business: Contacts, Quote Requests, Bookings, and Reviews. Each group has its own disabled-by-default email schedule, purpose, system prompt, and business context. A new opted-in intake record can enroll only when its business's email group is enabled. The three public forms also require their own email switch and a separate, unchecked email consent box. Staff intake records require an email address and recorded consent evidence. Existing records are never backfilled.

The earlier pricing-only Resend automation (`01a0d955-fe85-70ab-bb56-a715e31632da`) is a superseded draft and must remain disabled. The new workflow sends individual AI-drafted messages through Resend's Email API, using `E2 Local <hello@e2local.com>` and replies to `hello@e2local.com`.

## Release order

1. The original rollout recorded the nine `2026092517` group email migrations and two `202609251800` business-scope migrations as applied to WPacquisition. They add consent history, enrollments, jobs, suppressions, worker RPCs, form hooks, Vault integration, and a once-per-minute email dispatch. Existing seeds and new CRM businesses receive four disabled email groups. Reconcile migration history before any future change; seed defaults do not establish current business settings.
2. Store the Resend sending key and webhook signing secret in Supabase Vault through `sms_private.email_provider_secrets`. The `email-worker` and `email-webhook` functions read them through the scoped `email_secret_value` RPC. `OPENAI_API_KEY`, `SMS_AUTOMATION_DATABASE_URL`, `WEB_FORM_DATABASE_URL`, `AUTOMATION_WORKER_SECRET`, and the `automation_jobs` Vault bearer configuration must also be present in the existing Edge setup. The optional `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` Edge secrets take precedence if configured. Set `EMAIL_UNSUBSCRIBE_BASE_URL=https://crm.e2local.com` and `EMAIL_UNSUBSCRIBE_API_URL=https://wxamwhfmelxqahkdtcci.supabase.co/functions/v1/web-form/email/unsubscribe` if the deployed defaults differ. `scripts/prepare-edge-secrets.js` carries the email variables from local `.env` when used.
3. Deploy affected `crm-api`, `web-form`, `email-worker`, and `email-webhook` changes with their dependencies. Keep `verify_jwt=false` as configured; bearer/signature checks run in handlers and forms use public validation/rate controls. Deploy the static site with `email-unsubscribe.html`. Confirm an unauthorized worker POST returns 401. Establish controlled paused/empty conditions before an authorized worker call: it can process jobs. An idle email worker returns `{"processed":0}`.
4. The rollout recorded a Resend webhook at `https://wxamwhfmelxqahkdtcci.supabase.co/functions/v1/email-webhook` for sent, delivered, delayed, bounced, complained, failed, and suppressed events, with its signing secret in Vault. `node scripts/check-email-live.js` invokes the authenticated email worker, which can send queued email, as well as checking signatures with a ping event. Establish controlled conditions before executing it. Bounces, complaints, and suppressions stop future marketing email to that address across businesses sharing the sender.
5. In the CRM Email section, fill in each group's purpose, email system prompt, business context, separate cadence, and **real business mailing address**. Enable a group when the worker and provider are ready. In Web Forms, enable email consent only on forms that should offer it. Both switches must be on for public form enrollment.

## Operation

Each due job creates a fresh AI draft, stores the subject and body, checks consent and lifecycle state immediately before sending, and sends through Resend with a stable job ID idempotency key. The full provider payload is stored before the first send, so retries use the same content. A job with an uncertain outcome older than the provider's 24-hour idempotency window is held for investigation rather than blindly resent. Failed jobs may be retried from the Email section while safe to do so.

Quote requests stop an active Contacts email sequence for that phone within the business. Confirmed bookings stop Contacts and Quote Requests sequences; cancellation or changed appointment time cancels or reschedules booking email. Reviews stop booking follow-up. Staff can mark an enrollment resolved. The unsubscribe page and one-click List-Unsubscribe header suppress future marketing email from that business to the address. These email actions do not change SMS consent or SMS automation.

Keep `hello@e2local.com` monitored for mailbox replies. Replies are not ingested into the CRM in this release.

## Email MCP — October 16, 2026 (local)

Stage 6 adds twelve tools and eight separate grants (115 tools / 80 permissions).
Scoped group, enrollment and job reads keep content behind email_content_read;
no unsubscribe credentials, provider payloads or leases are exposed. Deterministic
schedule preview creates no AI draft or enrollment. Configuration preserves
activation; browser and MCP edits share revisions. Enablement uses a one-use,
payload-bound CRM Edge ticket to retain provider/AI readiness checks. Secrets stay
in Edge. Resolution fences existing work; retry requires current job/enrollment
revisions, generation, recorded and current source consent, no suppression/overlap,
and the provider retry window. Frozen content/provider idempotency are preserved.

The separately granted form email-consent switch applies only to existing legacy
email-connected forms, preserves collection/SMS settings and creates no backfill.
Disabling cancels email enrollments and audits their revisions. Draft bases advance
only when previously current. All mutations use transactional receipts and audits.

Local verification: CRM 659 passed / 29 existing skips, paired 63, relevant E2 7;
both checks, frontend and 67-file Edge bundle passed. Disposable PostgreSQL verifies
concurrent retries, browser conflicts, interrupted transactions and one-use ticket
races. Migration 20261016202046 alone reconciles against 142 live entries; rollback
rehearsal matches twelve function hashes. Not yet applied/released. Release order:
CRM migration, CRM Edge adapter, MCP/frontend, admin grants, read-only verification.
No E2 runtime change. No customer records or sending workers used in verification.

## Email MCP release — October 16, 2026

Stage 6 is LIVE at a0ce383c151c83c68986fee16e77cd3874d66a6c. Only migration
20261016202046 advanced reconciled history 142 to 143; twelve function hashes
match and private helpers remain denied. CRM Edge deployed before the service.
MCP dep-db98m0e1egvs73csslpg completed 20:37:56 UTC; frontend
 dep-db98m2vf3r2c73ai0b6g completed 20:37:44 UTC (no automatic push event).
Admin connection revision 13 now has 80 permissions. Codex discovered 115 tools;
23 allowlisted reads/previews passed, with 23 attributed audits and zero mutation
receipts. Domain snapshots and security advisors are unchanged. Opek forms and SMS
v1 remain enabled, both test runs stopped, and the reply unread. No email/SMS send,
enrollment, activation or content edit occurred during verification. Local CRM
659 passed / 29 existing skips, paired 63, relevant E2 7, checks/builds and real
PostgreSQL concurrency passed. Stages 7–9 remain.
