# AI reply diagnostics through MCP

## Local implementation — October 16, 2026

This step adds read-only diagnostics for inbound SMS agent jobs. It is not yet
applied or deployed. The local catalog has 155 tools and 106 grants; production
remains at its previously recorded 153 tools and 104 grants.

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

The current agent does not persist an authoritative Business Info version on its
run record. `profileVersionId` is null and `profileVersionAvailability` is
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
change is required. Before a separately requested release, reconcile live aliases
against both repositories, apply only this new migration, then release MCP and
the CRM permission editor. Grant access explicitly; verify through read tools
only. This implementation task applies no live migrations and sends no SMS.
