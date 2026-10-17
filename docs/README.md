# Documentation index

This directory documents the current CRM for developers, operators and staff. Historical release observations are collected in the [project record](../PROJECT_RECORD.md); a recorded deployment is not a fresh live verification.

## Reading paths

| Reader | Recommended order |
| --- | --- |
| CRM staff | [User guide](USER_GUIDE.md), then the specialist guide for the task |
| External agent / MCP integrator | [MCP documentation](CRM_MCP.md), [connection quick start](mcp/QUICKSTART.md), [generated tool reference](mcp/TOOLS.md) |
| New developer | [Root README](../README.md), [development](DEVELOPMENT.md), [architecture](ARCHITECTURE.md), [API reference](API_REFERENCE.md) |
| Deployment operator | [Configuration](CONFIGURATION.md), [hardening release](HARDENING_RELEASE.md), [operations](OPERATIONS.md), [worker deployment](WORKER_DEPLOYMENT.md), [project record](../PROJECT_RECORD.md) |
| E2 integrator | [Website integration](WEBSITE_E2_INTEGRATION.md), [staff registry](STAFF_CRM.md), [database inventory](DATABASE_INVENTORY.md) |

## Guide ownership

| Guide | Authoritative topic |
| --- | --- |
| [Architecture](ARCHITECTURE.md) | Runtime, code layout, workers, authentication and data flows |
| [Development](DEVELOPMENT.md) | Local modes, commands and test strategy |
| [Configuration](CONFIGURATION.md) | Environment variables, public/private settings and configuration generation |
| [CRM MCP](CRM_MCP.md) | External-agent documentation entry point and architecture boundary |
| [MCP quick start](mcp/QUICKSTART.md) | Remote OAuth connection, pending activation and first scoped read |
| [MCP tool reference](mcp/TOOLS.md) / [JSON schemas](mcp/tool-catalog.json) | Generated wire catalog, permissions and synthetic request examples |
| [MCP workflows](mcp/WORKFLOWS.md) | Explicit IDs, revisions, idempotent retries and action boundaries |
| [MCP administration](mcp/ADMIN.md) | Staff/client identity, grants, revocation and activity |
| [MCP troubleshooting](mcp/TROUBLESHOOTING.md) | Compatibility evidence, transport/auth failures and support |
| [MCP release status](MCP_ROLLOUT.md) | Current recorded baseline, exclusions and release procedure |
| [AI reply diagnostics](AI_REPLY_DIAGNOSTICS.md) | Preview scope and historical Business Info provenance |
| [API reference](API_REFERENCE.md) | Current endpoint contracts and integration examples |
| [User guide](USER_GUIDE.md) | Daily staff procedures and screen navigation |
| [SMS linking release](CRM_LINKING_RELEASE.md) | October 1 linking contracts, access matrix, migration order and release evidence |
| [Business lifecycle](BUSINESS_LIFECYCLE.md) | Customer registration, admin profile review, service linking, visibility and paired rollout |
| [Operations](OPERATIONS.md) | Monitoring, troubleshooting, recovery and release checks |
| [Worker deployment](WORKER_DEPLOYMENT.md) | Supabase backend and static frontend deployment |
| [Hardening release](HARDENING_RELEASE.md) | October 14 local changes, paired migrations/API order, source ownership, CI and outstanding hosted validation |
| [Staff CRM](STAFF_CRM.md) | Registry permissions, ownership, identity lifecycle and compatibility rollout |
| [Website and E2 integration](WEBSITE_E2_INTEGRATION.md) | Website attribution and customer read boundaries |
| [Database inventory](DATABASE_INVENTORY.md) | Shared table responsibilities and recorded review findings |
| [Twilio businesses](multi-tenant-twilio.md) | Subaccounts, provisioning and registration |
| [Grounded AI rollout](GROUNDED_AI_ROLLOUT.md) | Knowledge approval and historical generation rollout; current agent lives in Inbound AI |
| [Email automation](EMAIL_AUTOMATIONS.md) | Email enrollment, sending, suppression and rollout |
| [Soni voice bridge](SONI_VOICE_BRIDGE.md) | Voice authentication, verification, booking and telephony setup |
| [Legacy reference](LEGACY.md) | Express, DigitalOcean, legacy credentials and migration tooling |
| [Remote OpenCode](REMOTE-OPENCODE.md) | Optional workstation tooling, independent of CRM deployment |
| [Form automations](FORM_AUTOMATIONS.md) | Current form sequences, versions, simulation, real tests and lifecycle |
| [Direct contact automations](DIRECT_CONTACT_AUTOMATIONS.md) | Reusable templates, contact enrollment, overlap and blocking |
| [Inbound AI](INBOUND_AI.md) | Current inbound agent, shadow/live gates and booking coordination |
| [Automation activity](AUTOMATION_ACTIVITY.md) | Metrics, timelines, tags and explicit outcome attribution |
| [Booking availability](BOOKING_AVAILABILITY.md) | Shared service schedules, capacity, booking gateway and migration order |
| [Business profile form](BUSINESS_PROFILE_FORM.md) | Guided draft/review editor and operational-field boundaries |
| [Twilio connections](TWILIO_CONNECTIONS.md) | Existing/shared accounts, exclusive senders and activation |
| [SMS connection summary](SMS_CONNECTION_SUMMARY.md) | Customer-safe connection/status projection |
| [Voice CRM](VOICE_CRM.md) | Staff configuration, runtime ingestion, private media and retention |
| [Customer Voice](CUSTOMER_VOICE.md) | Agent library, guided customer release and owner access |
| [CRM navigation](CRM_NAVIGATION.md) | Current areas, tool search and permitted workspaces |
| [Tabbed workspace](TABBED_WORKSPACE.md) | Retained panels, drafts and refresh behavior |
| [Workspace performance](WORKSPACE_PERFORMANCE.md) | Cache scope, warming and invalidation |
| [Dashboard design](DASHBOARD_DESIGN.md) | Shared visual structure and design implementation |
| [Phone fields](PHONE_FIELDS.md) | Country prefixes and phone-entry behavior |
| [Recovery](RECOVERY.md) | Backup inventory, isolated restore, reconciliation and incident ownership |

## E2 reference checkout

The related project is `E2local-main`, whose Git origin is `https://github.com/kittoe99/E2local.git`. These relative links assume it is a sibling of `opek-sms`:

- [E2 project record](../../E2local-main/PROJECT_RECORD.md): recorded releases, remaining verification and migration mapping.
- [E2 documentation index](../../E2local-main/docs/README.md) and [architecture](../../E2local-main/docs/architecture.md): customer application setup, runtime ownership and all maintained guides.
- [E2 reliability release](../../E2local-main/docs/reliability-release.md): main-application fixes, unapplied migrations, hosting drain/recovery requirements and remaining hosted checks.
- [E2 staff CRM](../../E2local-main/docs/staff-crm.md) and [separate logins](../../E2local-main/docs/separate-logins.md): shared identity and permission authority.
- [E2 hosting](../../E2local-main/docs/web-hosting.md): uploads, domain configuration, previews and publication.
- [E2 SMS integration](../../E2local-main/docs/sms-integration.md), [bookings](../../E2local-main/docs/bookings.md) and [dashboard cache](../../E2local-main/docs/dashboard-cache.md): customer-facing reads.

These links require the second checkout locally and may not resolve in a single-repository web viewer. In that case open the same paths in the E2 repository. Paired E2 workflow docs and project records are maintained together for shared lifecycle and authorization changes.

## Keeping documentation current

MCP checkpoint archives: [implementation](MCP_IMPLEMENTATION_HISTORY.md), [nine-stage rollout](MCP_ROLLOUT_HISTORY.md), [AI diagnostics](AI_REPLY_HISTORY.md). These preserve superseded local-only status statements. Use the current guides above for operating instructions. Run `npm run docs:mcp:check` and `npm run docs:mcp:links` when changing MCP documentation or schemas.

Update the owning guide when changing behavior, and the project record after material code, database, authentication or deployment work. Record checks actually performed, distinguish local work from deployed releases, and preserve unresolved limitations. Keep dated historical observations separate from current procedures. Use configuration names and synthetic examples rather than credentials or customer data.

Current procedures take precedence over explicitly historical sections. The
October 1 linking guide records that release's contracts and versions; it is not
the current deployed-version inventory for every component. Source filenames
and remote migration versions can differ: use the owning feature's recorded
mapping and confirm remote history before deployment.

Before publishing documentation, review `git status --short -- README.md docs
PROJECT_RECORD.md` and include intended new guides as well as edits in the
reviewed commit. A file marked `??` exists locally but is absent from that
checkout's committed tree. Validate all relative links with both checkouts,
compare endpoint/configuration lists with entrypoints, and run relevant paired
tests when shared contracts are described. Do not stage unrelated application
work or generated credentials merely to make documentation available.
