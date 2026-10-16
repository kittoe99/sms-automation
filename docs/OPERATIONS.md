# Operations and troubleshooting

Use this guide for deployment preparation, monitoring and ordinary recovery. [Worker deployment](WORKER_DEPLOYMENT.md) owns setup details; [Recovery](RECOVERY.md) covers backup inventory, isolated restoration, provider reconciliation and incident ownership. The [project record](../PROJECT_RECORD.md) records prior release evidence. Nothing here implies a fresh live inspection.

## Release preparation

1. Identify the change's owner: SMS runtime/schema here, shared registry/customer/hosting changes in E2. Review the latest migration definitions and remote-history mapping before applying an additive migration. Never replay an entire checkout over the shared database.
2. Run affected offline tests and build the frontend when relevant. Validate changed Edge entrypoints with Deno. Inspect private runtime configuration using [configuration](CONFIGURATION.md), without displaying secrets.
3. Keep new queues, businesses and sending disabled while preparing roles and functions. Existing sending state is an independent operational decision.
4. Deploy backend changes with the import map and complete relative dependency graph, then compatible frontend assets. Supabase CLI syntax should be checked through the installed command's `--help`; the repository's per-function packager can prepare deployment payloads but does not deploy them.
5. Verify authentication denials, authenticated reads and intended role permissions. A worker POST with a valid token can consume real work: pause affected dispatch/sending and establish controlled test conditions first.
6. Use explicitly selected test recipients for delivery/STOP/booking/email tests. Confirm provider callbacks and original database records. Then enable the intended queue/business configuration and record the actual release and checks.

Shared identity and ownership rollout has additional report, mapping and pilot requirements in [staff CRM](STAFF_CRM.md). Bootstrap scripts that create privileged grants are not routine redeployment steps.

For the October 14 local changes, use both the [CRM hardening guide](HARDENING_RELEASE.md)
and [E2 release guide](../../E2local-main/docs/reliability-release.md). The hosting
operation migration requires stopping new mutations and draining old invocations
before applying its guards, followed by the matching E2 API before reopening.
The paginated E2 site-detail API must also precede the new CRM frontend.

## Monitoring

`GET /operations` combines generic runtime/job information with grounded-AI operational data. Business Setup exposes provisioning and readiness; Email exposes its separate enrollment/job state. These are authenticated views; investigate with the intended business selected.

| Signal | Interpretation and action |
| --- | --- |
| Oldest ready job and queue depth | Sustained growth indicates stalled dispatch, insufficient capacity or provider/database failures |
| Heartbeats and completed batches | Check alongside ready work; idle generic queues do not wake workers just to update a heartbeat |
| Expired leases | Inspect scheduler recovery and attempts; do not reset uncertain SMS attempts for convenience |
| `submission_unknown` | Provider may have accepted a send or resource creation; reconcile before retrying |
| Delivery events and error codes | HTTP 202 means queued; use callbacks/provider state to establish sent or delivered |
| Repeated handoffs / failed drafts | Check approved knowledge, group context, AI settings, provider configuration and recorded reasons |
| Form errors / intake skips | Inspect enabled form/connection, validation, consent, opt-out and lifecycle state |
| Email suppressions / unresolved jobs | Inspect business and shared-sender suppression, webhook events and retry age |

Logs emitted by workers contain event, queue/job/tenant identifiers and error codes. Keep message bodies, customer details, bearer tokens, OTPs and credential files out of diagnostics shared beyond authorized operators. Queue storage remains authoritative even if a `pg_net` wake request fails.

## Common problems

| Symptom | Checks and next step |
| --- | --- |
| Build requires WPacquisition/publishable key | Use the exact URL and `sb_publishable_` key in [configuration](CONFIGURATION.md); rebuild after edits |
| Local `/api` returns 404 | Static preview routes APIs to remote Edge Functions; check public `config.js` and browser request destination |
| Login works but directories return 401 | Check browser network Authorization header and shared versioned auth imports; the recorded September 30 fix is described in [staff CRM](STAFF_CRM.md). Refresh assets and verify the CRM issuer before changing permissions |
| 403 or no workspaces after signup | Check active account, issuer-qualified grants, selected tenant and form-only versus SMS permission; signup grants no staff access |
| CORS error / invalid session | Compare exact origin, `CRM_ALLOWED_ORIGINS`, token issuer and `azp`; local port/origin differences matter |
| “Service temporarily unavailable” | Inspect server error code and required scoped URL/role configuration; do not substitute a browser service-role key |
| Pending business cannot send | Inspect provisioning, registration, selected number, callback readiness, delivered canary and per-business sending state |
| SMS automation does not run | Check published form/direct version, activation, form enabled/archive state, run pause/stop, contact block, consent/STOP, schedule/quiet window and provider uncertainty; fixed-group SMS is retired |
| Incoming SMS receives no AI reply | Check callback sender routing, Inbound AI off/shadow/live mode, live-validation gate, approved context, paused thread, generation and sending controls; shadow intentionally sends no reply |
| Form saves but no SMS | Contact/Quote opt-in may be unchecked, evidence missing, opt-out active or automation held; storage success is distinct from enrollment |
| E2 Leads empty but SMS submission exists | Plain embeds have no E2 attribution; check connection, website/business pairing, owner cutoff and enquiry permission |
| Booking form absent from Bookings | Form submissions are intake/enquiries; they do not create operational appointments |
| Email cannot activate | Check OpenAI, Resend/Vault configuration, group context, mailing address, group enable switch and separate public-form email switch |
| Email reply missing from CRM | Inbound mailbox replies are not ingested; monitor the configured reply mailbox |
| Knowledge import has no effect on replies | Inspect extraction/embedding state and explicitly approve the version; drafts do not replace active knowledge |
| Voice lookup/update denied | Follow OTP verification and recap/confirmation requirements; verify call identity and bridge signature, not customer-provided identity alone |
| Hosted asset upload fails | E2 hosting authorization, exact-origin CORS and R2 upload CORS are separate from the SMS API |
| Website change returns `hosting_busy` | Another operation holds that website; wait for it to finish and refresh before another deliberate action |
| Website change returns `hosting_recovery_required` | Stop retries; the E2 operator must inspect the held operation and reconcile actual storage state using [operation recovery](../../E2local-main/docs/web-hosting.md#operation-recovery) |

## Initial alert thresholds and escalation

These are recommended starting thresholds for the operator to configure and
tune; this documentation change does not install monitoring or claim an on-call
rota exists. Measure only eligible ready work, excluding intentional schedule,
quiet-window, pause and shadow holds.

| Condition | Initial response |
| --- | --- |
| Cross-business disclosure, unauthorized mutation, duplicate accepted send or false booking confirmation | Treat any occurrence as urgent; contain the affected path and involve the incident lead plus CRM/E2 operators immediately |
| Eligible oldest-ready age above 5 minutes, or no progress across 3 checks one minute apart | Investigate dispatcher, admissions, scoped DB access and provider failures; escalate to database/runtime operator if unresolved |
| Repeated 5xx/configuration failures across 3 consecutive checks | Check affected function and dependencies; escalate before enabling more traffic |
| Any new `submission_unknown` | Open reconciliation work with the messaging operator; never auto-resend |
| Backup outside its agreed cadence or failed restore drill | Escalate to database/service owner; do not claim recovery readiness |
| Expired media still accessible or retention cleanup repeatedly failing | Escalate to Voice/storage operator; preserve access denial while repairing cleanup |

Choose the incident lead and named owners using [Recovery](RECOVERY.md#ownership-and-recovery-objectives).
Record IDs, timestamps and error codes; use provider-account support for provider
outages. No fixed heartbeat age alone proves a queue outage.

## Recovery rules

**SMS and provisioning uncertainty:** inspect attempt/job IDs, provider identifiers and signed callbacks. A network timeout is not proof of failure. Provisioning checkpoints must be reconciled to the exact existing child resource before another create attempt. Use the exposed reconciliation/readiness workflow where available; retain the ledger. Do not fabricate a universal retry SQL statement.

**Email:** provider payloads are saved before first submission and retried with the stable job idempotency key. The implementation holds uncertain outcomes older than its 24-hour provider-idempotency window for investigation. Email's Retry action remains subject to these rules. Resolve an obsolete enrollment to stop its future follow-ups; do not reset SMS consent while handling email suppression.

**Authentication:** refresh session and assets first, then inspect the verified issuer and explicit grants. Use [staff recovery](STAFF_CRM.md#restore-staff-access-to-a-fresh-account) for an intended administrator. Never merge accounts by matching email addresses or grant every new signup admin authority.

**Forms and ownership:** preserve original submissions and immutable attribution. Retiring a connection removes customer access under the applicable rules but does not delete history. A business transfer is not accomplished by repointing an existing form connection.

**Hosting uncertainty:** a browser or provider timeout can leave an accepted
publication/deletion. An expired operation does not permit automatic takeover.
Confirm the original invocation has stopped and R2 state is reconciled before
the E2 operator clears its exact token/generation hold. Do not use an old API
release or direct database edits to bypass the lifecycle guards. The detailed
[E2 procedure](../../E2local-main/docs/web-hosting.md#operation-recovery) owns the
inspection and reconciliation steps.

## Rollback and credential rotation

For an SMS runtime incident, disable affected queue dispatch/business sending and, when appropriate, `runtime.edge_enabled` and `runtime.scheduler_enabled`. Email has a separate dispatcher and settings; disable the affected email group/dispatch separately when the incident includes email. Requests already accepted by providers cannot be recalled. Preserve history and reconcile in-flight work before reactivation.

Revert static assets or Edge code only to versions compatible with the deployed additive schema. Prefer a reviewed corrective migration over deleting operational records or replaying historical migrations. Registry cutover and legacy cleanup have independent gates in the shared E2 maintenance procedure.

Rotate an Edge worker bearer secret together with the Vault value referenced by `edge_config`; pause its dispatcher during the change, verify denial/controlled authentication, then resume. Email shares the automation bearer. Rotate scoped database passwords together with their Edge URLs. The initialization helpers are not general-purpose rotation tools. Voice trunk/bridge secrets must match both sides of their external integration.

## Operator script classification

| Script | Side effects |
| --- | --- |
| `preflight.js` | Local set/missing report; no deployment |
| `package-edge-function.js` | Local generated package in ignored `data/` |
| `prepare-edge-secrets.js`, `prepare-edge-deployment.js` | Write local files containing secrets or deployment inputs |
| `bootstrap-workers.js`, `bootstrap-web-form-role.js`, `bootstrap-voice-role.js` | Database roles/credentials and, for worker bootstrap, a compatibility admin grant |
| `import-businesses.js`, `configure-provider.js` | Database/provider configuration; inspect exact code and target before use |
| `smoke-edge.js` | Authenticated calls to live workers; may consume jobs and contact providers |
| `check-email-live.js` | Authenticated live email-worker invocation plus signature checks; may consume jobs and send email |
| `voice-sync.js` | Reads provider calls and updates configured storage |

## Pending queue and reporting hardening

`20261014061007_queue_reporting_hardening.sql` is a CRM-owned forward migration,
locally implemented and not applied by this work. Its current SQL source is split
between one-time schema/bootstrap files and repeatable function modules; see the
[current SQL workflow](../supabase/sql/current/README.md). Validate the acceptance
backfill and index creation against database size before release; apply only the
new migration after the existing paired access/cache baseline, then deploy the
updated email worker. E2 hosting read indexes are independent.

The scheduler checks at most `scheduler_batch_size` candidates per tick, visits
up to 32 tenants and checks at most 64 candidates per tenant. Persisted cursors
rotate through quiet/disabled runs without changing their scheduled time or
invalidating customer caches. Business rules run after candidate selection.
This bounds eligibility work and prevents a tenant's quiet backlog from hiding
another tenant's eligible work; exact throughput still depends on worker caps,
database latency and provider limits.

Health rows now represent the most recent claim activity per queue, not a count
of persistent worker processes. Operational reads return at most 32 recent queue
rows; the scheduler removes up to 500 legacy heartbeat records older than a day
per tick. Empty queues may have no recent heartbeat. Check ready-job age and
dispatch activity before treating that as a fault.

Email shares automation admission and the global `edge_enabled` pause while
retaining separate provider-safe recovery. Failed/uncertain current enrollments
become paused with a reason; expired email recovery runs independently of whether
a pending email can wake a worker. Inspect the email status and provider ledger
before retrying an uncertain job. No live throughput or restore drill is implied
by these local regression tests.

## Recording a release

Record commit/release identifiers, affected components, migration filename-to-live-version mapping, actual test results, rollout switches and remaining pilot work in [PROJECT_RECORD.md](../PROJECT_RECORD.md). A successful mock test or public page response alone is not proof of authenticated workflows, telephony audio, real delivery or capacity.

## Scoped MCP operations

MCP diagnostics are business-scoped and return queue/status counts and curated
metadata, not job payloads or global worker state. Provider inventory is the saved
assigned sender, with a last-check timestamp. Use the separate provider_refresh
grant to queue the canonical read-only provider check. provider_reconcile only
inspects an explicitly selected uncertain refresh or registration operation;
number purchases, sender binding and legal setup require the existing CRM UI.

operations_retry is limited to failed non-reconciliation status refresh jobs with
no active lease and no submitted/uncertain remote outcome. Other domains retain
their own recovery tools. sending_activate requires current business/provider/
registration revisions, no pending provider work and canonical delivered-canary
readiness. Activation can release previously queued eligible sends and is a
separate permission. It does not create a new canary or enroll contacts.

All writes require idempotency keys; reread after conflicts. A repeated key with
a changed payload conflicts; identical retries return the original receipt.
Business/worker edits advance shared operational revisions. Provider operations
remain queued until workers report completion. No credentials, raw errors or
private content enter MCP output or audit.
