# AI reply diagnostics through MCP

> HISTORICAL ARCHIVE: preserved implementation checkpoints, including superseded local-only/unapplied statements and earlier catalog counts. This is not the current operating guide. Use [MCP documentation](CRM_MCP.md) and [current release status](MCP_ROLLOUT.md). Dates and statements below describe their original checkpoint only.

## AI preview release status — October 16

CRM migration `20261017024313` and runtime `bd318e5` are live. Codex discovers 156 tools; the authorized admin now has `ai_reply_preview` (107 grants total). Server-only `MCP_AI_PREVIEW_API_KEY` is configured; MCP restart `dep-db9ec6lg1s2s738d43a0` is live. One real Opek preview returned its website/phone for an accurate junk-removal quote, recorded approved Business Info version 7 and queued no message or action. Nineteen scoped Codex calls produced 21 attributed audit rows and zero mutation receipts. Customer/message/queue state stayed unchanged; E2 remained undeployed. See the latest project record for migration and deployment receipts.

## Hypothetical AI reply previews — local implementation, October 16, 2026

`crm_preview_ai_reply` requires the new, default-off `ai_reply_preview` grant and
an allowed explicit `businessId`. Inputs are a hypothetical `message` (1–4000
characters), `businessRevision`, `settingsRevision`, and `profileVersionId`.
Read the business setup revision/reviewed profile ID with `crm_get_business`
(`read`) and the settings revision with `crm_get_ai_configuration` (`ai_config_read`).
Those read grants do not confer preview permission, nor does preview grant sending.
The admin permission editor includes the new grant; existing connections are not upgraded.

The MCP server uses the live `inboundInstructions` builder and pinned inbound
model, but supplies only approved Business Info, saved AI instructions, business
name/timezone and the hypothetical text. It does not load customer history,
contacts, form submissions, booking state, availability or supplementary knowledge.
Its explicit `contextScope` is `approved_business_info_only`. No tools are provided
to the model, and returned tool calls are rejected. Preview instructions prohibit
claiming bookings, handoffs or other actions occurred. This is a suggested answer,
not proof of how an existing conversation with richer context would respond.

The database checks active CRM staff, OAuth connection, grant and business scope,
then captures facts, profile ID/version, setup and settings revisions in one SQL
statement. After generation it rechecks authorization and revisions plus a hash
of the entire captured context. Concurrent changes return `CONFLICT`; revocation
returns `PERMISSION_DENIED`, and the generated reply is discarded. No transaction
or database lock spans the external model request.

A successful result reports `profileVersionId`, `profileVersion`,
`profileCapturedAt`, `profileVersionAvailability: recorded`, both revisions,
`model`, `promptVersion`, `previewOnly: true`, `actionsExecuted: false`, and
`messageQueued: false`. Provenance describes the preview context; previews do not
create live AI runs or change historical diagnostic records. No prompt, input or
reply is saved to the CRM database. Canonical context access/recheck audit events and a separate
`crm_preview_ai_reply:result` event share the request ID; the result event records
only approved profile ID/version and an allowlisted outcome. A context-access
success is not a successful model generation. Interrupted requests may have only
the context audit; they leave no customer mutation or send to recover.

The server needs the server-only `MCP_AI_PREVIEW_API_KEY` environment variable.
Missing credentials, provider refusal/timeouts, malformed output or a tool call
return a sanitized `TEMPORARY_FAILURE`. There is one bounded model request, no
automatic retry, no customer recipient and no worker/sender credentials. Model
usage can incur cost. The Responses request uses `store: false`, `text.format`
structured output, and no tools, following the [official API guide](https://developers.openai.com/api/docs/guides/migrate-to-responses). Repeated previews may differ, so MCP advertises read-only,
non-destructive, open-world and non-idempotent behavior. No mutation idempotency
receipt is created. Retry only intentionally; reread after conflicts.

CRM owns the single forward migration
`20261017024313_crm_mcp_ai_reply_preview.sql`, after profile provenance
`20261016235631`. No E2 runtime or database contract change is required. Local
combined fixtures apply CRM and the released E2 baseline; production must reconcile
both histories and apply only the new migration before releasing MCP/frontend.
Configure the preview key and explicitly grant preview access during a separately
authorized release. The local catalog becomes 156 tools / 107 permissions;
production remains at 155 / 106 until release. No migration, grant or service has
been applied/deployed for this step.

Tests use mocked model responses and isolated databases: strict inputs, independent
grants, foreign IDs, missing profiles/settings, stale revisions, mid-generation
edits, staff/connection revocation, prompt constraints, provider failures, private
helper access, audit redaction, and unchanged customer/queue snapshots. The local
PostgreSQL script `scripts/test-ai-preview-concurrency.js` additionally checks
independent-session edits/revocation with no model-spanning locks. These checks do
not claim a new real-model quality evaluation or live SMS test.

## Business Info provenance — released October 16, 2026

New worker contexts capture the approved Business Info profile ID, integer version,
exact profile facts and capture time in a private, RLS-enabled context table. Facts
and version come from the same database statement under the existing job locks.
Same-lease rereads use that snapshot. A later retry that regenerates may capture
the newer approved profile; recovery of a committed tool reply preserves its
original snapshot. This records the context used for the final result, not every
failed model attempt or a claim that the model cited every fact. Supplementary
knowledge-source provenance is outside this step.

An insert trigger copies only trusted context metadata into new AI results.
Worker/model result JSON cannot select a profile. Missing context, pre-migration
results and recovered older actions without captured context stay `not_recorded`;
there is no backfill from the current profile. A context without an approved
profile is distinguished as `no_approved_profile`.

Both `crm_list_ai_reply_runs` rows and `crm_get_ai_reply_run` expose:

| Field | Meaning |
| --- | --- |
| `profileVersionId` | Captured profile UUID, or null |
| `profileVersion` | Captured integer version, or null |
| `profileCapturedAt` | Context capture timestamp, or null when not recorded |
| `profileVersionAvailability` | `recorded`, `not_recorded`, or `no_approved_profile` |

Detail retains top-level provenance and also includes it on `run`. Unfinished
runs without a stored result remain `not_recorded`. Projection joins check the
business; superseded profiles remain valid historical evidence. Private snapshots
and Business Info text never appear in these metadata fields or MCP audit records.
Existing `ai_reply_read` and `ai_reply_content_read` grants remain unchanged.
The catalog stays at 155 tools / 106 grants.

CRM owns `20261016235631_inbound_ai_profile_provenance.sql`, following
`20261016225239_automation_ai_reply_defaults_rollout.sql`. It is applied.
No E2 profile/review contract change, new grant, mode change or send is required.
MCP runtime `1006b79` deployed first, supplying null/`not_recorded` defaults
for the previous database output. After reconciling 152 live entries and a rollback
rehearsal, only this migration was applied (153 entries now). All five live function
hashes match the tested definitions. E2 dashboard migration `20261016224415` was
already present independently and was not applied or replayed by this release.
Applying the provenance migration before the compatible MCP schema would make
the old strict validator reject its extra fields.
The unchanged worker already calls the database context/completion functions;
no Edge redeployment was required. No E2 deployment was initiated by this task.
Sixteen attributed read-only Codex calls passed after migration; historical runs
remain not recorded, private access remains denied and all 40 monitored domain
fields/hashes remain unchanged. No SMS, live AI run or mark-read test was performed.

Local coverage includes mocked-model generation, profile changes during a reply,
stale leases, repeat contexts, regenerated retries, recovery, terminal failures,
missing profiles, genuinely pre-migration results, forged metadata, strict schemas,
scoped reads, private grants, redaction and unchanged audit/read state.
`node scripts/test-inbound-profile-provenance-concurrency.js` uses the optional
local PostgreSQL runtime documented in `test-inbound-concurrency.js` to verify
concurrent profile review, serialized context reads and interrupted rollback.

Local verification passed: 724 CRM tests (29 existing skips), 63 paired released-E2
tests, 20 focused checks, disposable PostgreSQL concurrency, source/SQL checks,
frontend build and the Edge bundle. No provider calls, applied live migrations,
production deployments or SMS sends were performed for this step.

## Released — October 16, 2026

This step adds read-only diagnostics for inbound SMS agent jobs. Migration
20261016222634 is applied; runtime 066d2ef is live in MCP and the CRM frontend.
The production catalog has 155 tools and 106 grants. The existing all-business
admin connection has both read permissions; new connections still default off.

| Tool | Input | Result |
| --- | --- | --- |
| `crm_list_ai_reply_runs` | Explicit `businessId`; optional `conversationId`, `status`, `page`, `pageSize` | Scoped attempts and count, including unfinished, failed and cancelled jobs; no message content |
| `crm_get_ai_reply_run` | Explicit `businessId`, `runId`; optional `includeContent` | Job state, recorded metrics, safe action summaries and linked SMS delivery; content only when explicitly requested and granted |

A run ID is the AI **job ID**, not a message or automation enrollment ID. List
results exclude archived jobs; detail can inspect an archived job by its scoped
ID. These tools cover `ai_reply_jobs` with `agent_version=sms-agent-v1`. Older
AI implementations are not silently combined with the current agent's records.
Page size is 1–100, default 25; page is 1–100000. Ordering is newest job first,
with ID as the stable tie breaker. Unknown input properties are rejected at both
the MCP boundary and the database gateway. Outputs use strict schemas.

## Permissions and isolation

`ai_reply_read` grants diagnostics. `ai_reply_content_read` additionally permits
the saved reply and linked inbound/outbound message bodies when `includeContent`
is true. Content permission alone grants no diagnostics access. Both permissions
appear independently in AI connections, default off, and are not automatically
added to existing connections. Configuration, conversation and operations grants
do not substitute for these permissions.

Each call rechecks active CRM staff identity, connection state, permission and
business scope. Filtering applies before counts, pagination and related records.
Conversation/message links must match the business, conversation, phone and
message category; same-phone records in another business remain inaccessible.
Private helpers cannot be executed by browser, worker or MCP database roles;
the canonical audited gateway is the only entry point.

## Evidence and redaction

Job completion and SMS delivery are separate fields. A completed AI job does not
prove an SMS was accepted or delivered. Delivery reflects only linked scoped
outbound message records, with provider acceptance time reported independently.
No linked message means no recorded linked message, not proof of delivery or of
an external failure. Unfinished jobs can have no recorded result or mode.

The response includes recorded token/cost/timing metrics and safe tool names and
outcome categories. Unknown errors become `OTHER_ERROR`; raw prompts, action
arguments/results, provider payloads and credentials are excluded. Models and
prompt versions are allowlisted. Action and delivery arrays are limited to 20,
with totals and explicit truncation flags. Requested message/reply text is capped
at 4000 characters with truncation indicated.

At the original diagnostics release baseline, the agent does not persist an
authoritative Business Info version on its run record. `profileVersionId` is null and `profileVersionAvailability` is
`not_recorded`; these tools never infer historical provenance from today's
profile. Historical shadow records can be inspected without changing the current
on/off AI behavior.

Calls write only the existing connection last-use and sanitized MCP activity
records when deployed. They do not mark messages read, change consent/settings,
retry jobs, start runs or enqueue/send SMS. Reads have no mutation retry receipts.

## Verification and release boundary

Local tests use disposable database fixtures and cover permissions, revocation,
strict inputs, substituted IDs, same-phone businesses, corrupted links, scoped
counts/content, unfinished and archived jobs, redaction, bounded nested output,
audits and unchanged domain/queue snapshots. Protocol tests verify discovery,
strict schemas and read-only annotations. See both project records for full check
results.

The sole new CRM migration is
`20261016222634_crm_mcp_ai_reply_diagnostics.sql`. It follows CRM operations,
operation archive and unified Business Info migrations plus the existing paired
E2 baseline. It adds private read helpers/indexes, schemas and grant/gateway
routing without backfilling grants or business data. No E2 migration or runtime
change is required. Live reconciliation found 149 prior migrations and only this
migration pending; history is now 150. A rollback rehearsal and all six function
hashes passed. MCP deployment dep-db9ah4fbtjjs73b08k70 and frontend deployment
dep-db9ai97btjjs73b0cks0 released 066d2ef. Twelve attributed Codex read calls
verified Opek's runs and content grants, with no mutation receipts or domain
changes. No SMS was queued/sent and no messages were marked read. Future releases
must again reconcile aliases and apply only new owning migrations.
