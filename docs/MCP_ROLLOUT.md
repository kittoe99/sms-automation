# CRM MCP release status and operations

## Recorded deployed baseline

Verified October 16, 2026 Denver time (October 17 UTC): **156 tools / 107 permission names**. The nine-stage rollout and AI diagnostics, Business Info provenance and hypothetical AI previews are released. All grants are available for administrators to assign; they are not automatically enabled for new connections.

| Component | Recorded release |
| --- | --- |
| CRM frontend | Runtime `bd318e5`; Render `dep-db9e94jrjlhs73eg8ed0`, live October 17 at 02:59:41 UTC |
| CRM MCP service | Same application runtime; documentation commit `0fe9035`; Render `dep-db9ec6lg1s2s738d43a0`, live 03:06:42 UTC after preview-key configuration |
| Latest CRM migration | `20261017024313_crm_mcp_ai_reply_preview.sql`, applied alone after reconciling 153 existing entries; 154 recorded entries afterward |
| Preview configuration | Server-only `MCP_AI_PREVIEW_API_KEY` configured; admin granted `ai_reply_preview` explicitly |
| Edge workers | No redeployment required for the AI-preview step |
| E2 Local dashboard | Ongoing edits intentionally held; no E2 deployment or branch push for this step |

One real Opek hypothetical preview used approved Business Info version 7 and offered the website/phone for an accurate junk-removal quote without using moving rates. Nineteen scoped Codex calls produced 21 attributed audit rows, zero mutation receipts and unchanged monitored customer/message/queue state. This was a preview, not an SMS or a new inbound AI run. Full receipts and separately dated local checks are in [PROJECT_RECORD.md](../PROJECT_RECORD.md).

## Released scope

Business setup; customer discovery; forms and saved drafts; SMS sequences, simulations and run controls; enquiry, lead and handoff management; conversation reads/replies/read marks; contacts and consent; bookings; activity attribution; knowledge and AI settings; existing email workflows; voice configuration and call diagnostics; existing website management; provider readiness and eligible operational recovery; AI diagnostics and previews.

Use the [generated reference](mcp/TOOLS.md) for exact available tools. A domain label does not imply support for every operation in that domain.

## Deliberate exclusions

Staff-access/grant administration and ownership transfers are not agent tools. Machine credentials, permanent deletion, paid purchases, legal attestations, sender binding and manual registration reconciliation are outside this MCP release. Existing staff UI/operator workflows remain authoritative where available; exclusion does not imply that every deferred feature exists in the UI.

New appointment creation/rescheduling, one-off email composition, website creation/uploads/builds/domain changes and generic worker/webhook invocation are not exposed. No generic SQL/RPC gateway exists. Customer consent cannot be inferred from creation, enquiries or caller ID.

## Local maintenance and release procedure

1. Inspect the clean release checkout and both project records; preserve ongoing CRM/E2 work. Keep shared contracts and migrations in their owning repository.
2. Regenerate the tool catalog with `npm run docs:mcp`, check it with `npm run docs:mcp:check`, and validate links with `npm run docs:mcp:links`. Run source, schema/protocol, permission/isolation and relevant paired tests for behavior changes.
3. Before any separately authorized database release, reconcile live migration versions and aliases. Verify rollback rehearsal/guards and forward-only dry run. Never replay either migration history; apply only the intended new migrations.
4. Deploy compatible schema/runtime in the feature's required order. Keep credentials server-side and preserve unrelated environment variables. A documentation change does not require an application deployment.
5. Verify health, fresh client discovery, `crm_get_access` and scoped reads. Check request attribution and unchanged customer/queue/read state for a read-only verification. A preview model call requires deliberate intent and has separate usage cost.
6. Record local checks, applied migrations, code deployments, permission changes and live verification as separate evidence. Refresh the dated baseline here only from actual release results.

For the completed AI-preview release, migration came before compatible runtime, key configuration and explicit grant. Business Info provenance had its own compatible-runtime-first sequence. Do not generalize one feature's order to another.

## Historical rollout records

The original [implementation notes](MCP_IMPLEMENTATION_HISTORY.md), [stage history](MCP_ROLLOUT_HISTORY.md) and [AI history](AI_REPLY_HISTORY.md) preserve earlier local-only/unapplied checkpoints and catalog counts. Those checkpoints are superseded by the recorded baseline above. No new migration, deployment, OAuth connection or SMS test is part of creating this documentation package.
