# Remaining CRM MCP rollout

> HISTORICAL ARCHIVE: preserved implementation checkpoints, including superseded local-only/unapplied statements and earlier catalog counts. This is not the current operating guide. Use [MCP documentation](CRM_MCP.md) and [current release status](MCP_ROLLOUT.md). Dates and statements below describe their original checkpoint only.

## AI preview release status — October 16

CRM migration `20261017024313` and runtime `bd318e5` are live. Codex discovers 156 tools; the authorized admin now has `ai_reply_preview` (107 grants total). Server-only `MCP_AI_PREVIEW_API_KEY` is configured; MCP restart `dep-db9ec6lg1s2s738d43a0` is live. One real Opek preview returned its website/phone for an accurate junk-removal quote, recorded approved Business Info version 7 and queued no message or action. Nineteen scoped Codex calls produced 21 attributed audit rows and zero mutation receipts. Customer/message/queue state stayed unchanged; E2 remained undeployed. See the latest project record for migration and deployment receipts.

This is the execution record for the approved nine-stage rollout. The starting
production baseline is 49 tools and 33 permissions (conversation release
7ea1dc8). New capabilities are released by domain; production verification uses
reads and previews only. All nine stages below are now released; with the AI diagnostics follow-on, the catalog has 155 tools and 106 grants.
Agreed exclusions remain documented below.

| Stage | Deliverable | State |
| --- | --- | --- |
| 1 | Contacts, SMS consent, automation blocking, marketing SMS preview/send | Released c3d717a; 59 tools / 42 grants; read-only verification passed |
| 2 | Conversation AI controls, reassignment, enquiry edits, alerts, reporting, tags and attribution | Released d60dd35; 72 tools / 49 grants; read-only verification passed |
| 3 | Form duplication/archive/restore, template archive and saved presets | Released 95b6c36; 79 tools / 55 grants; read-only verification passed |
| 4 | Existing bookings, availability/settings, intake edits and cancellation | Released 3fd85ef; 91 tools / 63 grants; read-only verification passed |
| 5 | Knowledge sources/uploads/versions and AI configuration/activation | Released c204b75; 103 tools / 72 grants; read-only verification passed |
| 6 | Existing email groups, enrollment/job activity, preview, enablement and recovery | Released a0ce383; 115 tools / 80 grants; read-only verification passed |
| 7 | Voice configuration/drafts/publication, calls, transcripts and media | Released 42e8293; 127 tools / 88 grants; read-only verification passed |
| 8 | Existing-site details/deployments, form connections, update requests and publication | Released 66623ea / E2 4b41268; 142 tools / 98 grants; read-only verification passed |
| 9 | Operational diagnostics, sanitized provider readiness, refresh/reconciliation and eligible recovery | Released 8a724e1; 153 tools / 104 grants; read-only verification passed |

## Follow-on: AI reply diagnostics (released October 16, 2026)

`crm_list_ai_reply_runs` and `crm_get_ai_reply_run` add scoped job/result/delivery
reads with separate `ai_reply_read` and `ai_reply_content_read` grants. Live
catalog: 155 tools / 106 grants at 066d2ef; only migration 20261016222634 applied.
The existing admin connection received both grants at revision 17. Twelve Codex
read checks passed with domain/read-state preservation and zero mutation receipts.
See [AI reply diagnostics](AI_REPLY_DIAGNOSTICS.md) for the strict contract,
isolation coverage and the one new CRM migration, 20261016222634.

## Follow-on: Business Info provenance (released October 16, 2026)

One new CRM migration, `20261016235631_inbound_ai_profile_provenance.sql`, records
Business Info context versions for new AI results. Existing scoped diagnostic
reads expose the version; older results remain not recorded. This introduces no
new tools, grants or E2 contracts. Compatible MCP runtime `1006b79` deployed before
the forward migration; both are live. Historical runs remain not recorded. See [AI diagnostics](AI_REPLY_DIAGNOSTICS.md).

## Follow-on: AI reply previews (implemented locally)

`crm_preview_ai_reply` adds one opt-in `ai_reply_preview` permission and a bounded
hypothetical Business Info answer. Profile/settings revisions and authorization
are checked before and after the model request. It cannot execute actions or send
SMS and does not load customer history. Migration `20261017024313` is unapplied;
local catalog is 156 tools / 107 grants. See [preview contract](AI_REPLY_HISTORY.md#hypothetical-ai-reply-previews--local-implementation-october-16-2026).

## Common contract

Explicit business and record IDs, independent grants, strict schemas, bounded
pagination and scoped related records/counts apply to every tool. Mutations use
current shared revisions and connection-scoped idempotency fingerprints/receipts.
Permissions are rechecked before retry replay. Provider work is durably queued;
queued, accepted and delivered remain distinct. Audit contains identities,
targets, requests, outcomes and revisions, never credentials or message content.
Existing browser/worker operations remain authoritative. Add missing revision
protection before exposing a write; do not invent a generic SQL/RPC/job gateway.

The executable catalog is exposed by `src/mcp/manifest.js`; SQL permission parity,
schema coverage and permission labels are checked in tests. The existing
AI connections editor uses the shared permission catalog. New grants default off.
Only the previously authorized all-business admin connection receives released
grants through the audited canonical admin path.

## Verification and deployment

Each domain requires local schema/isolation/permission/retry/audit tests and real
PostgreSQL concurrency tests for its writes, plus relevant CRM and paired E2
checks. Reconcile live aliases against both repositories and apply only the new
forward migrations. Release owning database/API contracts before dependent MCP
and UI code; E2 owns hosting and customer contracts. Record local tests, applied
migrations and deployed commits separately in both project records.

Use fresh Codex discovery and allowlisted reads/previews for live smoke checks.
Compare domain snapshots, read timestamps and send jobs. Do not mark read, send,
publish, activate, enroll or change customer records merely to verify a release.
Any later SMS pilot is separately requested and uses only +17208429167.

## Agreed exclusions

Staff access and grant administration, ownership transfers, credentials,
permanent deletion, paid purchases, legal attestations, sender binding, manual
registration reconciliation and unattended-agent credentials stay in the UI.
Do not add new appointment creation/rescheduling or one-off email composition.
Website creation, uploads/builds and domain changes are deferred. Legacy disabled
workflows, webhooks and internal maintenance/worker endpoints are not MCP tools.
Customer consent cannot be inferred from creation, enquiries or caller ID.

## Stage 1 implementation notes

Ten tools add nine separate grants. Contact creation inserts a new normalized
phone and conflicts on existing contacts, including concurrent browser inserts;
it never uses the legacy overwrite-on-conflict upsert. Contact revisions already
advance through database triggers for browser and worker updates. Name/email edits
and automation blocking reuse the canonical contact operations. Unblocking and
recording SMS opt-in never start or resume automations. Evidence/provenance remain
in consent history, not MCP receipts/audits. Email consent stays a separate domain.

Individual SMS is marketing-purpose, derives its recipient from the scoped
contact, rechecks consent/business/sender state and queues through the existing
staff-send path. As in CRM, a successful staff send pauses AI on its resulting
conversation without marking messages read. Preview has no such effect. SMS
receipt replay does not requeue or reapply takeover. Suppression cannot recall
messages already submitted to a provider.

## Final verification — October 16, 2026

The final operations migration was the only new migration applied in stage 9
(146 to 147 reconciled history entries). Nine live function hashes matched the
rollback rehearsal and no private helper grants leaked. Final CRM checks: 686
passed / 29 existing skips; E2: 248 tests plus six worker tests; both paired
suites: 63; builds and real PostgreSQL concurrency passed.

Fresh Codex discovered 153 tools with 104 admin grants and completed 52 scoped
reads/previews, each audited, with zero mutation receipts. Domain snapshots and
security advisors were unchanged. Both test runs remain stopped with no next
send, and the existing unread reply remains unread. No live send, publication,
activation, enrollment or customer edit was used to verify the rollout.
