# CRM MCP business setup

## Implementation and release state

October 14, 2026 (America/Denver): implemented locally; not released. The SQL
forward migration passed a rollback-only rehearsal on the configured shared
project `wxamwhfmelxqahkdtcci`. No migration is applied by that rehearsal.
Production's latest recorded migration is `20261014210940 unified_sms_workspace`.
The paired `platform_actor`, `platform_staff`, `save_business_setup`, and
`platform_action` definitions matched the local tested definitions.

Live pilot prerequisites remain: production CRM Clerk OAuth must advertise CIMD,
the new Render service needs its CRM production Clerk secret and dedicated
database login, and a staff member must complete Codex's interactive OAuth login.
The local `.env.local` Clerk credentials identify a development instance and
must not be substituted. Never paste secret keys into chat or commit them.

The requested pilot is **all current and future businesses**, with `read`,
`draft`, `review`, `service_add`, `visibility`, and `global_customer_lookup`.
Only the designated staff/Codex connection should receive those grants. New
connections continue to start pending with no grants.

## Architecture and permission boundary

`npm run start:mcp` starts a separate Node/Express service. `/mcp` uses stateless
Streamable HTTP with the pinned MCP SDK. Each HTTP request verifies a CRM OAuth
access token and creates a server bound to that verified identity; there is no
shared current business or user state. Discovery endpoints are public; business
tools are authenticated. Host and optional browser Origin are checked.

Clerk's dedicated CRM Backend API introspects access tokens with the exact
`MCP_RESOURCE_URL` audience. JWT access tokens additionally require the CRM
issuer and signature. Expired/revoked tokens, tokens without a resource audience,
machine subjects and token-exchange actor chains are rejected. CRM and customer
Clerk issuers remain separate. Discovery requires PKCE S256 and CIMD; metadata
requests have a bounded timeout. `profile` and `offline_access` support user
identification and client-managed refresh.

The MCP database login receives **only** the `crm_mcp` role. Its only application
entry point is `crm_mcp.invoke(text,text,text,jsonb,uuid)`. It has no `sms_private`
schema access, preventing use of historical PUBLIC grants in that schema. The
entry point calls the private implementation under its function owner's rights;
canonical staff, connection grants, and business scope are checked on every call.
No Supabase service-role key, browser JWT forwarding, arbitrary SQL, URL fetcher,
or generic CRM action tool is exposed.

Connection grants and platform ownership changes use the existing platform
privilege lock. Successful mutations and their idempotency results commit in one
transaction. Permission checks happen before reading a previous result, so a
revoked caller cannot replay a formerly permitted write. A key cannot be reused
for different content or a different tool. Stale revisions require rereading.

Private connections bind issuer, subject and OAuth client, with independent
action grants and either selected IDs or an explicit all-businesses flag.
Revocation is terminal for that identity/client pair; use Disabled for a
reversible pause. No login grants staff status. Private activity stores actor,
connection, tool, target, request UUID, outcome/code and resulting revision,
excluding tokens and profile bodies. Successful mutation results are stored
privately for retry recovery. Transport/authentication failures have no trusted
connection and are not attributed to a CRM account.

## Tools and browser administration

All tools have per-tool output schemas and return `{ok, requestId, data? , error?}`. Errors include a stable code,
message and retryable flag; the MCP result also sets `isError`. Tools validate
inputs, expose read/write annotations, and require explicit `businessId` for
business operations. Lists default to 25 and cap at 100. `crm_get_access` returns
up to 100 business summaries; use `crm_list_businesses` for further pages.

| Tool | Grant | Behavior |
| --- | --- | --- |
| `crm_get_access` | Authenticated CRM staff | Pending/active/disabled/revoked status and effective grants |
| `crm_search_customers` | read | Scoped customers; broader lookup needs global_customer_lookup |
| `crm_get_customer` | read | Customer details and only permitted related businesses |
| `crm_list_businesses` | read | Paginated business summaries |
| `crm_get_business` | read | Draft, approved facts, review state, services and revisions |
| `crm_save_business_profile_draft` | draft | Expected revision and idempotencyKey required |
| `crm_review_business_profile` | review | Existing shared reviewed-profile action |
| `crm_add_business_service` | service_add | Existing service addition; website must already be linked |
| `crm_set_service_visibility` | visibility | Expected service revision and explicit draft/live value |

Profile review does not release customer services. Adding SMS can queue provider
setup but does not enable sending. The result includes the current provisioning
state and up to 20 scoped job IDs/statuses; retries retain that original snapshot. Visibility does not publish a website or
activate messaging. Original customer submissions, service prerequisites,
ownership checks, profile merging and E2 cache invalidation remain authoritative.

Administration → AI connections uses browser-authenticated CRM routes:
`GET /platform/ai-connections`, `POST /platform/ai-connections`, and
`GET /platform/ai-connections/activity?connectionId=...&page=...`.
Updates require `connectionId`, current `revision`, status, `permissions`,
`businessIds`, and optional `allBusinesses` (defaults false).
Only canonical staff can manage grants. Agents have no grant-management tool.

## Release procedure

1. Run CRM checks, `npm run test:mcp`, full tests, paired tests, frontend build and
   Edge packaging checks. Run E2 checks/tests/paired checks, Worker tests and build.
   `node scripts/test-mcp-concurrency.js` uses the optional disposable embedded
   PostgreSQL runtime documented in `scripts/test-inbound-concurrency.js`.
2. Reconcile both histories against the live project. Apply only CRM's new
   `20261015031114_crm_mcp_business_setup.sql`, after the October 14 baseline;
   no new E2 migration is required. Rehearse transactionally, compare function
   guards, and compare security advisors before/after. Never replay histories.
3. Provision a dedicated LOGIN with only `crm_mcp` membership. Store its SSL
   connection URL as Render `MCP_DATABASE_URL`; grant neither `sms_api` nor
   `service_role`. Credentials are generated/stored outside tracked files.
4. Enable CIMD on the **production CRM** Clerk OAuth settings; retain S256 PKCE
   and consent. Use the production CRM secret as `CRM_CLERK_SECRET_KEY` in Render.
5. Create the independent Render service from the reviewed implementation branch
   using the Blueprint entry. `MCP_RESOURCE_URL` must equal the final HTTPS
   service URL plus `/mcp`; set it before OAuth setup. Use the onrender.com URL
   for the free pilot, manual deployment, and `/health`. Free-tier startup latency
   must be evaluated before broader staff rollout. No disk or worker is required.
6. Release the new `crm-api` and CRM frontend together after the migration. E2
   runtime remains unchanged. Verify discovery, authentication challenges and
   rejection of tokens intended for another resource before authorizing writes.
7. Add the URL in Codex and complete OAuth as the intended CRM staff user.
   `codex mcp add e2-crm --url <MCP_RESOURCE_URL>` followed by
   `codex mcp login e2-crm` uses Codex's OAuth flow. Do not copy a browser session.
8. Call `crm_get_access` to create the pending connection. In CRM, inspect its
   staff/client identity, select All businesses and the six pilot grants above,
   then activate it. Verify read/refresh/reconnect and a designated test record
   workflow; do not use live customer service activation as a smoke test.

Rollback: disable the connection or stop the MCP service. Retain private audit
and idempotency records and the additive schema; rollback must not delete history.
Monitor authentication errors, denied calls, conflicts, database availability,
and provider setup separately. Queued work is not proof of provider completion.

## Next milestone

SMS automation creation, preview, publishing, enabling and activity inspection
will receive separate tools and grants. Staff-access changes, ownership transfers,
website reassignment/publication, deletion, sends and unattended credentials are
not part of this business-setup tool set.
