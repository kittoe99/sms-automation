# Email automation rollout

## Reusable templates — local implementation, November 1, 2026

**Follow-ups → Email** now opens Templates, Connections, Activity, and Settings.
The former AI-written fixed groups remain under **Legacy AI email groups**. New
templates render deterministically through the existing Resend Email API worker;
they do not require OpenAI. The main E2 Local dashboard also has an owner-only
Email service after staff add it and set it live in Businesses.

Create a template or choose a starter, edit its subject/formatted content and
timing, save, preview, then publish. Publication freezes a version for future
runs; editing does not change existing runs. Offsets are minutes from the event
or appointment (negative means before the appointment). Sending hours use the
business timezone. Late pre-appointment reminders are skipped. The editor supports
paragraphs, headings, lists, bold, italics, links, and the listed personalization
fields. Raw HTML and executable links are not accepted.

Connections support form submission (legacy and custom forms), newly recorded
contact email opt-in, and confirmed/changed/cancelled operational bookings.
Enable the form's separate email-consent checkbox in Connections for marketing.
No old submissions or contacts are backfilled. Activity can record consent with
evidence, start one eligible contact, and pause/resume/stop a run. A booking change
fences obsolete jobs; cancellation stops pending reminders. Provider acceptance
and actual delivery remain separate states. Existing legacy MCP tools retain
their group-only scope; template management uses the new authenticated APIs.

Marketing needs recorded email consent and honors business unsubscribe. Booking
service templates are limited to booking events and must contain operational
content only. They do not require marketing consent or an unsubscribe footer.
Provider bounce/complaint/suppression blocks both purposes across the platform.
Recording consent does not clear an existing unsubscribe or provider suppression.
Email sending is independent of SMS sending. A provider request already underway
may finish after a pause; its accepted step advances without resuming later steps.

The default address is `hello@e2local.com`, with the business display name. Reply-to
uses the configured business mailbox, initially `hello@e2local.com`; no mailbox is
created by sender provisioning. Staff can provision `hello@<business>.e2local.com`
in Settings. DNS provisioning only creates missing Resend DKIM/SPF records under
that subdomain and refuses conflicts. Refresh resumes partial operations and checks
verification. Existing MX/website records are not replaced. A selected sender
must be verified. The worker refreshes provider verification after 15 minutes and
holds sends if verification is lost. A frozen payload already submitted to the
provider is never rewritten to change its sender.

### Forward release order

1. Reconcile the live paired histories. Apply only CRM
   `20261102051753_reusable_email_automations.sql`, then E2
   `20261102051756_customer_email_service.sql`. The latter requires the former.
   Neither migration activates connections, sending, or customer visibility.
2. Deploy the updated CRM API and email worker with their complete import graph.
   Retain existing Vault Resend sending/webhook secrets. Configure server-only
   `RESEND_DOMAIN_API_KEY` with domain management access (or use an existing full
   access Resend key), `CLOUDFLARE_EMAIL_ZONE_ID`, and
   `CLOUDFLARE_EMAIL_DNS_TOKEN` restricted to e2local.com DNS read/edit.
3. Deploy CRM frontend and E2 application. In Email Settings, check the existing
   `e2local.com` domain to establish verified readiness. Provision optional business
   subdomains, enter reply-to/address, and explicitly enable business sending.
4. Staff add/release the Email service for each intended owner. Release affects
   dashboard access; sending and connections have separate controls. Configure
   connections explicitly. Replacing overlapping legacy routes requires the
   replacement checkbox and affects future enrollment, not existing legacy runs.
5. Verify one controlled recipient through acceptance and delivery before enabling
   business automations. Monitor Activity for suppression, failure, or uncertain
   outcomes. Never blindly resend an uncertain submission outside the 23-hour
   recovery horizon.

Implementation/testing is local. These migrations, application releases, live
Resend/domain checks and DNS changes have not been applied by this work. The
connected Cloudflare token lacks DNS access; runtime provisioning requires the
separate server token above. The Supabase connector needs reauthentication for
live migration reconciliation. No real recipient or provider send was used in tests.

The synthetic browser fixture is `node test/fixtures/email-automation-preview.js`
on port 8194. It uses an in-memory database and disables provider management.
`node scripts/check-email-workspace.js` runs the workflow with Playwright; optional
`EMAIL_PLAYWRIGHT_MODULE` and `EMAIL_BROWSER_EXECUTABLE` select an existing local
installation. Screenshots are written to ignored `.artifacts/email/`.

## Historical legacy group rollout

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

## Reusable email automation MCP — November 2, 2026 (local)

Added 16 MCP tools and eight opt-in `email_automation_*` grants. The source catalog
now has 172 tools and 115 permissions. Existing email group tools keep their legacy
scope and grants. The new workspace read includes reusable template content,
contacts and consent status; grant it only when that combined access is intended.

Use `crm_get_email_automation_workspace`, create/save a formatted template, preview
its draft at the current revision, then publish. Configure a verified sender and
reply-to with `crm_set_email_automation_settings`. Connect future form, contact
opt-in or booking events with `crm_connect_email_template`, or explicitly start one
eligible marketing contact with `crm_start_email_template_run`. Consent recording
can trigger an enabled contact opt-in connection. Pause/resume/stop/retry require
current run revision and generation. Publication can affect future event enrollments;
activation/resume/start can schedule real Resend delivery. None bulk-enrolls history.

All mutations require UUID idempotency keys. Preserve the exact payload/key after
an uncertain response. Database permission, active staff and business scope checks
run before replay. Mutation receipts and MCP audit records exclude template bodies,
recipient addresses and consent evidence. Private canonical operation records keep
their existing restricted retention. Form/SMS state and provider retry fencing remain
owned by the shared email workflow. DNS provisioning stays in the staff workspace.
The workspace is bounded to 100 templates/connections/forms/contacts and 25 runs/jobs
per activity page; it is not an exhaustive export or contact search.

MCP business service schemas now accept `email`, including business detail results.
A forward preview patch prevents later sequence steps appearing before earlier steps.
Preview times assume prompt processing and do not establish provider delivery.

CRM owns `20261102181913_mcp_reusable_email_automations.sql` and
`20261102181936_email_preview_sequence_order.sql`. Apply after the original CRM
`20261102051753_reusable_email_automations.sql`; E2's existing
`20261102051756_customer_email_service.sql` is required for adding/releasing Email
services. Reconcile live history and apply only missing forward migrations, then
release CRM/MCP and the original paired E2 changes before enabling new grants.
No live migrations, deployments, grants, DNS changes or real sends were performed.
