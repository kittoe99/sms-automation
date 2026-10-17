# AI reply diagnostics through MCP

## Business Info provenance — local implementation, October 16, 2026

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
`20261016225239_automation_ai_reply_defaults_rollout.sql`. It is **not applied**.
No E2 profile/review contract change, new grant, mode change or send is required.
For a later authorized release, first deploy the compatible MCP schema, which
supplies null/`not_recorded` defaults for old database output. Then reconcile both
migration histories and apply only this forward migration. Applying it before the
compatible MCP schema would make the old strict validator reject the extra fields.
The unchanged worker already calls the database context/completion functions;
no Edge redeployment is required. E2 Local remains undeployed.

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
