# Email marketing — review and Resend integration draft

Status: **proposal, November 18, 2026.** Phase 1 (campaigns, segments, batch send,
report) and the engagement-storage half of Phase 0 are implemented and tested locally
but not migrated or released; see the Campaigns section of
[EMAIL_AUTOMATIONS.md](EMAIL_AUTOMATIONS.md). DMARC, enabling domain tracking and the
webhook event subscription are still to do. Phase 1 deviations from the design below:
recipients are enrollments (no separate `email_topics`/`email_campaign_recipients`
delivery columns), there is no send-test-to-self yet, and batch retries replay without
re-checking eligibility. It builds on the shipped reusable email automations.

## 1. What already exists

The CRM already has a production-grade *triggered* email system on Resend:

| Area | Existing implementation |
|---|---|
| Sending | `src/workers/email.js` → `POST /emails` with job-id `Idempotency-Key`, frozen `provider_payload`, uncertain-outcome holding past the 24 h idempotency window |
| Templates | `src/lib/emailTemplates.js` — structured document (paragraph/heading/list/bold/italic/link), merge fields, immutable published versions, starters |
| Triggers | Form submission, contact email opt-in, booking confirmed/changed/cancelled (`email_connections`), manual single-contact start |
| Consent | `email_consent_events`, `email_permissions`; marketing vs operational purposes; form consent checkbox |
| Unsubscribe | Per-business token page `email-unsubscribe.html` + RFC 8058 one-click `List-Unsubscribe` headers |
| Suppression | Per-business `email_suppressions` + platform `email_global_suppressions` from bounce/complaint/suppressed webhooks |
| Webhooks | `supabase/functions/email-webhook` — Svix signature check; sent/delivered/delayed/bounced/complained/failed/suppressed |
| Senders | Per-business `hello@<biz>.e2local.com` provisioned via Resend Domains + Cloudflare DNS; verification re-checked every 15 min |
| Queue | Dispatcher fairness (32 tenants, 10 jobs/tenant, 100/tick), shared `automation_jobs` admission, 5 jobs per worker run |
| Access | E2 `customer_email_service` (owner-only Email service), CRM staff workspace, 16 reusable-automation MCP tools |

## 2. What "email marketing" still lacks

1. **Campaigns / broadcasts** — no one-to-many send to a list. Everything is per-contact enrollment.
2. **Audiences / segments** — no saved filter (tags, source, booking status, last activity, consent date).
3. **Contact import** — no CSV import with consent evidence.
4. **Throughput** — current limits (~5 sends per worker run) suit drips, not a 5,000-contact newsletter.
5. **Engagement analytics** — `email.opened` / `email.clicked` are not subscribed or stored; no campaign report.
6. **Subscription preferences** — unsubscribe is all-or-nothing per business; no topics ("Promotions", "Newsletter").
7. **Visual editor** — the structured editor is safe but basic: no images, buttons, columns or brand header.
8. **Reply ingestion** — replies go to `hello@e2local.com` and are not in CRM conversations.
9. **Testing tools** — no send-test-to-me, no A/B subject, no scheduled send time for a one-off.

## 3. Key decision: who owns the list?

Resend now offers native marketing primitives (Contacts, Segments, Topics,
Broadcasts, Automations, hosted unsubscribe). Two ways to use them:

**Option A — CRM owns contacts, consent and campaigns; Resend is the transport (recommended).**
Campaigns are CRM records; recipients are resolved from CRM contacts and fanned
out through the existing job pipeline, using `POST /emails/batch` (up to 100 per
call). Consent, unsubscribe, suppression and audit stay in one place, per business.

**Option B — Mirror to Resend Contacts/Segments and send Resend Broadcasts.**
Less code to build, Resend's broadcast editor and stats for free. But: Resend's
contact store is account-wide, not per-tenant, so isolating businesses needs
segment-per-business discipline; Resend's hosted unsubscribe becomes a second
source of truth that must be synced back via `contact.updated` webhooks; consent
evidence and the 23 h uncertainty fencing do not apply; and the E2 owner dashboard
cannot be the editing surface without exposing Resend.

Recommendation: **A**, optionally using Resend Templates/Topics later only where they
don't split the source of truth. The existing pipeline already solves the hard
parts (idempotency, consent re-check at send time, suppression), so a campaign is
mostly "a frozen template version + a recipient snapshot".

## 4. Proposed design (Option A)

### 4.1 Data model (new CRM migration, `sms_private`)

```
email_segments(id, tenant_id, name, definition jsonb, revision, created_by, ...)
  -- definition: { all:[ {field:'tag',op:'has',value:'vip'},
  --                     {field:'consent.email_marketing',op:'is',value:true},
  --                     {field:'last_booking_at',op:'within_days',value:180} ] }
email_topics(id, tenant_id, key, name, default_opt_in bool)
email_topic_preferences(tenant_id, email_normalized, topic_id, subscribed bool, changed_at, source)
email_campaigns(id, tenant_id, name, status draft|scheduled|sending|paused|sent|cancelled,
                template_version_id, segment_id, topic_id, scheduled_at, sender_id,
                revision, counts jsonb, created_by, ...)
email_campaign_recipients(campaign_id, contact_id, email_normalized, status
                pending|skipped|queued|sent|delivered|bounced|complained|failed,
                skip_reason, job_id, provider_email_id, opened_at, clicked_at,
                unique(campaign_id, email_normalized))
email_send_batches(id, campaign_id, job_ids uuid[], idempotency_key, state, ...)
email_engagement_events(provider_email_id, type opened|clicked, url, occurred_at)
```

Recipient rows are a **snapshot** taken when the campaign starts (no live
segment drift mid-send). Every recipient still passes `email_before_send` so a
late unsubscribe or bounce is honoured.

### 4.2 Send path

1. Staff/owner composes a campaign → picks a published template version (reuse the
   existing editor and versioning), a segment, optional topic, sender, schedule.
2. **Preview** shows recipient count and skip breakdown (no consent, unsubscribed,
   suppressed, topic opt-out, duplicate) without enqueuing — mirrors existing
   `preview_email_schedule` style.
3. **Send test** to the staff member's own address (single `/emails` call, not tracked as a campaign send).
4. **Start** (idempotent, revision-checked) snapshots recipients and creates one
   `email_jobs` row per eligible recipient with `purpose='marketing'`, `source='campaign'`.
5. A new campaign claim path takes up to 100 jobs of one campaign, freezes each
   payload, persists an `email_send_batches` row with a stable idempotency key, then
   calls `POST /emails/batch`. The response array maps 1:1 to job ids → `email_finish`.
   Uncertain batch outcomes are held exactly like single sends (same key, same payload,
   within the 24 h window). Use strict batch validation so a malformed row fails
   before anything is accepted.
6. Rate: cap per tenant per minute (configurable, default e.g. 600/min) and respect
   Resend's account rate limit with 429 back-off; keep the existing tenant rotation
   so one large campaign can't starve other businesses' drips or booking reminders.
7. Pause / resume / cancel reuse the generation-fencing pattern already used for runs.

Per-recipient merge fields keep working because each batch item is a fully
rendered message (`renderTemplateEmail`) with its own unsubscribe token and
`List-Unsubscribe` headers.

### 4.3 Webhooks and analytics

- Subscribe the existing Resend webhook additionally to `email.opened`,
  `email.clicked` (and enable open/click tracking on the sender domains — a
  per-domain Resend setting; leave off for operational booking mail).
- Extend `email_record_provider_event` to update `email_campaign_recipients` and
  insert `email_engagement_events`. Treat opens as directional only (Apple MPP inflates them).
- Campaign report: sent, delivered, bounced, complained, unique opens/clicks, top
  links, unsubscribes attributed to the campaign.

### 4.4 Preferences and unsubscribe

- Extend `email-unsubscribe.html` into a preference page: per-topic toggles plus
  "unsubscribe from all marketing". One-click header remains "all marketing" for
  RFC 8058 compliance.
- Topic opt-out skips the recipient for campaigns on that topic only.

### 4.5 Contact import

CSV upload → column mapping → validation → requires a consent basis per import
(source, date, evidence text). Imported contacts get `email_consent_events`
rows; nothing is enrolled automatically. Rate-limit and size-cap imports; reject
role addresses (`noreply@`, etc.) by default.

### 4.6 Editor upgrade

Keep the structured, no-raw-HTML document (it is a security boundary). Add block
types: image (uploaded to Supabase Storage, https only), button, divider,
two-column, brand header (logo + colour from business profile). Render through
MJML or React Email for client-safe HTML. See section 6 for editors to borrow.

### 4.7 Inbound replies (later phase)

Use Resend inbound receiving on the business sender subdomain (`reply@<biz>.e2local.com`
as reply-to) → `email.received` webhook → attach to the matching CRM contact
conversation alongside SMS. Requires an MX record on the subdomain, so it must not
conflict with any existing website/MX records (same refusal rule as sender DNS).

### 4.8 Surfaces

- CRM: Follow-ups → Email gains **Campaigns**, **Segments**, **Contacts import**, **Reports** tabs.
- E2 Local owner dashboard: Email service gets Campaigns (compose, preview, send test,
  schedule) behind the existing `customer_email_automation` owner check — E2 change
  in `../E2local-main`, its own migration extending `customer_email_automation` actions.
- MCP: `crm_list/get/save/preview/start/pause/cancel_email_campaign`,
  `crm_save_email_segment`, `crm_preview_email_segment`, behind new opt-in
  `email_campaign_*` grants. Start/resume are real-send operations.

### 4.9 Compliance guardrails (carry over and extend)

- Marketing requires recorded consent; operational templates can't be used for campaigns.
- Physical mailing address required before a campaign can start (already required in footer).
- Platform-level complaint-rate circuit breaker: auto-pause a tenant's campaigns if
  complaints > 0.1 % or hard bounces > 4 % in a campaign, to protect the shared
  `e2local.com` reputation.
- Add DMARC to `e2local.com` before bulk sending (recorded as missing on Nov 2).
- Gmail/Yahoo bulk sender rules: SPF+DKIM aligned (done), DMARC (missing), one-click unsubscribe (done).

## 5. Phasing

| Phase | Scope | Notes |
|---|---|---|
| 0 | DMARC on e2local.com; opened/clicked webhook storage | Small, unblocks analytics |
| 1 | Campaigns + segments + batch send + report (CRM staff only) | Core value; reuses templates and job pipeline |
| 2 | Topics/preference page, CSV import with consent evidence | |
| 3 | Editor blocks (image, button, columns, brand header) | |
| 4 | E2 owner-facing Campaigns, MCP campaign tools | Paired E2 migration after CRM migration |
| 5 | Inbound replies into conversations; A/B subject; send-time scheduling per timezone | |

Migration order per AGENTS.md: CRM migration(s) first, then any E2 migration that
depends on them; never replay either history; reconcile live history before applying.

## 6. Open-source projects to borrow from

Check each licence before copying *code*. AGPL/GPL projects are fine to study for
schema and UX, but copying their code into this hosted service brings licence
obligations — treat them as reference only.

| Project | Licence (verify) | Borrow |
|---|---|---|
| **Listmonk** (Go + Vue) | AGPL-3.0 | Reference only: campaign lifecycle states, list/subscriber schema, SQL-expression segments, campaign analytics views, send throttling |
| **Dittofeed** (TypeScript) | MIT | Segment definition JSON and evaluator, broadcast vs journey split, subscription groups (≈ topics) |
| **Keila** (Elixir) | AGPL-3.0 | Reference only: simple campaign UX, double opt-in forms |
| **Plunk** (TypeScript, Next.js) | AGPL-3.0 | Reference only: event-triggered actions + campaigns in one small app |
| **React Email** (by Resend) | MIT | Rendering components for client-safe HTML; pairs natively with Resend |
| **Maily.to** | MIT | Tiptap-based email editor that outputs React Email — closest fit to the CRM's existing structured document model |
| **MJML** | MIT | Responsive email markup compiler for the renderer |
| **GrapesJS + newsletter preset** | BSD-3 | Full drag-and-drop builder if a freer layout editor is wanted (harder to keep within the no-raw-HTML boundary) |
| **Easy Email** | MIT | MJML-based drag-and-drop editor in React |

Suggested picks: **Dittofeed** for segment logic, **Maily.to + React Email** for the
editor/renderer, **Listmonk** as the UX/schema reference for campaigns and reports.

## 7. Resend API surface used

| Need | Endpoint |
|---|---|
| Single/test sends | `POST /emails` (existing) |
| Campaign fan-out | `POST /emails/batch` (≤100 per call, `Idempotency-Key`) |
| Sender domains, tracking toggles | `GET/PATCH /domains/{id}` (existing GET) |
| Engagement & delivery | Webhooks: add `email.opened`, `email.clicked`; later `email.received` |
| Optional later | Resend Templates (store rendered versions), Topics, Contacts mirror for Resend-side suppression parity |
