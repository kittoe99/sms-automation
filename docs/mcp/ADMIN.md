# Administer agent access

Open [Administration → AI connections](https://crm.e2local.com/?view=platform-ai-connections) using the CRM's existing authorized staff administration identity. Agents cannot grant themselves permissions through MCP.

## Activate a connection

1. Ask the staff member to sign in through their client and call `crm_get_access`.
2. Match the pending connection's verified staff identity and OAuth client. Do not identify it by an agent's claimed name alone.
3. Select specific permitted businesses, or explicitly choose all-business scope if that is intended. All-business scope includes businesses added later; it does not grant actions by itself.
4. Grant the actions the agent needs independently. Start with reads for a new integration, then add writes deliberately. The [generated permissions table](TOOLS.md#permissions) lists every grant.
5. Save as active. Have the client reread `crm_get_access` and verify one scoped read.

Saving grant changes uses the connection's current revision. On a conflict, reread the connection and reconcile the intended change rather than replacing someone else's newer grants.

## Conditional access

The tool reference shows each tool's primary grant. Additional gates include:

| Capability | Additional boundary |
| --- | --- |
| Customer search/detail | `read` is required; `global_customer_lookup` separately permits lookup beyond allowed-business associations. It does not grant access to those businesses. |
| Conversation detail with message content | `conversation_messages_read` is separate from `conversation_read`; mark-read and reply are independent writes. |
| AI run detail with `includeContent: true` | `ai_reply_content_read` is separate from `ai_reply_read`. |
| AI reply preview | `ai_reply_preview` authorizes generation. `read` and `ai_config_read` let the client obtain the current business/profile/settings revisions first. |
| Starting an SMS run with overlap replacement | `automation_run_start` is required; stopping selected overlaps also requires `automation_run_pause_stop`. |
| Related record or provider work | Current business scope, record ownership/linkage, revisions, consent and readiness are still checked. A broad grant does not bypass these conditions. |

The source schema and canonical operation remain authoritative for conditional checks. Some grants allow actions that queue real messages, publish websites or alter live collection. A read-only tool annotation is not a substitute for reviewing a workflow's effects.

## Disable or revoke

- **Disabled** temporarily blocks business operations and can be reactivated by an authorized administrator.
- **Revoked** is terminal for that staff/client identity pair in the current implementation; it cannot be reactivated. Use Disabled for a reversible pause.
- Staff suspension or removal also blocks subsequent calls. Permission/scope changes take effect on subsequent checks without waiting for a new login. AI previews recheck authorization after generation and discard output if access changed.

Revocation does not undo a committed change, cancel every previously queued job or recall a provider-accepted message. Manage existing work through the corresponding CRM workflow when needed.

## Inspect activity

Use the connection's activity history to inspect actor, connection, tool, target, timestamp, request ID, outcome and affected revisions. Provide `requestId` when investigating an error. Profile drafts, prompts, preview replies, tokens and credentials do not belong in audit entries. Some successful writes have private retry receipts containing their result; those are separate from the sanitized activity log.

Authentication failures before a trusted connection is established cannot be attributed to a CRM actor. A tool's presence in discovery, a valid login and an active connection are separate checks; none implies that every tool is permitted.

See [troubleshooting](TROUBLESHOOTING.md) and [release/operations procedures](../MCP_ROLLOUT.md).
