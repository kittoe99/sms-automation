# Form Builder

Form Builder adds a tenant-scoped editor, OpenAI agent sessions, a draft-only MCP
server and hosted embeddable lead/quote forms. Published submissions use the
existing Supabase automation and SMS workers; they do not invoke the builder agent.

## Run and deploy

The current production frontend is static and talks to Supabase Edge Functions.
The builder runs as a separate Node service from the same repository so it can
host Streamable HTTP MCP, Agents API streams, and the public renderer.

`render.yaml` defines both services and connects the frontend's `FORMS_API_BASE`
to the forms service's `FORMS_PUBLIC_BASE_URL`. Set that value to the actual HTTPS
origin assigned by Render before rebuilding the frontend. For an existing service
managed outside the Blueprint, set `FORMS_API_BASE` in its Render environment and
redeploy it; changing a local `.env` does not update the deployed static bundle.
The Blueprint uses the free plan for initial setup. Its idle spin-down means it
is not suitable for dependable background processing; select an always-on plan
before accepting production submissions.

1. Apply `supabase/migrations/20260920040000_form_builder.sql` using the existing
   migration workflow. The migration is additive and leaves every tenant disabled.
2. Provision a database login with membership **only** in `sms_forms` and set its
   connection string as `FORMS_DATABASE_URL`. Do not use the CRM API, database
   owner, or Supabase service-role credentials. The role can execute only the
   form domain functions and cannot query customer/provider tables directly.
3. Run `npm ci` and `npm run start:forms` as a Node 20.9+ web service with HTTPS.
   Configure `FORMS_PUBLIC_BASE_URL` to its public origin, `CLERK_ISSUER`, and
   `CRM_ALLOWED_ORIGINS` to the exact CRM origins. Set `FORMS_TRUST_PROXY_HOPS`
   according to the host's trusted proxy topology; do not trust arbitrary
   forwarded IP headers. `/health` is the liveness endpoint.
4. Set a random `FORMS_SIGNING_SECRET` of at least 32 characters, an
   `OPENAI_API_KEY` authorized for `api.agents.read`, `api.agents.write`, and
   `api.responses.write`, and `FORM_BUILDER_MODEL` (default `gpt-6-astra`).
5. The service uses a signed proof-of-work challenge, honeypot, dwell time, and
   shared database rate limits by default. Cloudflare Turnstile can replace the
   proof-of-work check by setting `FORMS_TURNSTILE_SITE_KEY` and
   `FORMS_TURNSTILE_SECRET`; the service validates Turnstile tokens and hostname.
6. Build the static frontend with `FORMS_API_BASE=https://your-forms-service`
   alongside the existing build variables. Run `npm run build:frontend` and
   deploy `dist`. `formsApiBase` contains only an origin; all secrets stay on the
   Node service. If the static host has a CSP, allow the service origin in
   `connect-src`. The regular CRM keeps using its existing Edge API.
7. Check Agents API access with a test business before enabling it for customers.
   The MCP URL must be publicly reachable by OpenAI over HTTPS. A successful
   read-only access check does not validate inference or MCP connectivity.
8. Enable only the pilot tenant with an administrator-run database statement:

   ```sql
   insert into sms_private.form_features(tenant_id,enabled)
   values ('YOUR_EXISTING_TENANT_ID',true)
   on conflict(tenant_id) do update set enabled=excluded.enabled;
   ```

The authenticated actor must be a platform administrator or an administrator in
that tenant's `sms_business_memberships`. Viewers cannot manage forms. The tab
shows a clear setup/disabled message until the service and tenant are configured.

The Node service polls durable submissions every two seconds, up to ten per batch.
Multiple instances are safe: processing uses row locks and `SKIP LOCKED` and has
no network operations inside its transaction. Existing scheduler and automation
workers must be running and the business must be ready to send SMS. Turning off
the pilot feature blocks new public submissions and builder access. Already
accepted jobs are preserved and processed. Unpublish is the per-form equivalent.

## Builder and publication contract

`public/form-schema.js` is the shared contract. Only whitelisted components render
form content, with text nodes rather than interpreted HTML. Fields are ordered;
visibility may reference only an earlier field. Routing is ordered, first-match,
with exactly one default group. No submission-triggered AI classification occurs.

The manual editor and agent share revision checks. Existing automation references
include the version the user/agent reviewed. Publishing locks and checks those
versions, creates pending form-owned groups and their steps, creates an immutable
form version, and changes the public pointer in one transaction. A stale reference
rolls back all changes. The live group's subsequent edits retain existing CRM
behavior. Editing a form never changes an already-published version.

Agents have ten named tools for discovery, draft editing, validation and simulation.
No publishing, production contact writes, SQL, sending, or credential tools exist.
MCP tokens bind business, user, form and session and use a distinct audience from
public submission tokens. Every call checks current membership, the feature flag,
the active turn deadline and the shared tool budget. Results are audited without
capturing tool input/response bodies or credentials.

Sessions are reused for the same form and editor. They have a 50-turn conversation
limit, 30-tool-call turn limit, a three-minute authorization window, and an hourly
business limit of 20 turns. Remote calls are cancelled after 175 seconds. Failed
or disconnected runs retain their saved draft. After the one-day credential
lifetime, a fresh remote session reads the existing draft. User-visible messages,
tool names/outcomes, turn usage and revisions remain in the audit log. A failed
server instance loses its live stream, but its tool authorization expires; a
subsequent request cancels stale remote work before resuming.

## Public submissions

The snippet loads `/forms-assets/form-embed.js`, which mounts an iframe. CSP
`frame-ancestors` restricts configured parent sites. The loader validates both
message origin and iframe source for resizing. The renderer and submit endpoint
share an origin and do not receive Clerk, OpenAI, or database credentials. Only
the public field definition is returned to website visitors.

Public intake checks a signed form/version token, request origin, honeypot,
Turnstile, answer types/lengths/choices, 10 requests per form/IP/minute and 300
requests per form/minute. Origins are an embedding restriction, not authentication.
Routing targets and tenant IDs come from the saved definition, never visitor input.
Hidden answers are ignored and unknown answer fields are rejected.

One durable submission row is also its processing job. Each browser request has
an idempotency key; reuse with different answers/version is rejected. Processing
creates the contact if needed, records the exact disclosure and form version,
preserves existing STOP suppression, and enrolls only with affirmative consent.
Existing active or paused sequences are not restarted. Metadata includes the
service, form/version/submission IDs and validated answers for downstream context.
There is no live slot reservation or file upload in this release.

Submission outcomes are `queued`, `retry`, `enrolled`, `already_enrolled`, `blocked`
or `failed`. Transient database failures roll back processing, retry with backoff,
and stop after five attempts. The submission log exposes failed-job retry; blocked
records show their reason and cannot be retried blindly. Invalid published group
references block enrollment without silently switching to a different group.

## Checks and operations

- `node --test test/formBuilder.test.js`: real migrations, atomic publication,
  consent, suppression, routing, idempotency, tenants, MCP transport and agent sessions.
- `npm test`: existing CRM, booking, AI, automation and worker regression tests.
- `npm run preview:forms`: localhost-only editor with disposable synthetic data
  in PGlite. It does not load production credentials or send SMS. AI is not
  available because the local MCP server is not reachable from OpenAI.
- `npm run build:frontend`: requires the existing documented build variables and
  the optional new `FORMS_API_BASE`.

Track `form_processed` logs for status and processing delay, `form_processor_failed`
for worker availability, and `form_request_failed` for server errors. Per-form
submission responses include pending/failed/blocked totals and oldest pending time.
`sms_form_agent_sessions.usage` records the latest turn; audit events retain per-turn
usage for aggregation. Alert on increasing pending age or repeated processor/agent
failures. Avoid logging submission contents or MCP authorization headers.

OpenAI references:
[Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview),
[MCP connections](https://developers.openai.com/api/docs/guides/agents-api/tools/mcp),
[session events](https://developers.openai.com/api/docs/guides/agents-api/sessions/events).
