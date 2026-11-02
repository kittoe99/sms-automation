# Agent workflows and operation safety

Use [the generated reference](TOOLS.md) and its [full JSON schemas](tool-catalog.json) for exact field names, nested structures, optional fields and limits. The examples there are synthetic and validated against local input schemas; they are not production IDs or instructions to execute writes.

## Read and select explicitly

Start with `crm_get_access`, then discover permitted records. Business operations require an explicit `businessId`; never keep a hidden current business or substitute a customer ID. Paginate using the tool's actual schema (commonly `page`/`pageSize`, default 25 and maximum 100). Totals and nested records are scoped before being returned. `crm_get_access` business summaries are bounded; use `crm_list_businesses` for more pages.

Read conversation metadata and content without marking anything read. `crm_mark_conversation_messages_read` is a separate write for selected messages. Likewise, read AI diagnostics with `includeContent` omitted unless content access is needed and granted.

## Revisions and conflicts

Read current records immediately before a write. Pass every revision the tool requires: this may include business/settings revisions, form/draft revisions, source/target revisions or a run `generation`. These counters are not interchangeable. See each tool's **Revision inputs** and required schema fields.

On `CONFLICT`, reread the records and review what changed. Do not silently substitute a newer counter and repeat an old decision. If a revised action is still intended, submit the reviewed payload with a new idempotency key. Browser and worker changes can advance the same revisions.

## Idempotent mutations

Every mutation requires an `idempotencyKey`; its schema specifies allowed length. Generate one per intended action and persist the exact tool name and payload alongside it before sending.

- After a timeout or interrupted response, retry the **identical tool and payload with the same key**, including the original expected revisions. An existing committed result can be replayed without repeating the change.
- A changed payload or different tool using that key conflicts. Do not use a new key merely because the original response was lost.
- Authorization is checked before replay. A formerly permitted result is not returned to a revoked caller.
- A completed database operation can still report queued or unresolved provider work. Inspect the returned operation/run/job using the appropriate read tool rather than submitting a second action.

Hypothetical `crm_preview_ai_reply` is deliberately non-idempotent and has no mutation key: repeating it can incur another model call and produce different text. It executes no customer action and creates no AI run or message. Other preview tools have their own schemas and semantics; do not assume all previews call a model.

## Response and error handling

Normal tool results contain `structuredContent` with `ok`, `requestId` and either `data` or `error`. The text content also contains that JSON. Failed business operations set MCP `isError`. Input validation, JSON-RPC, HTTP and authentication failures may occur outside this envelope.

| Error | Client behavior |
| --- | --- |
| `VALIDATION_ERROR` | Fix fields according to the schema and reported business prerequisites. Do not repeatedly submit unchanged invalid input. |
| `PERMISSION_DENIED` | Check staff status, connection/grants and scoped IDs. Denied or missing records may intentionally be indistinguishable. |
| `CONFLICT` | Reread and reconcile revisions or idempotency reuse; do not overwrite automatically. |
| `TEMPORARY_FAILURE` | Inspect `retryable`. For an uncertain mutation, preserve its original key/payload; for a preview, a deliberate retry may incur another model call. |

Never log OAuth tokens or attach them to support messages. Preserve request IDs and sanitized error codes instead.

## Common sequences

| Goal | Sequence and distinct effects |
| --- | --- |
| Business setup | Read → save draft → explicitly review profile → add service → explicitly release customer visibility. Website publication and sending activation are separate. |
| Forms | Create inactive form → edit separate draft → preview saved draft → explicitly apply draft → separately enable collection. Applying preserves the current collection state; applying to an already active form changes what that live form displays. None of these implicitly enables SMS follow-ups. |
| Form SMS follow-up | Create/edit draft → simulate → publish immutable version → separately enable future follow-ups. Starting historical submissions is another granted action, subject to consent and overlap checks. |
| Direct SMS sequence | Create/edit draft → simulate → publish → inspect start context → explicitly start selected contact run. Publication alone does not enroll anyone. |
| Existing run | Read status/activity → pause, stop or resume using its current generation and a mutation key → reread activity. Resume rechecks consent/eligibility and overlap conditions. |
| Conversation response | Read conversation/revision → preview reply eligibility → explicitly reply with current revision and mutation key → inspect delivery. A successful preview neither sends nor guarantees later eligibility. Mark-read is separate. |
| AI Business Info preview | Read business setup/profile ID → read AI settings revision → call `crm_preview_ai_reply` with a hypothetical message and all three version inputs → inspect returned profile version and suggested reply. |

## Delivery and activation

Distinguish **database committed**, **provider work queued**, **provider accepted**, **delivered**, **failed**, and **unresolved**. A queued run or accepted provider request is not evidence of delivery. Follow the returned IDs through scoped activity/diagnostic reads.

Consent must come from recorded evidence. Creating a contact, receiving a quote request or knowing a phone number is not SMS consent. Separate opt-in, suppression, automation blocking, form collection, follow-up enablement and sending readiness remain authoritative. Enabling or resuming work can release eligible future messages; provider recovery tools can have external effects.

Instant acknowledgment is an explicitly configured form-sequence behavior; later steps still follow their sending-hours rules. Use simulations to inspect the actual schedule instead of assuming every step bypasses sending hours.

## AI preview and diagnostics limits

The hypothetical AI preview uses approved Business Info and saved AI instructions, not customer history, supplementary sources, live availability or action tools. It is not a full simulation of a live conversation. It records which profile version was captured in the returned metadata and sanitized result audit; the hypothetical question/reply is not persisted as an AI run.

Historical AI runs without captured provenance remain `not_recorded`; never assign today's Business Info version to them. See [AI diagnostics](../AI_REPLY_DIAGNOSTICS.md).

## Reusable email automation MCP — November 2, 2026 (local)

Added 16 MCP tools and eight opt-in `email_automation_*` grants. The source catalog
now has 172 tools and 115 permissions. Existing email group tools keep their legacy
scope and grants. The new workspace read includes reusable template content,
contacts and consent status; grant it only when that combined access is intended.

Use `crm_get_email_automation_workspace`, create/save a formatted template, preview
its draft at the current revision, then publish. Configure a verified sender and
reply-to with `crm_set_email_automation_settings`. Connect future form, contact
opt-in or booking events with `crm_connect_email_template`, or explicitly start one
eligible marketing contact with `crm_start_email_template_run`. Consent recording
can trigger an enabled contact opt-in connection. Pause/resume/stop/retry require
current run revision and generation. Publication can affect future event enrollments;
activation/resume/start can schedule real Resend delivery. None bulk-enrolls history.

All mutations require UUID idempotency keys. Preserve the exact payload/key after
an uncertain response. Database permission, active staff and business scope checks
run before replay. Mutation receipts and MCP audit records exclude template bodies,
recipient addresses and consent evidence. Private canonical operation records keep
their existing restricted retention. Form/SMS state and provider retry fencing remain
owned by the shared email workflow. DNS provisioning stays in the staff workspace.
The workspace is bounded to 100 templates/connections/forms/contacts and 25 runs/jobs
per activity page; it is not an exhaustive export or contact search.

MCP business service schemas now accept `email`, including business detail results.
A forward preview patch prevents later sequence steps appearing before earlier steps.
Preview times assume prompt processing and do not establish provider delivery.

CRM owns `20261102181913_mcp_reusable_email_automations.sql` and
`20261102181936_email_preview_sequence_order.sql`. Apply after the original CRM
`20261102051753_reusable_email_automations.sql`; E2's existing
`20261102051756_customer_email_service.sql` is required for adding/releasing Email
services. Reconcile live history and apply only missing forward migrations, then
release CRM/MCP and the original paired E2 changes before enabling new grants.
No live migrations, deployments, grants, DNS changes or real sends were performed.
