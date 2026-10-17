# CRM MCP documentation

This is the starting point for external agents and CRM administrators. The hosted server exposes scoped CRM operations through OAuth-authenticated Streamable HTTP.

## Start here

| Guide | Purpose |
| --- | --- |
| [Connect an external agent](mcp/QUICKSTART.md) | Server URL, OAuth, first access check and activation |
| [Generated tool reference](mcp/TOOLS.md) | Every tool, primary permission, revision inputs, annotations and schema summaries |
| [Machine-readable catalog](mcp/tool-catalog.json) | Complete wire input/output schemas and validated synthetic examples |
| [Agent workflows](mcp/WORKFLOWS.md) | Reads, revisions, retries, previews, explicit writes and delivery states |
| [Administer access](mcp/ADMIN.md) | Business scope, independent grants, disable/revoke and activity |
| [Compatibility and troubleshooting](mcp/TROUBLESHOOTING.md) | Tested clients, OAuth/transport errors and support evidence |
| [AI reply diagnostics](AI_REPLY_DIAGNOSTICS.md) | Hypothetical previews, recorded profile versions and historical limits |
| [Release status and operations](MCP_ROLLOUT.md) | Dated deployment evidence, maintenance commands and boundaries |

## Current recorded state

As verified October 16, 2026 Denver time (October 17 UTC), the deployed catalog contains **156 tools and 107 permission names**. The CRM frontend and MCP service include AI reply previews; the preview key is configured. The existing authorized admin connection has all-business scope and all 107 grants. New connections still start pending without grants. These are dated observations, not a claim about every future connection or deployment.

Endpoint: `https://e2-crm-mcp.onrender.com/mcp`. CRM issuer: `https://clerk.crm.e2local.com`. E2 Local dashboard edits remain held; this documentation task does not deploy them.

## Architecture and access boundary

A separate Node/Express service validates CRM OAuth issuer, expiry, exact resource audience, user identity and client identity. It checks canonical active staff status, connection status, grant and business scope on each operation. It exposes explicit tools rather than arbitrary SQL or generic RPC execution.

The dedicated database login is restricted to the MCP wrapper surface. Narrow additional wrappers support provider adapters and final AI-preview checks; it has no general private-schema/table access. OAuth tokens are not forwarded as CRM browser sessions. Canonical CRM and E2-owned operations retain their ownership, validation, review, consent and cache contracts.

Each connection binds CRM issuer, staff subject and OAuth client. All-business scope and action grants are separate. There is no additional CRM approval queue after an authorized agent calls a granted action. Administrators can inspect activity and disable or revoke access. Clients remain responsible for executing the user's intended task within those grants.

## Maintain this package

Run `npm run docs:mcp` after changing tool definitions, schemas, annotations or permission labels, then `npm run docs:mcp:check`. The generator initializes the real MCP server over an in-memory transport and reads `tools/list`; it invokes no tools, database, model or network endpoint. Complete schemas come from the same SDK serialization clients receive. Source changes alone do not prove deployment; record applied migrations and releases separately.

Run `npm run docs:mcp:links` for local package links/anchors. Do not put credentials, production customer payloads or active send examples in documentation. The generated requests use synthetic identifiers; schema validity does not establish business eligibility or consent.

## Historical evidence

- [Implementation checkpoints](MCP_IMPLEMENTATION_HISTORY.md): original milestone contracts and local verification notes.
- [Nine-stage rollout history](MCP_ROLLOUT_HISTORY.md): prior stage counts and deployment receipts.
- [AI diagnostics history](AI_REPLY_HISTORY.md): original diagnostics/provenance/preview checkpoints.
- [Project record](../PROJECT_RECORD.md): chronological applied-migration and release evidence, including completion entries superseding earlier pending notes.

Historical local-only/unapplied statements are preserved as evidence and are not current operating instructions.
