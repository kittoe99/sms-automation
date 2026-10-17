# AI reply previews and diagnostics

These capabilities are deployed in the recorded 156-tool / 107-permission release. See [release status](MCP_ROLLOUT.md), [external-agent setup](mcp/QUICKSTART.md) and the [generated schemas](mcp/TOOLS.md).

## Hypothetical AI reply previews

`crm_preview_ai_reply` requires separate `ai_reply_preview` access, an explicit business ID, hypothetical message, `businessRevision`, `settingsRevision` and `profileVersionId`. Obtain the business setup revision/reviewed-profile ID using `crm_get_business` under `read` and settings revision using `crm_get_ai_configuration` under `ai_config_read`.

The preview captures approved Business Info and saved AI instructions with business identity/timezone. It uses the live instruction builder and pinned inbound model, but provides no customer history, supplementary knowledge, booking state, live availability or action tools. Its returned `contextScope` is `approved_business_info_only`. It is a suggested answer, not a complete simulation of an existing live conversation.

Active staff, connection, grant, scope, revisions and a full-context fingerprint are checked before and after generation. If access or context changes, the response is discarded. No database lock spans the network request. The model cannot invoke customer actions; malformed/tool-call responses and provider failures produce sanitized errors.

Success includes the reply, exact profile ID/integer version/capture timestamp, business/settings revisions, model and prompt version, `previewOnly:true`, `actionsExecuted:false` and `messageQueued:false`. The model is called with storage disabled; question/prompt/reply are not copied into CRM audit, customer records, AI runs or send jobs. Context checks and the result write sanitized MCP activity; result attribution includes the profile ID/version.

This tool is read-only/non-destructive but external and non-idempotent: deliberate repeated previews may produce different text and incur additional usage. There is no mutation retry receipt or automatic retry. The server uses `MCP_AI_PREVIEW_API_KEY`; clients never receive it. Missing credentials fail closed. Current AI mode need not be live, but a saved AI configuration and approved Business Info are required; preview does not create defaults or activate AI.

## Recorded AI runs

`crm_list_ai_reply_runs` and `crm_get_ai_reply_run` require `ai_reply_read`. Requesting detail content with `includeContent:true` additionally requires `ai_reply_content_read`. These are separate from conversation-message access and from preview permission.

Reads scope jobs, results, actions, linked messages, counts and pagination to the authorized business. They distinguish job/result status, action outcomes and recorded delivery state; provider acceptance is not proof of delivery. Action and delivery arrays are bounded with totals/truncation flags. Content is bounded and explicitly requested; raw credentials, prompts, provider payloads and stack traces are not exposed as diagnostics.

These reads do not retry jobs, mark messages read, change settings/consent, start runs or send SMS. They update only the normal connection last-use and sanitized MCP access activity.

## Business Info provenance

| Field | Meaning |
| --- | --- |
| `profileVersionId` | Captured approved profile ID, or null |
| `profileVersion` | Captured integer version, or null |
| `profileCapturedAt` | Context capture time, or null |
| `profileVersionAvailability` | `recorded`, `not_recorded`, or `no_approved_profile` |

New inbound results capture trusted provenance from their leased context. Same-lease reads retain that snapshot; a new generation/lease may use newer Business Info. Existing historical runs and unfinished results without stored provenance remain `not_recorded`; there is no backfill from today's profile. A captured context without an approved profile is distinguished as `no_approved_profile`. Historical approved profiles remain valid evidence after later profile edits.

Diagnostic detail exposes provenance at the top level and on the run. These metadata fields do not reveal the private Business Info snapshot. Preview provenance describes that hypothetical generation and does not create a historical inbound run.

## Release and validation evidence

CRM owns diagnostics migration `20261016222634`, provenance migration `20261016235631` and preview migration `20261017024313`; all are applied in the recorded baseline. No E2 runtime change was required for these steps. Earlier local-only statements are retained in [AI history](AI_REPLY_HISTORY.md), not used as current status.

The preview implementation passed 737 CRM tests (29 existing skips), 63 paired contract tests, 248 E2 tests and focused schema/isolation/revocation/redaction tests, plus disposable PostgreSQL concurrency checks. These are implementation-time results, not tests rerun for this documentation edit. The separately authorized live preview recorded Business Info version 7 with no customer/message changes. See [project records](../PROJECT_RECORD.md) for exact release receipts and boundaries.
