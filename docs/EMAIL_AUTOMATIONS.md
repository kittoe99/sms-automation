# E2 Local email automation rollout

Email follows the four existing automation groups: Contacts, Quote Requests, Bookings, and Reviews. Each group has its own disabled-by-default email schedule, purpose, system prompt, and business context. A new opted-in intake record can enroll only when its email group is enabled. The three public forms also require their own email switch and a separate, unchecked email consent box. Staff intake records require an email address and recorded consent evidence. Existing records are never backfilled.

The earlier pricing-only Resend automation (`01a0d955-fe85-70ab-bb56-a715e31632da`) is a superseded draft and must remain disabled. The new workflow sends individual AI-drafted messages through Resend's Email API, using `E2 Local <hello@e2local.com>` and replies to `hello@e2local.com`.

## Release order

1. The nine `2026092517` group email migrations are applied to WPacquisition. All email settings and form switches seed off. They add consent history, enrollments, jobs, suppressions, worker RPCs, form hooks, Vault integration, and a once-per-minute email dispatch.
2. Store the Resend sending key and webhook signing secret in Supabase Vault through `sms_private.email_provider_secrets`. The `email-worker` and `email-webhook` functions read them through the scoped `email_secret_value` RPC. `OPENAI_API_KEY`, `SMS_AUTOMATION_DATABASE_URL`, `WEB_FORM_DATABASE_URL`, `AUTOMATION_WORKER_SECRET`, and the `automation_jobs` Vault bearer configuration must also be present in the existing Edge setup. The optional `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` Edge secrets take precedence if configured. Set `EMAIL_UNSUBSCRIBE_BASE_URL=https://crm.e2local.com` and `EMAIL_UNSUBSCRIBE_API_URL=https://wxamwhfmelxqahkdtcci.supabase.co/functions/v1/web-form/email/unsubscribe` if the deployed defaults differ. `scripts/prepare-edge-secrets.js` carries the email variables from local `.env` when used.
3. Deploy `crm-api`, `web-form`, `email-worker`, and `email-webhook`. Keep `verify_jwt=false` for the public worker and webhook routes as configured in `supabase/config.toml`; their bearer or signature checks run in the handlers. Deploy the CRM static site with `email-unsubscribe.html`. Confirm an unauthorized worker POST returns 401 and an authorized idle POST returns `{"processed":0}`.
4. The Resend webhook is registered at `https://wxamwhfmelxqahkdtcci.supabase.co/functions/v1/email-webhook` for sent, delivered, delayed, bounced, complained, failed, and suppressed email events. Its signing secret is in Vault. `node scripts/check-email-live.js` checks valid and invalid signatures using a harmless ping event. Bounces, complaints, and suppressions stop future E2 Local marketing email to that address.
5. In the CRM Email section, fill in each group's purpose, email system prompt, business context, separate cadence, and **real business mailing address**. Enable a group when the worker and provider are ready. In Web Forms, enable email consent only on forms that should offer it. Both switches must be on for public form enrollment.

## Operation

Each due job creates a fresh AI draft, stores the subject and body, checks consent and lifecycle state immediately before sending, and sends through Resend with a stable job ID idempotency key. The full provider payload is stored before the first send, so retries use the same content. A job with an uncertain outcome older than the provider's 24-hour idempotency window is held for investigation rather than blindly resent. Failed jobs may be retried from the Email section while safe to do so.

Quote requests stop an active Contacts email sequence for that phone. Confirmed bookings stop Contacts and Quote Requests sequences; cancellation or changed appointment time cancels or reschedules booking email. Reviews stop booking follow-up. Staff can mark an enrollment resolved. The unsubscribe page and one-click List-Unsubscribe header suppress all future E2 Local marketing email for that address. These email actions do not change SMS consent or SMS automation.

Keep `hello@e2local.com` monitored for mailbox replies. Replies are not ingested into the CRM in this release.
