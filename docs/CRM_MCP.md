# CRM MCP business setup

## SMS milestone production rollout — October 14

The five SMS migrations have been reconciled, rehearsed with rollback and applied
to the shared production database. No historical migration was replayed.

| Source version | Applied remote version | Migration |
| --- | --- | --- |
| 20261015043000 | 20261015054022 | crm_mcp_sms_reads |
| 20261015043001 | 20261015054030 | crm_mcp_sms_drafts_preview |
| 20261015045955 | 20261015054032 | crm_mcp_sms_publish_enable |
| 20261015050856 | 20261015054034 | crm_mcp_sms_run_start |
| 20261015052336 | 20261015054036 | crm_mcp_sms_run_controls_activity |

Post-apply function hashes match the tested definitions; restricted helper access
remains denied. Runs/messages/jobs remain 0/2/9. Security advisors are unchanged:
68 informational private/default-deny RLS findings and five warning findings.
MCP/frontend release and no-send Codex verification are in progress. The owner
authorized all nine SMS permissions for the existing all-business admin connection.
The implementation notes below retain their historical local-only status; this
section records the current rollout state. No E2 runtime release is required.

## SMS milestone, step 5 — local run controls and activity

The local catalog now contains 26 tools. Existing connection grants are unchanged.
This step and the four earlier SMS increments remain unapplied and unreleased.

| Tool | Required grant | Purpose |
| --- | --- | --- |
| `crm_list_sms_runs` | `automation_activity` | Discover runs, current generations and contact revisions within an explicit business. |
| `crm_get_sms_run` | `automation_activity` | Inspect one run before controlling it. |
| `crm_get_sms_run_activity` | `automation_activity` | Inspect paginated events and lifetime accepted/delivered/failed, unresolved-send and attributed-response counts. |
| `crm_pause_sms_run` | `automation_run_pause_stop` | Pause future work for an active/paused run. |
| `crm_stop_sms_run` | `automation_run_pause_stop` | Permanently stop an active/paused run. |
| `crm_resume_sms_run` | `automation_run_resume` | Resume a paused run after checking current consent and eligibility. |

Every tool requires businessId. Single-run tools also require runId. The list
supports kind (`form`/`contact`), automationId (with kind), contactId and status.
Related IDs are checked within the business before filtering or counting. List
and event pages default to 25, cap at 100, and use newest-first order with an ID
tie-breaker. Counts are scoped before pagination. These are live reads: newly
recorded events can move page boundaries. Activity permission is independent of
automation_read and the control grants; grant it when an agent must discover
current run generations. No global-customer-lookup grant broadens these reads.

Controls require generation and an 8–128 character idempotencyKey; resume also
requires contactRevision from a fresh run read. Use the same key/payload after
an interrupted response. Identical retries return the original committed result;
changed payloads/tools conflict. On a stale revision, reread before deciding on a
new request. Current staff, connection, action and business grants are checked
before replay. Transaction rollback removes the operation and both retry records.

Resume requires a paused run, an existing consenting contact, no STOP, active
business sending, a future appointment when applicable, and canonical run-enabled
settings (including enquiry blocks, direct runtime and form state). Unresolved
submitting/submission_unknown jobs prevent resume. Canonical operations retain
the run's immutable published rules and message position; publishing newer rules
does not replace them. Stopped/completed runs cannot resume. Other overlapping
runs are untouched. No tool edits consent, source settings or business sending.
Pause/stop do not require current consent or sending to be enabled. Historical
form recipients lacking contacts can use the canonical form pause/stop workflow;
they cannot resume without a current consenting contact. Test snapshots are
identified explicitly and may have a null publishedVersion.

Phone coordination, contact/source locks and the run generation protect against
concurrent CRM/worker changes. Each control increments the generation so queued
work must pass the existing final-send checks. Provider-submitted messages cannot
be recalled. Responses include databaseStatus=committed, effect, resulting run
generation and deliveryStatus=not_sent_by_this_operation. inFlightMayDeliver
identifies unresolved jobs or accepted messages awaiting a terminal delivery
status. A false value is a snapshot, not a guarantee against future delivery.

Activity exposes event IDs, kinds, timestamps, attribution revisions,
historical/simulated flags and allowlisted state/operation fields. It excludes
raw details, message bodies, phone numbers, submission answers and unrelated or
unlinked activity. Accepted and delivered counts are distinct; historical events
can have unknown occurrence times. This is per-run inspection, not the CRM's
date/cohort conversion report or attribution/tag editor. MCP audits record actor,
connection, request, tool, run and affected generation without customer content.

CRM owns pending `20261015052336_crm_mcp_sms_run_controls_activity.sql`. Apply it
only after the four pending SMS migrations listed below, following live alias
reconciliation; never replay either repository's history. Future rollout needs
CRM API/frontend/MCP releases. E2 customer permissions, contracts and caches are
unchanged; no E2 schema/runtime release is needed for this step.

## SMS milestone, step 4 — local run starts

Run starts are implemented locally for published direct-contact templates and
historical form submissions. No pending SMS migration has been applied, no
service was deployed, and no connection received new grants.

| Tool | Required grant | Purpose |
| --- | --- | --- |
| `crm_get_sms_run_start_context` | `automation_read` | Read source/contact revisions, submission fingerprint and complete scoped overlap references before enrollment. |
| `crm_start_sms_automation_run` | `automation_run_start` | Schedule one real run using published rules and an explicit overlap choice. |

Both require explicit businessId, kind (`contact` or `form`) and automationId.
Direct targets require an existing contactId; forms require submissionId from
that exact form/business. Context returns automation revision, formRevision
where applicable, contactId/contactRevision (nullable for legacy form history),
submissionFingerprint for forms, overlaps as ID/generation pairs, and any run
already enrolled from the submission. No submission answers, phone, consent
evidence or message bodies are returned. This is context, not an eligibility
promise. Overlaps are limited to 100; larger sets require CRM management first.

Start requires current revision and contactRevision, the complete overlaps array,
overlapChoice (`keep` or `stop_selected`), and an idempotencyKey. Form starts also
require current formRevision and submissionFingerprint. Changes to submission
details invalidate the fingerprint; the tool never rewrites the submission.
Direct starts optionally accept request context (up to 2,500 characters) and
startAt with an explicit timezone. The canonical scheduler clamps a past direct
start to now and applies sending windows. Forms use their recorded answers,
appointment and canonical historical-enrollment schedule. No sequence/name,
consent, arbitrary recipient or publication overrides are accepted.

The database coordinates by business/phone, locks current source/contact/run
records and checks revisions again. Consent/STOP, enquiry blocks, current
business sending/active state, published/non-archived sources, direct runtime
and form collection/follow-up settings are enforced. Form history also requires
its recorded SMS opt-in; past appointment reminders cannot be started. Existing
worker/final-send/provider/quiet-window checks remain authoritative after scheduling.
Starting never grants consent or changes sending/provider settings.

Keeping overlaps requires an explicit choice. stop_selected requires nonempty
stopRunIds drawn from the same overlap set and the additional
`automation_run_pause_stop` grant. That grant is rechecked even for result replay.
Replacement stops selected runs and increments their generations in the same
transaction as starting the new run. Failure rolls back both. Enquiry overlaps
include active/paused form and direct runs for this business/phone; appointment
starts compare runs for the same appointment timestamp. Unrelated businesses,
recipients and appointments are excluded. Canonical same-form duplicate rules
still apply: keeping another active/paused run for the same form/recipient/time
returns CONFLICT instead of silently skipping enrollment.

A submission already enrolled returns effect=already_enrolled and its existing
run identity/state; it never resumes or restarts that run, including stopped or
completed runs. A successful new start returns effect=run_scheduled, published
version, run ID/generation/status/nextRunAt, stopped run IDs/generations and
databaseStatus=committed. deliveryStatus=not_sent_by_this_operation makes clear
that the tool schedules work; it does not claim provider acceptance or delivery.
Identical retries return the original transactional result. Changed payloads
conflict; grants and business scope are rechecked before replay. Use a new key
only for a new intended enrollment, after rereading context on conflict.

Audit records identify the created/existing run and generation; replacement
records also identify each stopped run and resulting generation. Recipient
content and request context are excluded. Private helpers cannot be called by
the restricted login. The canonical CRM historical-enrollment wrapper now takes
the same phone-before-form lock order as MCP/public submission enrollment to
avoid a lock inversion; its consent/enrollment behavior is otherwise unchanged.

CRM owns pending `20261015050856_crm_mcp_sms_run_start.sql`, after reads
`20261015043000`, drafts/preview `20261015043001`, and publication/enabling
`20261015045955`. Reconcile live aliases before a future forward-only rollout of
these four migrations, then release CRM API/frontend/MCP. E2 ownership, customer
visibility, readers and cache contracts remain unchanged. Step 5 above adds
standalone resume, pause/stop and activity tools locally.

## SMS milestone, step 3 — local publication and form state

Two additional tools are implemented locally. Existing connections receive no
new grants, and none of the three pending SMS migrations has been applied or
released.

| Tool | Required grant | Input beyond businessId |
| --- | --- | --- |
| `crm_publish_sms_automation` | `automation_publish` | kind (`form` or `contact`), automationId, revision, idempotencyKey; forms also require formRevision |
| `crm_set_form_followups_enabled` | `automation_enable` | automationId (form ID), revision, formRevision, enabled (boolean), idempotencyKey |

Publication validates and snapshots only the saved draft while holding its row
lock. It accepts no replacement sequence or name, so publication permission
cannot bypass the separate draft-edit grant. It calls the canonical publication
operation, increments the version/revision, and preserves existing run snapshots
and enabled state. If a form is already enabled, future eligible submissions use
the new published version. Direct-template publication never starts a contact run.

Enabling requires a non-archived, collecting form with published rules, through
the canonical form-state operation. It neither enables public form collection
nor changes business sending, service visibility or provider setup. Enabling
does not enroll historical submissions or resume paused runs. Disabling pauses
active runs belonging to that form with the canonical AUTOMATION_PAUSED reason
and increments their generations; other forms and direct runs are unaffected.
This is part of the `automation_enable` grant. Individual run controls still
require their separate grants/tools described in step 5.

Both tools recheck staff/connection/action/business permissions, require current
sequence/template revisions, and require the current form-definition revision
for form actions. Concurrent draft or form edits return CONFLICT for a reread.
Every write requires an 8–128 character idempotency key. Identical retries return
the original transaction result, even if its revision is now old; changed tool
or payload conflicts. Revoked permissions/business access prevent replay. A new
key with the current revision intentionally creates another publication/state
operation. Rollback leaves no partial version, state or retry record.

Results contain businessId, the resulting automation summary/revisions,
databaseStatus=committed, and effect (`published_version_created`,
`form_followups_enabled` or `form_followups_disabled`). They do not claim message
delivery. Activity attributes actor, connection, request, target and resulting
automation revision without copying draft bodies or customer data. The helper
is private; the restricted login retains only the guarded MCP gateway.

CRM owns pending `20261015045955_crm_mcp_sms_publish_enable.sql`, following
`20261015043000_crm_mcp_sms_reads.sql` and
`20261015043001_crm_mcp_sms_drafts_preview.sql`. Reconcile live aliases before
applying only these three forward migrations in order, then release the CRM
API/frontend/MCP. E2 contracts and runtime are unchanged. All-business scope
continues to include future businesses, but SMS permissions remain opt-in.
Step 4 adds run starts; standalone resume/pause/stop and activity inspection are next.

## SMS milestone, step 2 — local implementation only

Draft creation/editing and simulation are implemented locally after step 1. The
production pilot and its grants remain unchanged; neither pending SMS migration
has been applied or released.

| Tool | Grant | Contract |
| --- | --- | --- |
| `crm_create_sms_automation` | `automation_draft` | Create an unpublished contact template with `name`, or the first follow-up draft for an existing form with `automationId` and `formRevision`. |
| `crm_save_sms_automation_draft` | `automation_draft` | Replace the full draft using `automationId`, current `revision`, and either form `formRevision` or contact-template `name`. |
| `crm_preview_sms_automation` | `automation_preview` | Simulate `source=draft` (default), `published`, or unsaved `input`; `sequence` is accepted only for `input`. |

All three require explicit `businessId` and `kind=form|contact`. Creation and
editing require a new `idempotencyKey` (8–128 characters) for each intended change.
An identical retry returns the recorded result; changed payloads conflict. Stale
revisions require a fresh read. Form-field edits also invalidate `formRevision`.
Archived forms/templates cannot be edited. Draft saves call the canonical form
workspace or direct-template operation and return the resulting summary/revision.
Published versions, enabled state and existing run snapshots are preserved.
Creating public forms remains in the CRM UI.

Preview requires an existing form/template ID, its current revision, formRevision
for forms, and explicit `submittedLocal` (`YYYY-MM-DDTHH:mm`) in the business's
timezone. Forms use `sample` answers including booking `appointmentLocal` when
required. Direct previews use either a sample or `contactId` plus current
`contactRevision`; optional `context` renders `{{request}}`. The sample contains
name, E.164 phone, email and smsOptIn; form samples may include typed custom
details. A form without a draft can preview `source=input`. No sample creates or
updates a contact. Existing same-business consent, STOP and enquiry blocks remain
authoritative even when a sample says smsOptIn=true.

The response identifies source revisions/version, business timezone, simulated
start, rendered messages/times, configured send total, truncation and warnings.
It includes a SHA-256 fingerprint of the inputs and relevant source context;
this detects changed simulations and is not an approval or execution token.
Forms return at most 200 rows and contact sequences at most 50. Missing fields,
oversized personalized bodies, sending windows, repeats, appointment cutoffs and
reply/opt-out scenarios follow the shared scheduler. Continue after a simulated
first reply observes the 30-minute quiet wait for enquiry sequences. DST gaps in
submittedLocal are rejected; ambiguous fall-back times use PostgreSQL's standard
time interpretation. Live replies, overlap and delivery holds may change actual
sending; readiness is only a setup snapshot.

Preview creates no drafts, leads, contacts, runs, jobs, messages or retry records;
normal MCP access/audit bookkeeping remains. Audit records include source/result
revision and target ID, excluding sample answers, request context and message
content. Each call independently checks its grant, connection, staff and business
scope. Draft/preview grants do not imply read, publish, enable or run-start grants.
Strict schemas bound sequences to 50 messages and bodies to 1,600 characters;
the authenticated HTTP body limit is 512 KiB.

CRM owns pending `20261015043001_crm_mcp_sms_drafts_preview.sql`, immediately after
pending `20261015043000_crm_mcp_sms_reads.sql`. It adds private wrappers/simulation,
aligns the direct validator with the already-supported `{{request}}` token, and
shares the pure rendering routine with canonical form preview. Consequently the
ordinary form preview also simulates Continue's quiet wait and enquiry blocks.
It does not change E2 contracts or require an E2 migration/runtime release.

Future rollout must reconcile live aliases and apply the pending migrations in
the order documented in step 3, then release CRM API, frontend and MCP. SMS grants
stay opt-in. Step 3 adds publishing/enabling; run lifecycle and activity tools
remain subsequent increments. See both project records for local checks;
the historical production rollout below must not be replayed.

## SMS milestone, step 1 — local implementation only

This increment adds four scoped read tools and nine independent SMS permission
names. It has not been applied or released. The production pilot and its six
business-setup grants remain unchanged.

| Tool | Input beyond businessId | Result |
| --- | --- | --- |
| `crm_list_sms_automations` | Optional kind, q, includeArchived, page/pageSize | Form/contact-template summaries and filtered total |
| `crm_get_sms_automation` | kind (`form` or `contact`), automationId | Draft, published rules/version, revisions, supported fields, readiness blockers |
| `crm_search_sms_contacts` | Optional q, page/pageSize | SMS contact identity, revision, consent/opt-out/block flags |
| `crm_list_form_submissions` | formId, optional page/pageSize | Submission identity, consent flag, matching contact revision and scoped run reference |

All four require `automation_read`; neither `read` nor global customer lookup
grants access. Pagination defaults to 25 and caps at 100, with a stable ID tie
breaker. Missing/foreign references return the same permission error. The catalog
includes forms without sequences so agents can discover where to create follow-ups.
Contact templates have null enabled/form fields: they are started individually.

Schemas explicitly project rules and safe contact/submission fields. Submission
answers, consent evidence, contact metadata and provider credentials are omitted.
Each read rechecks canonical staff, connection status, action and business scope;
counts and nested joins apply the business/form filter before returning records.
Readiness is a snapshot of shared setup blockers, not complete recipient
eligibility or a delivery promise. An empty blocker list never bypasses consent,
STOP, overlap, quiet-window, provider or final-send checks.

Administration and `crm_get_access` recognize `automation_read`,
`automation_draft`, `automation_preview`, `automation_publish`,
`automation_enable`, `automation_run_start`, `automation_run_resume`,
`automation_run_pause_stop`, and `automation_activity`. All are opt-in; migration
preserves existing grants. Step 1 added only read tools; steps 2–3 add draft,
preview, publication and enable tools. Other grants remain forthcoming. Reads create no forms,
drafts, enrollments or sends; normal MCP access/audit bookkeeping still occurs.

CRM owns `20261015043000_crm_mcp_sms_reads.sql`, after the two applied MCP
migrations and the paired October 14 baseline. It extends the permission
allowlist, private read projections and guarded dispatcher, and adds indexes for
form-scoped submission history. The restricted login still has only the MCP
gateway; private helpers have no client execution grants. E2 ownership, customer
readers, service visibility, caches and messaging workers are unchanged. No E2
migration or runtime release is required.

Before deployment, reconcile live aliases against both records, then apply only
the pending forward migrations in order. Deploy MCP and the CRM frontend after them; existing
CRM API routes already support grant administration. Explicitly grant
automation_read to the chosen pilot and verify discovery in Codex. Do not replay
the historical release procedure below. The paired manifest is an offline test
inventory, not a live migration replay list.

Tests cover legacy-grant preservation, independent permissions, future businesses,
foreign IDs, filtered counts/pages, all submission types, same-phone contacts/runs
in different businesses, revocation, suspension, audit redaction, strict protocol
inputs and absence of messaging side effects. Registration passes a strict Zod
object to the SDK to reject unknown fields before handler execution. See both
project records for completed verification and release state.

## Implementation and release state

Production rollout (October 14, 2026, America/Denver): applied CRM migration
`20261015031114` and recorded it transactionally after the reconciled October 14
baseline. The dedicated `crm_mcp_login` has only `crm_mcp` membership; live
checks rejected nonstaff access and confirmed private-schema denial. Existing
public trigger helpers are not directly callable. Security advisors are unchanged
(five existing findings). CRM Clerk production now advertises CIMD, enforces S256
PKCE, and issues resource audience claims; dynamic-client default scope is profile.

Released `crm-api`, CRM frontend commit `3f2b313` (Render
`dep-db84q2e89jmc73c7c3g0`), and independent MCP service
`srv-db84ogivcj2c73874e20` (deploy `dep-db84oh2vcj2c73874g4g`).
Service URL: https://e2-crm-mcp.onrender.com/mcp. Health, discovery and unauthenticated
401 checks passed. Render did not start a frontend auto-deploy after the push;
the explicit retry reached live. No E2 runtime release was needed.

Codex `e2-crm` is authenticated through production CRM Clerk as the verified
active staff user. Connection `dd79bf79-c164-4493-a099-35654f7f7c12` was activated
at revision 1 for all current/future businesses and all six first-milestone grants,
following the owner’s explicit request. Bootstrap used the staff-only admin
function; the MCP surface has no grant-management operation.

Live Codex client sessions verified nine-tool discovery, pending no-data denial,
reconnect, active access context, business listing/profile reads and customer
lookup. All four successful calls and the pending denial were attributed correctly
in private audit. These were direct protocol checks in ephemeral sessions, with
no model run or persistent extra chat. No live customer facts/services were changed
for testing. Expiry-driven OAuth refresh has not yet been observed live; refreshed
bearer requests and invalid/expired tokens are covered by local acceptance tests.


Final live UI verification found an ambiguous connection-list SQL alias. Applied
CRM forward fix `20261015035649_crm_mcp_admin_directory_alias.sql` after a successful
rollback rehearsal; the original applied migration was not edited. Added pending
and active directory regression assertions. The real staff directory now loads.

The requested pilot is **all current and future businesses**, with `read`,
`draft`, `review`, `service_add`, `visibility`, and `global_customer_lookup`.
Only the designated staff/Codex connection should receive those grants. New
connections continue to start pending with no grants.

## Architecture and permission boundary

`npm run start:mcp` starts a separate Node/Express service. `/mcp` uses stateless
Streamable HTTP with the pinned MCP SDK. Each HTTP request verifies a CRM OAuth
access token and creates a server bound to that verified identity; there is no
shared current business or user state. Discovery endpoints are public; business
tools are authenticated. Host and optional browser Origin are checked.

Clerk's dedicated CRM Backend API introspects access tokens with the exact
`MCP_RESOURCE_URL` audience. JWT access tokens additionally require the CRM
issuer and signature. Expired/revoked tokens, tokens without a resource audience,
machine subjects and token-exchange actor chains are rejected. CRM and customer
Clerk issuers remain separate. Discovery requires PKCE S256 and CIMD; metadata
requests have a bounded timeout. `profile` and `offline_access` support user
identification and client-managed refresh.

The MCP database login receives **only** the `crm_mcp` role. Its only application
entry point is `crm_mcp.invoke(text,text,text,jsonb,uuid)`. It has no `sms_private`
schema access, preventing use of historical PUBLIC grants in that schema. The
entry point calls the private implementation under its function owner's rights;
canonical staff, connection grants, and business scope are checked on every call.
No Supabase service-role key, browser JWT forwarding, arbitrary SQL, URL fetcher,
or generic CRM action tool is exposed.

Connection grants and platform ownership changes use the existing platform
privilege lock. Successful mutations and their idempotency results commit in one
transaction. Permission checks happen before reading a previous result, so a
revoked caller cannot replay a formerly permitted write. A key cannot be reused
for different content or a different tool. Stale revisions require rereading.

Private connections bind issuer, subject and OAuth client, with independent
action grants and either selected IDs or an explicit all-businesses flag.
Revocation is terminal for that identity/client pair; use Disabled for a
reversible pause. No login grants staff status. Private activity stores actor,
connection, tool, target, request UUID, outcome/code and resulting revision,
excluding tokens and profile bodies. Successful mutation results are stored
privately for retry recovery. Transport/authentication failures have no trusted
connection and are not attributed to a CRM account.

## Tools and browser administration

All tools have per-tool output schemas and return `{ok, requestId, data? , error?}`. Errors include a stable code,
message and retryable flag; the MCP result also sets `isError`. Tools validate
inputs, expose read/write annotations, and require explicit `businessId` for
business operations. Lists default to 25 and cap at 100. `crm_get_access` returns
up to 100 business summaries; use `crm_list_businesses` for further pages.

| Tool | Grant | Behavior |
| --- | --- | --- |
| `crm_get_access` | Authenticated CRM staff | Pending/active/disabled/revoked status and effective grants |
| `crm_search_customers` | read | Scoped customers; broader lookup needs global_customer_lookup |
| `crm_get_customer` | read | Customer details and only permitted related businesses |
| `crm_list_businesses` | read | Paginated business summaries |
| `crm_get_business` | read | Draft, approved facts, review state, services and revisions |
| `crm_save_business_profile_draft` | draft | Expected revision and idempotencyKey required |
| `crm_review_business_profile` | review | Existing shared reviewed-profile action |
| `crm_add_business_service` | service_add | Existing service addition; website must already be linked |
| `crm_set_service_visibility` | visibility | Expected service revision and explicit draft/live value |

Profile review does not release customer services. Adding SMS can queue provider
setup but does not enable sending. The result includes the current provisioning
state and up to 20 scoped job IDs/statuses; retries retain that original snapshot. Visibility does not publish a website or
activate messaging. Original customer submissions, service prerequisites,
ownership checks, profile merging and E2 cache invalidation remain authoritative.

Administration → AI connections uses browser-authenticated CRM routes:
`GET /platform/ai-connections`, `POST /platform/ai-connections`, and
`GET /platform/ai-connections/activity?connectionId=...&page=...`.
Updates require `connectionId`, current `revision`, status, `permissions`,
`businessIds`, and optional `allBusinesses` (defaults false).
Only canonical staff can manage grants. Agents have no grant-management tool.

## Release procedure

1. Run CRM checks, `npm run test:mcp`, full tests, paired tests, frontend build and
   Edge packaging checks. Run E2 checks/tests/paired checks, Worker tests and build.
   `node scripts/test-mcp-concurrency.js` uses the optional disposable embedded
   PostgreSQL runtime documented in `scripts/test-inbound-concurrency.js`.
2. Reconcile both histories against the live project. Apply CRM's
   `20261015031114_crm_mcp_business_setup.sql` then
   `20261015035649_crm_mcp_admin_directory_alias.sql`, after the October 14 baseline;
   no new E2 migration is required. Rehearse transactionally, compare function
   guards, and compare security advisors before/after. Never replay histories.
3. Provision a dedicated LOGIN with only `crm_mcp` membership. Store its SSL
   connection URL as Render `MCP_DATABASE_URL`; grant neither `sms_api` nor
   `service_role`. Credentials are generated/stored outside tracked files.
4. Enable CIMD on the **production CRM** Clerk OAuth settings; retain S256 PKCE
   and consent. Use the production CRM secret as `CRM_CLERK_SECRET_KEY` in Render.
5. Create the independent Render service from the reviewed implementation branch
   using the Blueprint entry. `MCP_RESOURCE_URL` must equal the final HTTPS
   service URL plus `/mcp`; set it before OAuth setup. Use the onrender.com URL
   for the free pilot, manual deployment, and `/health`. Free-tier startup latency
   must be evaluated before broader staff rollout. No disk or worker is required.
6. Release the new `crm-api` and CRM frontend together after the migration. E2
   runtime remains unchanged. Verify discovery, authentication challenges and
   rejection of tokens intended for another resource before authorizing writes.
7. Add the URL in Codex and complete OAuth as the intended CRM staff user.
   `codex mcp add e2-crm --url <MCP_RESOURCE_URL>` followed by
   `codex mcp login e2-crm --scopes profile,offline_access --oauth-client-registration cimd` uses Codex's OAuth flow. Do not copy a browser session.
8. Call `crm_get_access` to create the pending connection. In CRM, inspect its
   staff/client identity, select All businesses and the six pilot grants above,
   then activate it. Verify read/refresh/reconnect and a designated test record
   workflow; do not use live customer service activation as a smoke test.

Rollback: disable the connection or stop the MCP service. Retain private audit
and idempotency records and the additive schema; rollback must not delete history.
Monitor authentication errors, denied calls, conflicts, database availability,
and provider setup separately. Queued work is not proof of provider completion.

## Next milestone

SMS automation creation, preview, publishing, enabling and activity inspection
will receive separate tools and grants. Staff-access changes, ownership transfers,
website reassignment/publication, deletion, sends and unattended credentials are
not part of this business-setup tool set.
