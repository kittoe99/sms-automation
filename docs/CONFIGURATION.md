# Configuration reference

The new [Inbound AI agent](INBOUND_AI.md) uses the server-side `OPENAI_API_KEY`
with a dedicated OpenAI project and API billing. Its model is pinned in code to
`gpt-6.1-sol`; legacy generation-model environment variables do not override it.
All businesses default off, and Opek live activation requires reviewed shadow
evidence. No key belongs in the browser bundle.

This guide separates public browser configuration, private Edge runtime configuration and legacy settings. It describes names consumed by checked-in code; it is not an inventory of live secret values. [.env.example](../.env.example) is a mixed historical/operator reference, not the minimum frontend setup.

## Public frontend settings

The builder reads a reviewed destination map from `config/environments/` and
writes public values into `dist/config.js`. Changes require rebuilding the
static frontend. A new environment requires a reviewed manifest and compatible
static header policy; arbitrary destination overrides are rejected.

| Variable | Required/default | Purpose |
| --- | --- | --- |
| `CRM_ENVIRONMENT` | Defaults to `production`; unknown name fails | Selects `config/environments/<name>.json` |
| `CRM_API_BASE` | Optional; must match selected manifest if set | Production: `https://wxamwhfmelxqahkdtcci.supabase.co/functions/v1/crm-api` |
| `SUPABASE_URL` | Optional; must match selected manifest if set | Production: `https://wxamwhfmelxqahkdtcci.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | Required; `sb_publishable_` prefix | Browser Supabase access; never use a server key |
| `PUBLIC_FORM_BASE_URL` | Optional; must match selected manifest if set | Production embed origin: `https://crm.e2local.com` |
| `HOSTING_API_BASE` | Optional; must match selected manifest if set | Production E2 API: `https://www.e2local.com/api/web-hosting` |

The form API base is derived from `SUPABASE_URL`. The CRM Clerk publishable key is obtained from `/auth/config`, rather than baked into the static build. `PORT` controls the loopback preview (8080 default); `DEMO_PORT` controls the synthetic demo (8081 default). These ports are not written into browser configuration.

`npm run headers:generate` regenerates the static CSP and related headers in
`render.yaml` from the reviewed production destinations and inline script hashes.
`npm run check` rejects policy drift. The policy preserves public form embedding
while protecting app documents from framing; provider permissions, including
Persona microphone/camera use, are explicit. Verify actual hosted headers and
provider/login flows after deployment; a generated policy is not a browser smoke
test. The build validates destinations before clearing its own generated `dist/`.

## CRM Edge authentication

| Variable | Exposure | Use |
| --- | --- | --- |
| `CRM_CLERK_PUBLISHABLE_KEY` | Public through auth config | Independent CRM Clerk application |
| `CRM_CLERK_SECRET_KEY` | Server secret | Verified first-login metadata synchronization |
| `CRM_CLERK_ISSUER` | Server configuration; public issuer | CRM HTTPS issuer, normally `https://clerk.crm.e2local.com` |
| `E2_CLERK_ISSUER` | Server configuration; public issuer | Different customer issuer, normally `https://clerk.e2local.com` |
| `CRM_ALLOWED_ORIGINS` | Server configuration | Comma-separated exact origins for CORS and JWT `azp` checks; include intentional local/preview origins |

Distinct valid HTTPS issuers and a nonempty origin list are required. The API verifies the bearer session and the database resolves permissions. Configuring keys or creating an account does not grant staff access. E2 lifecycle webhook secrets and its customer credentials belong in E2; see [separate login setup](../../E2local-main/docs/separate-logins.md).

## Scoped database connections

All database URLs contain credentials and stay server-side. Edge connections use TLS and scoped RPC roles.

| Variable | Consumer / role |
| --- | --- |
| `SMS_API_DATABASE_URL` | `crm-api`; `sms_api` |
| `SMS_WEBHOOK_DATABASE_URL` | Twilio callbacks, business events and Soni inbound routing; `sms_webhook` |
| `SMS_SENDER_DATABASE_URL` | SMS and handoff workers; `sms_sender` |
| `SMS_AUTOMATION_DATABASE_URL` | Automation, provisioning, compliance, email workers/webhook; `sms_automation`; compliance-session adds human issuer context |
| `SMS_AI_DATABASE_URL` | AI, knowledge and embedding workers; `sms_ai` |
| `WEB_FORM_DATABASE_URL` | Public forms and unsubscribe RPCs; `sms_form_public` |
| `VOICE_AGENT_DATABASE_URL` | Opek voice bridge; `sms_voice` |
| `MIGRATION_DATABASE_URL` | Privileged operator bootstrap/migration tooling; not an application browser setting |
| `WORKER_DATABASE_URL` | Process-based worker runner only; not used by current Edge entrypoints |

`SUPABASE_SERVICE_ROLE_KEY` is a server secret used for private knowledge upload signing/downloads and retained server integrations. It is not required by the local static server. `SUPABASE_URL` is public, but its presence alongside secret keys in Edge configuration does not make those keys public.

## Worker tokens and provider configuration

Each generic worker expects `Authorization: Bearer <secret>` with a configured secret of at least 32 characters. Match these values to the Vault secret referenced by the corresponding `sms_private.edge_config.secret_id`:

| Variable | Worker |
| --- | --- |
| `SMS_WORKER_SECRET` | SMS |
| `AUTOMATION_WORKER_SECRET` | Automation and the separate email worker |
| `AI_WORKER_SECRET` | AI replies |
| `PROVISIONING_WORKER_SECRET` | Twilio subaccount provisioning |
| `KNOWLEDGE_WORKER_SECRET` | Knowledge extraction |
| `EMBEDDING_WORKER_SECRET` | Embeddings |
| `HANDOFF_WORKER_SECRET` | Staff alerts |
| `COMPLIANCE_WORKER_SECRET` | Twilio registration/activation work |

Queue enable switches, concurrency, scheduler controls and per-business sending live in database configuration, not these tokens. See [architecture](ARCHITECTURE.md#worker-inventory) and [operations](OPERATIONS.md).

| Variable | Use |
| --- | --- |
| `TWILIO_MASTER_ACCOUNT_SID`, `TWILIO_MASTER_AUTH_TOKEN` | Provisioning worker's parent account; token is secret; ordinary sends use tenant credentials in Vault |
| `SMS_WEBHOOK_BASE_URL` | Exact HTTPS base for signed callbacks, normally the `twilio-webhook` Edge URL |
| `SMS_CALLBACK_URL` | Sender delivery callback URL, normally the base plus `/status` |
| `TWILIO_WEBHOOK_BASE_URL` | Provisioning callback override; otherwise provisioning derives it from `SUPABASE_URL` |
| `OPENAI_API_KEY` | Private generation and embedding access |
| `AI_MODEL` | Current source default `gpt-5.4-mini-2026-03-17`; a configured implementation value, not a model recommendation |
| `EMBEDDING_MODEL` | Current source default `text-embedding-3-small`; implementation expects 1,536 dimensions |
| `AI_INPUT_USD_PER_MILLION`, `AI_OUTPUT_USD_PER_MILLION`, `EMBEDDING_USD_PER_MILLION` | Optional estimated cost inputs; source code does not fetch current prices |
| `SMS_ESTIMATED_USD_PER_SEGMENT` | Optional estimated SMS cost input |
| `FIRECRAWL_API_KEY` | Optional website enrichment provider; code has direct HTML fallback |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` | Optional Edge overrides of Vault email credentials |
| `EMAIL_UNSUBSCRIBE_BASE_URL` | Unsubscribe page origin; default `https://crm.e2local.com` |
| `EMAIL_UNSUBSCRIBE_API_URL` | POST endpoint; default WPacquisition `/functions/v1/web-form/email/unsubscribe` |
| `WEB_FORM_IP_HASH_KEY` | Secret of at least 32 characters for form rate-bucket hashing |

Model names and helper cost defaults above reflect checked-in code. Verify provider availability and current rates separately before changing deployments. Missing OpenAI configuration prevents active drafting; email activation additionally checks provider readiness.

## Voice configuration

| Variable | Use |
| --- | --- |
| `SONI_BRIDGE_SECRET` | Timestamped HMAC authentication; at least 32 characters; shared with external Soni worker |
| `SONI_OTP_SECRET` | Server-only verification-code hashing key; at least 32 characters |
| `VOICE_LOOKUP_DATABASE_URL` | Separate read-only phone lookup login; `sms_voice_lookup_login`, four wrappers in `voice_lookup_api` |
| `SONI_LOOKUP_SECRET` | Signed `voice-lookup` gateway authentication; shared only with the LiveKit/local worker |
| `SONI_LOOKUP_OTP_SECRET` | Separate server-only lookup verification-code hashing key |
| `SONI_VOICE_WEBHOOK_URL` | Exact HTTPS URL used to validate the Twilio inbound voice signature |
| `SONI_VOICE_TENANT_ID` | Registered business owning the approved phone provider; inbound voice rejects other mappings (legacy default: `opek`) |
| `SONI_SIP_USERNAME`, `SONI_SIP_PASSWORD` | Private LiveKit trunk credentials; current handler accepts 12–128 letters, numbers, `_` or `-` |
| `VOICE_BOOKING_DATABASE_URL` | `voice-booking`; restricted `sms_voice_booking_login` inheriting `sms_voice_booking` |
| `SONI_BOOKING_SECRET` | Booking gateway HMAC key, at least 32 characters; must match the external worker |
| `VOICE_BOOKING_ENABLED` | Booking gateway accepts requests only when exactly `true`; worker feature flag must also be configured |
| `VOICE_RUNTIME_DATABASE_URL` | `voice-runtime`; restricted `sms_voice_runtime_login` inheriting `sms_voice_runtime` |
| `VOICE_RUNTIME_SECRET` | Runtime HMAC key, at least 32 characters; shared with the external worker |
| `VOICE_CRM_ENABLED` | Runtime gateway accepts requests only when exactly `true`; also configure the worker's matching flag |
| `VOICE_MAINTENANCE_DATABASE_URL` | `voice-maintenance`; restricted `sms_voice_maintenance_login` inheriting `sms_voice_maintenance` |
| `VOICE_MAINTENANCE_SECRET` | Maintenance bearer, at least 32 characters; must match the Vault secret referenced by `sms_private.voice_maintenance_settings` |

The bridge is explicitly scoped to Opek. [Soni voice bridge](SONI_VOICE_BRIDGE.md) owns telephony setup and verification. `ELEVENLABS_API_KEY`, `ELEVENLABS_WEBHOOK_SECRET`, `ELEVENLABS_OUTBOUND_AGENT_ID` and `ELEVENLABS_AGENT_PHONE_NUMBER_ID` support retained ElevenLabs integrations and legacy sync/calling; they do not configure Soni.

The registered-business lookup, booking and CRM runtime gateways are separate
from the legacy `voice-agent` bridge. Their handlers pin the business server-side;
creating another CRM draft agent does not configure runtime routing. Database
URLs, HMAC/OTP keys and maintenance bearer are server secrets. Only the flags are
non-secret configuration. See [Voice CRM](VOICE_CRM.md) and
[booking availability](BOOKING_AVAILABILITY.md). Do not turn off retention cleanup
merely to disable live calls or booking.

## Operator helpers and generated files

| Helper | Inputs and effects |
| --- | --- |
| `scripts/preflight.js` | Reports whether selected variables are set, not their values; checks the project URL; does not prove provider access or complete readiness |
| `scripts/bootstrap-workers.js` | Uses `MIGRATION_DATABASE_URL` and `CRM_ADMIN_CLERK_USER_ID`; creates scoped logins and a legacy admin grant, then writes ignored `data/worker-credentials.env`; refuses existing login roles |
| `scripts/bootstrap-web-form-role.js` | Creates the scoped form login and ignored form credentials file |
| `scripts/bootstrap-voice-role.js` | Creates voice login/bridge credentials in ignored `data/voice-agent-credentials.env` |
| `scripts/bootstrap-booking-role.js` | Creates restricted booking login; writes `data/voice-booking-credentials.env` with booking disabled; refuses existing login/file |
| `scripts/bootstrap-voice-crm.js` | Creates runtime/maintenance logins and maintenance Vault configuration; writes `data/voice-crm-credentials.env` before provisioning; runtime starts disabled; refuses existing logins/file |
| `scripts/prepare-edge-secrets.js` | Reads `.env`, required worker credentials, optional form credentials and prior Edge secrets; writes ignored `data/edge-secrets.env` |
| `scripts/prepare-edge-deployment.js` | With existing Edge secrets, writes ignored Vault initialization SQL and complete Edge import bundle; only fills missing queue secret IDs. `--bundle-only` reads no secrets and writes no Vault SQL |
| `scripts/package-edge-function.js <function-name>` | Packages an entrypoint and recursively discovered relative imports into ignored `data/edge-package-<name>.json`; does not deploy |

Bootstrap helpers are not idempotent account-recovery procedures. The worker bootstrap writes the compatibility admin table and does not replace canonical issuer-qualified staff bootstrap. Refer to [staff CRM](STAFF_CRM.md#restore-staff-access-to-a-fresh-account).

The Edge secret helper **does not copy every `.env` variable**. It preserves prior secrets, merges scoped credentials, copies a selected allowlist, generates missing generic worker tokens, maps local `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` to master provisioning credentials, and fixes callback/model defaults. It also fills AI cost estimates when absent. Review the generated configuration privately: voice credentials, `FIRECRAWL_API_KEY`, SMS segment costs and other separately managed settings need explicit handling. Do not print the file to logs or commit it.

Rotating worker tokens requires coordinated Edge and Vault changes. The Vault initialization helper only handles null secret IDs and is not a rotation script. Edge project secrets are accessible to sibling functions, so scoped database roles are not a hard runtime isolation boundary.

## Paired verification settings

`E2_PROJECT_ROOT` points CRM's paired baseline/test command at a non-sibling
`e2-local` checkout; it defaults to `../E2local-main`. `SMS_PROJECT_ROOT` is the
equivalent CRM location used by E2 tests. Neither changes application routing.
The manual paired-release GitHub workflow accepts an exact E2 commit SHA;
`PAIRED_REPO_TOKEN` supplies read-only repository access when E2 is private.
Keep that token in CI secrets, never `.env` frontend settings or the bundle.
See [hardening release](HARDENING_RELEASE.md) for fingerprint review and gates.

## Legacy and development-only settings

| Variables | Meaning |
| --- | --- |
| `NODE_ENV` | Legacy server refuses `production`; the example file's production value must be overridden for isolated legacy work |
| `CRM_DATA_MODE` | Legacy `empty` mode disconnects record storage while retaining definition editors |
| `AUTOMATION_RULES_STORE`, `AUTOMATION_RULES_FILE`, `AUTOMATION_AI_SETTINGS_FILE` | Legacy file/Supabase definition storage |
| `BUSINESS_TIME_ZONE` | Legacy default; current businesses store their own time zone |
| `DEFAULT_TENANT_ID`, `DEFAULT_TENANT_NAME`, `DEFAULT_TENANT_SHORT_NAME`, `TENANT_ACCOUNTS_JSON` | Legacy tenant registry; the multiple-active-business guard is not the current Edge tenancy implementation |
| `DEFAULT_TENANT_CLERK_ORGANIZATION_ID`, `DEFAULT_TENANT_CLERK_ORGANIZATION_SLUG` | Legacy organization mapping |
| `TENANT_REGISTRY_STORE`, `PLATFORM_ADMIN_USER_IDS`, `TENANT_CREDENTIAL_ENCRYPTION_KEY` | Legacy registry/admin/credential encryption; not canonical platform grants or Vault provisioning |
| `LOCAL_BUSINESSES_FILE`, `MESSAGE_STORE_MAX` | Legacy local registry/message-store controls |
| `TWILIO_PARENT_ACCOUNT_SID`, `TWILIO_PARENT_AUTH_TOKEN` | Legacy provisioning credentials; distinguish from current `TWILIO_MASTER_*` |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_FROM_NUMBER` | Legacy sending and operator import inputs; helper may map parent credentials as described above |
| `PUBLIC_BASE_URL`, `TWILIO_VALIDATE_SIGNATURE`, `OPEK_SMS_API_KEY` | Legacy webhook/API controls; do not authorize current CRM Edge requests |
| `ALLOW_LOCAL_DATABASE` | Explicit local-target override in operator bootstrap tools; does not retarget the frontend builder |
| `VOICE_SYNC_MAX_PAGES`, `VOICE_SYNC_SINCE_UNIX` | Limits for retained provider-backed voice synchronization |

Optional workstation tooling also uses `OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD`; see [remote tooling](REMOTE-OPENCODE.md). No `.env`, backup `.env.*`, private keys or generated credential files should enter Git.

For Clerk test-login preview, `CRM_PREVIEW_MODE=development`,
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` are read from ignored
`.env.local` by the preview server; see [development](DEVELOPMENT.md).
`INBOUND_AI_EVAL_PROXY_FILE` is an optional local evaluation credential file used
by the inbound/coordination evaluators instead of direct provider access. Treat
its contents as secrets; it is not an Edge deployment setting. Evaluations can
incur provider charges and never activate production AI.

## MCP hypothetical AI preview key

`MCP_AI_PREVIEW_API_KEY` is server-only on the CRM MCP Node service. It enables the
single bounded model request behind `crm_preview_ai_reply`; it is never returned
by tools or included in frontend configuration. Preview still requires the
separate `ai_reply_preview` connection grant and an authorized business. Missing
credentials return a sanitized temporary failure. No SMS/worker key is needed.
See [AI reply previews](AI_REPLY_DIAGNOSTICS.md) for revisions, context limits,
non-idempotent model usage and the applied release baseline. E2 needs no change.
