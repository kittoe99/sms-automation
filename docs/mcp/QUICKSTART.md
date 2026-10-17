# Connect an external agent

Use this guide for an MCP client acting on behalf of a CRM staff member. No OpenAI, Clerk backend, Supabase or database secret is supplied to the client.

## Connection settings

| Setting | Value |
| --- | --- |
| Suggested connection name | E2 CRM |
| Server URL | `https://e2-crm-mcp.onrender.com/mcp` |
| Transport | Streamable HTTP, stateless POST requests |
| Authentication | OAuth authorization code with PKCE S256 |
| CRM issuer | `https://clerk.crm.e2local.com` |
| OAuth resource/audience | Exact server URL above, including `/mcp` |
| Requested scopes | `profile offline_access` |
| Client onboarding | CIMD (Client ID Metadata Documents) |

The server publishes [protected-resource metadata](https://e2-crm-mcp.onrender.com/.well-known/oauth-protected-resource/mcp) and [authorization-server discovery](https://e2-crm-mcp.onrender.com/.well-known/oauth-authorization-server). Let the client discover authorization/token endpoints instead of hardcoding them. Discovery and `/health` are readable from any browser Origin; the same authorization metadata is also served at `/.well-known/oauth-authorization-server/mcp` and `/.well-known/openid-configuration` for older clients. OAuth scopes identify the staff member and permit refresh; CRM business/action grants are managed separately.

## First connection

1. Add the server URL in your client's remote MCP settings and select OAuth. Client-specific configuration formats vary; the settings table above is not a universal JSON configuration.
2. Complete CRM sign-in and consent in the browser. Use a CRM staff identity; E2 customer login does not grant staff access.
3. Initialize MCP, discover `tools/list`, and call `crm_get_access` with `{}`. A newly verified staff identity/client pair creates a pending connection with no business access. Merely discovering tools does not authorize their use.
4. An administrator opens [Administration → AI connections](https://crm.e2local.com/?view=platform-ai-connections), identifies that staff member/client, selects businesses and action grants, and activates the connection. See [administration](ADMIN.md).
5. Call `crm_get_access` again. Confirm `status: active`, the expected business scope and permission names. With the `read` grant, call `crm_list_businesses` using `{"page":1,"pageSize":25}`. Select an explicit returned business ID for subsequent operations.

The current release has 156 tools and 107 permission names. A connection does not need every permission. Existing Codex grants do not automatically transfer to a different OAuth client. The connection is identified by issuer, verified staff subject and client ID, not by device or chat; another session using that same pair can reuse its grants.

## Custom agents

Use an MCP client SDK that supports Streamable HTTP and this OAuth flow. Implement an OAuth token store and refresh handling; keep access/refresh tokens private to the authorized client. Send the access token as `Authorization: Bearer …` to the MCP resource. Do not forward a CRM browser session or use a backend secret as the bearer token.

For CIMD, the client supplies an HTTPS client-metadata URL as its OAuth client ID, with appropriate redirect URIs. Discovery, redirect validation and PKCE should be handled by a compatible OAuth implementation. [Clerk's MCP integration guide](https://clerk.com/docs/expressjs/guides/ai/mcp/build-mcp-server) explains CIMD onboarding. The current deployment advertises CIMD; DCR-only clients have not been validated and must not be assumed compatible.

Browser-hosted clients also need an explicitly allowed Origin on the MCP service. Server-side clients do not bypass OAuth or business grants. Do not disable origin checking to make a browser client connect.

## First safe tasks

- Inspect `crm_get_access` and list businesses under `read`.
- Inspect saved forms using `form_read`.
- Inspect conversation metadata with `conversation_read`; message content additionally needs `conversation_messages_read`. Reads do not mark messages read.
- Preview a hypothetical Business Info answer using `read`, `ai_config_read` and `ai_reply_preview`; this incurs model usage but does not send or create a customer record.

Use [workflows](WORKFLOWS.md) for revision and retry rules, and the [generated reference](TOOLS.md) for exact input/output schemas. Do not begin a connection test with sending, publishing, activation, enrollment or recovery tools.

## Supported boundary

Codex OAuth, refresh/reconnect, discovery and scoped calls have been verified. Other clients require their own compatibility check; see [troubleshooting](TROUBLESHOOTING.md). Fully unattended service-account/client-credentials access is not implemented. A user-authorized client can refresh its user session where supported, but that is not an independent machine identity or unrestricted credential.
