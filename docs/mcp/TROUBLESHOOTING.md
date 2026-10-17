# Client compatibility and troubleshooting

## Compatibility evidence

| Client type | Current evidence |
| --- | --- |
| Codex | CRM OAuth sign-in, refresh/reconnect, discovery and scoped operations verified; latest release discovery found 156 tools. |
| Other desktop/server agents | Protocol-compatible in principle; individual products have not been verified by this rollout. Require Streamable HTTP, compatible OAuth/PKCE and CIMD onboarding, exact resource audience and client token refresh/storage. |
| Browser-hosted client | Also requires its explicit Origin in `MCP_ALLOWED_ORIGINS`. CORS is not authentication. |
| Legacy SSE-only or stdio-only client | Cannot connect directly to this remote stateless POST endpoint. A compatible client/adapter would need separate validation and OAuth handling. |
| Fully unattended machine credentials | Not implemented. Machine subjects, token-exchange actor chains and backend/API-key substitutes are rejected. |

This guide deliberately does not claim tested Claude, Cursor, n8n or custom-client compatibility. Check the chosen client's current documentation and validate its login and read-only discovery before using writes. No additional client was connected while creating this package.

## Diagnose the layer

| Symptom | Check |
| --- | --- |
| MCP endpoint shows an error in a browser | `/mcp` is an authenticated protocol endpoint, not a web page. The read-only [health endpoint](https://e2-crm-mcp.onrender.com/health) should return service status. Health does not prove OAuth/DB/grant readiness. |
| HTTP 401 / `invalid_token` | Use CRM-issued OAuth access token, exact `/mcp` resource audience and a valid unexpired staff identity/client. Refresh or sign in again through the client; do not use E2 customer/browser/backend credentials. |
| Login works but tools deny access | Call `crm_get_access`. A new connection starts pending; verify staff status, activation, businesses and independent permissions in Administration → AI connections. |
| CIMD or client-registration error | Confirm the client supports HTTPS client-metadata URLs and PKCE S256. The verified deployment advertises CIMD; DCR-only onboarding is not a confirmed connection path. Do not change issuer/client registration settings blindly. |
| HTTP 403 / Origin denied | Operator checks the exact browser Origin against `MCP_ALLOWED_ORIGINS`; also check expected service Host. Keep explicit origin restrictions. |
| HTTP 405 | The service uses POST Streamable HTTP and OPTIONS. It does not provide a long-lived GET/SSE stream or DELETE session endpoint. Use the correct transport. |
| HTTP 413 | The server caps request bodies at 512 KiB; individual schemas often have smaller limits. Reduce payload size. |
| Missing newly released tool or outdated output validation | Refresh/reconnect the MCP client to load a fresh `tools/list` catalog. A long-running client may cache old schemas. Discovery alone does not activate grants. |
| Conflict after a browser/worker edit | Reread the current record(s), reconcile intent and submit a new reviewed action. For an uncertain prior response, retain the original mutation payload/key. |
| AI preview temporary failure | Operator checks server-only `MCP_AI_PREVIEW_API_KEY`, model availability, provider timeout and sanitized service errors. Clients do not receive this key. A retry is another model invocation. |
| Queued work has no delivery | Inspect the operation/run activity and provider readiness. Do not infer delivery, automatically retry uncertain work or start a second run. |

## Report a problem

Record client name/version, transport, approximate UTC time, tool name, request ID, sanitized error code and whether the operation was a read, preview or write. Never include access/refresh tokens, provider keys, database URLs or unnecessary customer messages. An authentication failure may have no CRM request ID; record its HTTP status and timestamp.

Use [workflows](WORKFLOWS.md) for retry handling and [release status](../MCP_ROLLOUT.md) for dated deployment evidence. An integration issue does not authorize production data changes or a live SMS test.
