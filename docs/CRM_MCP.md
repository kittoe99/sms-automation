# CRM MCP business setup

## Forms MCP production release — October 15, 2026, 11:19 PM Denver

The forms milestone is deployed. This release record supersedes the historical
local/unapplied checkpoints below. Implementation is committed in the CRM release
worktree C:/Users/kofik/.codex/worktrees/crm-mcp/opek-sms; unrelated dirty main CRM
work remains untouched. No E2 schema or runtime deployment was required.

**Applied migrations:** reconciled 121 live records with both repositories and
the previous alias inventory. Two remote-only historical entries were already
present in the prior release snapshot. An isolated exact-version CLI catalog
used already-applied history markers and only the five new source files. Dry run
listed exactly five; two rollback rehearsals (before and after the apply correction)
verified the prerequisite guards. No history repair, replay, role/seed/Vault
change or unrelated AI-default migration was applied. Production now has 126
migration records. Source and applied versions are identical for this release:

| Version | Migration |
| --- | --- |
| 20261016040535 | crm_mcp_form_reads |
| 20261016041950 | crm_mcp_form_drafts |
| 20261016043205 | crm_mcp_form_preview |
| 20261016044442 | crm_mcp_form_apply |
| 20261016045607 | crm_mcp_form_collection |

All 19 inspected live function hashes match the tested paired definitions.
Private helpers/table access remains denied to API/MCP roles. Security advisors:
69 informational findings, 5 pre-existing warnings, 0 errors. The one new INFO
is RLS enabled with no policies on the deliberately private mcp_form_drafts table;
no new warning or error was introduced. The Supabase connector required renewal,
so the already-authenticated CLI applied the migrations to wxamwhfmelxqahkdtcci.

**Releases:** commit 95e432ac1da97d1e5c2e76ea4336bccf8f2634ee is live on
[MCP deploy dep-db8r69ks728c73aph4eg](https://dashboard.render.com/web/srv-db84ogivcj2c73874e20/deploys/dep-db8r69ks728c73aph4eg)
and [CRM frontend deploy dep-db8r770n74is73chjfbg](https://dashboard.render.com/static/srv-dandjcp42hec73e569pg/deploys/dep-db8r770n74is73chjfbg)
in the previously confirmed Micah workspace. The frontend produced no automatic
deploy/event after the branch push; one explicit deployment of the verified commit
completed. Both the served permission module and bundled grant labels were verified.
Health/discovery return 200; unauthenticated MCP returns the expected 401 challenge.
No MCP application error logs appeared after rollout. CRM API source is unchanged,
so its existing grant administration routes needed no redundant Edge deployment.

**Access and Codex verification:** on explicit user authorization, canonical admin
save added all six form grants to existing all-business connection
dd79bf79-c164-4493-a099-35654f7f7c12. Revision is 3, with 21 total permissions;
existing scope/grants were preserved, and the grant change is audited. New
connections still start pending without grants. Two fresh Codex app-server OAuth
sessions verified discovery/reconnection, all 33 tools, strict schemas, read/write
annotations and mutation retry/revision requirements. Ten read-only calls covered
access, scoped/empty form lists, missing-form and missing-business denials; all ten
have correct actor/connection/request attribution. No form mutation tool ran.

Live has zero forms and zero saved drafts, so successful detail/preview and mutation
paths were not exercised against production or seeded just for verification. They
remain covered by local tests. No expiry-driven token-refresh scenario was forced.
Before/after hashes of business, forms, follow-ups, runs and email enrollments match.
Counts remain 1 SMS run, 4 messages (2 outbound), and 2 SMS-send jobs. No collection
activation, enrollment, follow-up enablement or SMS send occurred during this release.

**Local verification:** corrected apply writes only validated definition columns
to avoid an unchanged enabled flag firing email lifecycle cancellation. Regression
fixtures preserve active/paused email on inactive, active and no-email forms.
Full CRM: 516 passed / 29 existing skips / 0 failed; focused apply/collection: 23;
paired contracts: 63; relevant E2 tests: 28; PostgreSQL concurrency scenarios: 17.
Both projects' required checks, frontend build and 65-file Edge packaging passed.
Release verification artifacts are in the worktree's ignored data/forms-* files;
credentials and customer message content are not included in these records.

## Forms release preflight — October 15 (before application)

The five CRM forms migrations were reconciled against 121 live migration records,
including source/remote aliases and two unchanged remote-only historical entries.
The exact-version CLI dry run lists only 20261016040535, 20261016041950,
20261016043205, 20261016044442 and 20261016045607. No history repair or replay is
needed. The unrelated main-checkout AI-default migration is excluded. Both Render
services still run 0e0728c, so deploying the existing release worktree preserves
the production baseline and leaves newer unrelated local work untouched.

Preflight corrected the still-unapplied apply migration: it now writes only
validated definition columns. The full canonical saver also writes enabled even
when unchanged, which fires the email lifecycle trigger. Pure draft validation
retains canonical field rules/normalization while avoiding that unintended effect.
Regression fixtures cover active and paused email across inactive, active and
no-email forms. Historical step-4 notes below describe the original local approach;
this correction is the release implementation. Collection control still invokes
its intended pause/cancel safeguards. No public/shared saver or E2 contract changed.

Corrected local verification: 516 CRM passes / 29 skips, 63 paired passes,
23 focused apply/collection passes, 17 PostgreSQL concurrency scenarios, CRM
checks, frontend build and Edge packaging. Production rehearsal rolled back and
matched all 19 expected functions, including the existing E2-owned staff guard.
The user authorized all six form grants for the existing all-business admin
connection. Actual migrations, grant activation, deployments and Codex verification
will be recorded separately after success. No live form or messaging mutation ran.

## Forms milestone, step 5 — collection activation and deactivation (October 15, local only)

The local catalog has 33 tools. `crm_set_form_collection_enabled` uses the
independent `form_activate` grant; existing connections receive no new grants.
Required inputs are businessId, formId, current revision, current draftRevision
(0 when no private draft exists), enabled (a boolean), and an 8–128 character
idempotencyKey. Definitions, consent switches, SMS switches and force/rebase flags
are rejected. Scope, active staff, connection and permission checks precede every
call, including retries. Archived forms cannot change collection state.

Activation exposes the **applied** definition. It does not apply a saved draft,
change consent, enable SMS follow-ups, resume runs or schedule a message. An
inactive form with enabled SMS follow-ups or active form SMS runs cannot activate:
disable follow-ups/pause runs through their separately granted tools first.
This prevents collection activation from implicitly making existing SMS rules
effective. Existing email consent/settings are preserved, so later real submissions
continue through the normal consent and email eligibility checks.

Deactivation stops public collection and preserves canonical CRM safeguards:
active form SMS runs pause with FORM_DISABLED and incremented generations; active
and paused form email enrollments cancel with incremented generations. SMS sequence
enablement itself is unchanged. Paused SMS due timestamps are retained, as in the
CRM editor; paused runs cannot send and require a separate explicit resume.
Other forms, direct runs, historical submissions and rule snapshots are untouched.
No send/enrollment/provider operation is invoked. Already submitted SMS cannot be
recalled; inFlightMayDeliver reports known submitting, uncertain or accepted but
nonterminal SMS for this form. It is a snapshot, not a delivery guarantee.

Both revisions must match under the canonical form/draft locks. A changed state
increments the form revision and invalidates the E2 cache. Fresh private drafts
advance their base and draft revision without changing their definition; already
stale drafts stay stale. Requests with matching state do not bump form/draft
revisions, but disabling again still pauses/cancels any inconsistent active work.
The result includes scoped form state, previousRevision, databaseStatus=committed,
effect (activated/deactivated/unchanged, describing collection state), pausedSmsRuns,
cancelledEmailEnrollments, deliveryStatus=not_sent_by_this_operation and
inFlightMayDeliver. Counts include cancellations made by canonical form triggers.

Form/draft/cache changes, safeguard effects, effect audits and the retry result
share one transaction. Identical retries return the original response without
reapplying a later state; changed payloads conflict. Failures roll back all effects.
The main audit records applied/draft revisions; additional private audit entries
attribute each paused run/cancelled enrollment and resulting generation to the
same actor, connection and request. No phone, email, answers or message bodies
enter the MCP audit. The private helper is inaccessible to the MCP login and all
API roles; only the granted gateway can invoke it.

CRM owns `20261016045607_crm_mcp_form_collection.sql`, following the form apply
migration and the previous read/draft/preview steps. All five forms migrations
remain local/unapplied. No E2 runtime/schema change or production action was made.
Before release, reconcile live aliases and unrelated main-checkout changes, then
apply only new forward migrations and deploy matching service/frontend code.

Local verification: 516 CRM tests passed (29 existing skips), including 12 collection
checks; 28 relevant E2 tests and 63 paired contract tests passed. Both project
checks, frontend build and 65-file Edge packaging passed. Seventeen real PostgreSQL
concurrency scenarios passed. Combined pending CRM/E2 migrations and local security
advisors passed in disposable databases. No live migration, release or SMS occurred.

## Forms milestone, step 4 — explicitly apply saved drafts (October 15, local only)

Historical step-4 checkpoint, superseded by step 5 above. The catalog had 32 tools. `crm_apply_form_draft` uses the independent
`form_publish` grant. Required inputs: businessId, formId, current revision,
current draftRevision, and an 8–128 character idempotencyKey. No inline definition,
force/rebase flag, preset, consent or collection switch is accepted. Existing
connections receive no new grants. Editing, preview, applying, activation and SMS
permissions remain independent.

Apply copies only the saved draft into the canonical definition using the existing
validated definition saver. The current collection flag is preserved: an inactive
form stays inactive; an active form displays the newly applied definition while
remaining active. Preset, legacy/email consent settings, website connections,
SMS rules/publication/enablement, existing runs, email enrollments, submissions
and their historical field snapshots stay unchanged. Existing E2 form-row cache
invalidation still runs. The general form_workspace save route is intentionally
not used because saving an already-disabled form there can pause/cancel activity.
Applying does not call enrollment, sending, website publishing or public submission.

The operation locks the canonical form then the draft; current SMS rule checks
follow the same parent-first order. Both expected revisions must match, and the
draft's saved base must equal the current applied revision. Missing drafts and
archived forms are rejected. A stale base conflicts even if the caller supplies
the latest applied revision: explicit reconciliation remains a separate later
operation, never an automatic overwrite. Saved definitions are revalidated before
applying. Current SMS draft and published rules must remain valid against the new
fields; incompatible changes fail with a generic validation error without exposing
rule content. Update those rules through their separately granted tools first.
Historical SMS versions/runs use their saved context and are never rewritten.

Success increments the applied revision and retains the draft, advancing its
revision and base to the newly applied form so another edit can begin safely.
The response includes the full scoped form state, databaseStatus=committed,
previousRevision and appliedDraftRevision (the consumed draft revision). Audit
captures the resulting applied/draft revisions with actor, connection, target,
request and outcome; no definition text or customer content is logged.

Form and draft changes, E2 cache invalidation and the retry result share one
transaction. Identical retries return the original result even after a later edit;
reusing a key with a changed payload or tool conflicts. Staff, permission and scope checks
precede replay. A failed/interrupted transaction leaves no partial application.
Applying again with old revisions and a new key conflicts rather than silently
applying a newer draft. A deliberate later apply uses fresh revisions and a new key.

CRM owns forward migration `20261016044442_crm_mcp_form_apply.sql`, following
`20261016043205_crm_mcp_form_preview.sql`, the earlier form draft/read migrations,
and the established paired E2 baseline. All four form migrations remain local and
unapplied. No E2 schema/runtime change is needed. Before a later release, reconcile
live aliases and unrelated main-checkout work, apply only new forward migrations,
then deploy the matching service/frontend. No live form or SMS action occurred.


Local verification: 504 CRM tests passed (29 existing skips), including eleven
apply checks; 28 relevant E2 tests and 63 paired contract tests passed. Both project
checks, frontend build and Edge packaging passed. Eleven real PostgreSQL concurrency
scenarios passed, including duplicate apply, apply vs draft edit, rollback and CRM
edit races. The combined pending CRM/E2 fixture and local security advisors passed.
No production migration, deployment or SMS occurred.

## Forms milestone, step 3 — saved draft previews (October 15, local only)

Historical step-3 checkpoint, superseded by step 4 above. The catalog had 31 tools. `crm_preview_form` requires only the separate
`form_preview` grant plus permitted business scope and active canonical CRM staff.
No existing grants are expanded. `form_read`, editing, publishing, activation and
SMS preview grants do not imply this permission, nor does preview grant them.

Required inputs are businessId, formId, revision and draftRevision. Revisions must
be positive safe integers and identify the current applied form and saved draft.
No draft means a validation error; there is no fallback to the applied definition.
A changed expected revision returns CONFLICT for rereading. The database uses
parent-first shared locks consistent with CRM/MCP edits to read one coherent form
and draft. A draft whose base predates the current applied revision remains
inspectable with `DRAFT_BASE_CHANGED`; archived forms carry `FORM_ARCHIVED`.
These warnings are displayed, never silently reconciled or treated as publish
readiness. Unknown keys, unsaved definitions, sample answers, contact IDs,
submission switches, activation flags and retry keys are rejected.

The result is a structured, display-only saved-draft preview: ordered custom
fields, fixed name/phone/email fields, the booking appointment field in the
business timezone, current collection state, both revisions and the draft base.
Optional SMS consent is always unchecked; the separate email choice appears only
when the existing form enables it. Both use canonical consent wording. No sample
values, contacts, submissions, SMS rules, sending readiness or provider state are
read or returned. Rendering HTML-like form text does not execute it.

Successful MCP responses also embed a self-contained `text/html` resource. Its
`crm-form-preview://` URI is a resource identifier, not a hosted/public endpoint
or an authorization link. Clients that cannot render HTML can use structured data.
All controls are disabled, consent is unchecked, and the button is type=button.
There is no form element, submit action, script, external asset or active link;
CSP denies scripts, network access and form submission. Text/labels/options are
escaped. Nothing invokes the browser form tester or a public submission route.

Preview is annotated read-only, nondestructive, idempotent and closed-world.
Every call rechecks access. Only connection last-use and audit metadata change;
there is no idempotency-result write or domain mutation. Audit records actor,
connection, request, form and both revisions, without draft/HTML/customer content.

CRM owns forward migration `20261016043205_crm_mcp_form_preview.sql`, after
`20261016041950_crm_mcp_form_drafts.sql` and `20261016040535_crm_mcp_form_reads.sql`
with the existing E2 baseline. All three form migrations remain local/unapplied.
No E2 runtime/schema change or production release is included. Before a later
release, reconcile live aliases and unrelated main-checkout changes; apply only
new forward migrations, then deploy the matching MCP service and CRM grant labels.


Local verification: 493 CRM tests passed (29 existing skips); ten new preview
checks include MCP embedded-resource delivery, HTML escaping, permission/scope
isolation, revision conflicts, redacted audit and unchanged domain snapshots.
Relevant E2 tests (28), paired tests (63), both project checks, frontend build and
Edge packaging passed. Seven disposable PostgreSQL concurrency scenarios passed,
including preview racing a CRM edit. The combined pending CRM/E2 migration fixture
and local security advisors passed. No live migration, deployment or SMS occurred.

## Forms milestone, step 2 — inactive creation and separate drafts (October 15, local only)

Historical step-2 checkpoint; superseded by step 3 above. The catalog had 30 tools. New independent grants are usable:

| Tool | Grant | Required inputs |
| --- | --- | --- |
| `crm_create_form` | `form_create` | businessId, preset, definition, idempotencyKey |
| `crm_save_form_draft` | `form_edit` | businessId, formId, revision, draftRevision, definition, idempotencyKey |

Creation uses the canonical form operation and always creates an inactive form,
plus a private draft with revision 1 based on that initial applied definition.
Presets are contacts, quote_requests and bookings. It creates no SMS sequence,
enrollment or sending job. New forms remain unavailable to public collection.

Draft saves replace only the private staged definition. They preserve the applied
form, collection state, preset, consent controls, SMS rules/runs, email state,
submission snapshots and E2 contracts. The normal CRM editor still edits applied
forms directly; it does not display or apply MCP drafts in this increment.
Preview, apply and activation remain future tools under their reserved grants.
Existing connections receive no new grants.

Definitions require title (1–120), description (0–500), buttonLabel (1–80), and
up to 20 ordered custom fields. Field keys are unique safe identifiers, excluding
fixed identity, appointment and consent fields (including email_opt_in). Types
are text, textarea, select, checkbox or date; required is explicitly boolean.
Select fields require 1–20 unique nonblank string options. Unknown fields,
collection/SMS switches and changes to a form's preset are rejected independently
by strict SDK and database validation. Text is not interpreted as executable code.

`crm_get_form` and mutation results report the applied definition/revision plus
`draft`, `draftRevision`, `draftBaseRevision`, and `draftStale`. An existing form
without a staged draft reports null draft revisions; pass draftRevision 0 for its
first draft save. Subsequent saves require both current revisions. Parent-row
locks serialize draft saves with the CRM editor. A changed applied version makes
the existing draft stale, even when the caller supplies the new applied revision;
saving returns CONFLICT rather than implicitly rebasing. Explicit reconciliation
of stale drafts is deferred to the apply/reconciliation step. Keep the saved draft
and reread; do not loop on conflicts or overwrite applied changes automatically.
Lists continue to search and display applied titles, not draft titles.

Every mutation requires an 8–128 character idempotencyKey. The gateway rechecks
staff, connection, permission and business scope before replay. Identical retries
return the original result snapshot, even after later edits. A changed payload or
tool with that key conflicts. Form/draft changes and the retry result commit in
one transaction; failure rolls them all back. Audit records include actor,
connection, tool, target, request, outcome and both applied/draft revisions, never
definitions or consent/customer content. Private draft storage has RLS, no API
role grants, and no direct MCP helper access.

CRM owns forward migration `20261016041950_crm_mcp_form_drafts.sql`, following
`20261016040535_crm_mcp_form_reads.sql` and the established paired E2 baseline.
No E2 schema/runtime change is needed. Both form migrations are still unapplied;
this is local implementation, not a release. Reconcile live aliases and pending
main-checkout changes before any future deployment; do not replay histories.
Release the migrations before the matching MCP service/frontend catalog.

Local verification: 483 CRM tests passed (29 existing skips), 28 relevant E2 tests
and 63 paired tests passed; both project checks, frontend build and Edge packaging
passed. Final focused form/read/server checks passed (22). Six real PostgreSQL
concurrency scenarios passed via `node scripts/test-mcp-form-concurrency.js`.
The combined pending CRM/E2 history applied in a disposable database; local
security advisors exited successfully without emitted findings. No production
migration or deployment occurred.

## Forms milestone, step 1 — local scoped reads (October 15)

Historical step-1 checkpoint, superseded by step 2 above. At this point the local catalog had 28 tools. AI connections now
offers six independent opt-in grants: `form_read`, `form_create`, `form_edit`,
`form_preview`, `form_publish`, and `form_activate`. Only `form_read` has callable
tools in this step; the other labels explicitly identify future steps. Existing
connections receive no new grants, including connections scoped to all businesses.

| Tool | Input | Output |
| --- | --- | --- |
| `crm_list_forms` | Explicit businessId; optional q, preset, collectionEnabled, includeArchived, page and pageSize | Scoped summaries, current form revisions, collection state, business timezone and filtered count |
| `crm_get_form` | Explicit businessId and formId | Applied definition, ordered custom fields, fixed field names, current form revision and collection state |

Both require `form_read` independently of business/SMS grants. Neither grants
submission, contact, SMS-rule, run or activity access. No submission counts,
answers, message content, website identities, raw metadata or consent evidence
are returned. Archived forms are excluded from lists by default but can be read
explicitly within scope. Search is a literal case-insensitive title substring;
SQL wildcard characters are not search operators. Pages default to 25 and cap
at 100; page numbers range from 1 to 100000, ordered by title then form ID.

`form.definition` is the currently applied canonical definition, even when public
collection is disabled. `form.revision` is its existing definition version, not
an SMS publication version. `draft` and `draftRevision` are explicitly null:
separate staged drafts, creation, editing, preview, apply and activation belong
to subsequent increments. Collection state is not an SMS readiness guarantee.
Fixed fields report the existing appointment and email-consent variants without
allowing changes to consent controls. No public preview link is created.

Strict input/output schemas reject extra keys and enforce pagination, UUID and
filter types. The database independently validates inputs. Scope filters precede
counts and pagination, and form IDs are checked against the requested business
even when both businesses are permitted. Only curated fields leave the database.
The dedicated role still has gateway-only access; private helpers are not granted
to browser, service or MCP roles. Calls recheck canonical staff, current grants
and business scope and audit actor/connection/request/target plus detail revision.
Reads only update connection last-use and audit records, not CRM domain data.

CRM owns new forward migration `20261016040535_crm_mcp_form_reads.sql`, after
`20261015052336_crm_mcp_sms_run_controls_activity.sql` and the existing paired E2
baseline. The offline manifest records this order. No E2 migration or runtime
change is needed. Reconcile live aliases and independent pending main-checkout
migrations before applying only new forward changes. Release the migration before
the MCP service and CRM frontend; do not deploy the older worktree frontend over
newer unrelated CRM features without first reconciling release sources.
No live migrations, grants, form changes, SMS sends or deployments were performed.

Local verification: 473 CRM tests passed with 29 existing skips, including eight
new form schema/isolation checks; 28 relevant E2 form/bookings/business-service
tests and 63 paired contract tests passed (overlapping coverage). Both projects'
required checks passed. CRM frontend build passed using a synthetic local-only
publishable key; the worktree has no deployment key. Edge packaging passed for
65 files. After narrowing list hydration to the requested page, all eight form
checks passed again and the offline manifest was refreshed. Disposable PostgreSQL
also applied the combined history with the separately pending main-checkout AI
reply-default migration and confirmed gateway-only MCP privileges. No production
connection was used for these tests.

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
Release commit `0e0728c230f00b253212e25985b9d38704511508` is live on MCP deploy
`dep-db86fc2j9qps73brcung` and frontend deploy `dep-db86g9ivcj2c738dd92g`.
The frontend received no automatic deploy event after the push; an explicit deploy
of the verified commit completed successfully. Its served grant module includes
all nine SMS permission labels. CRM API source/routes are unchanged and already
support these grants, so no redundant Edge/API or E2 runtime deploy was performed.

The owner authorized all nine SMS permissions for the existing all-business admin
connection; canonical admin save advanced it to revision 2 with 15 total grants.
New connections still start pending without grants. Two fresh Codex app-server
sessions verified OAuth connection/reconnection, all 26 tool names, write/read
annotations, retry-key schemas, access context and scoped reads. Missing source,
submission and run references returned permission errors without data. The live
tools also appeared in this chat; access, run list and automation list succeeded.
All audit records have the correct actor/connection/request attribution. Health
and discovery returned 200; unauthenticated MCP returned 401 with its challenge;
recent Render error logs were empty. No customer content was printed in the
verification reports.

Verification invoked only reads. No mutations, enrollments, pauses, resumes,
publications or enabling actions were used as live tests. Runs/forms/templates
remain zero; existing messages/jobs remain 2/9; MCP mutation retry records remain
zero. Successful write/preview workflows and consent/concurrency behavior retain
their local acceptance coverage. There was no live expiry-driven refresh test.
Security warnings predate this release: [extension placement](https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public),
[anonymous function execution](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable),
and [authenticated function execution](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable).
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

## Remaining boundaries

The SMS milestone above is released. Staff-access changes, ownership transfers,
website reassignment/publication, deletion, arbitrary one-off sends and unattended
credentials remain outside this tool set. Production sending is possible only
through separately granted start/resume/enable workflows and their existing checks.
## Instant form acknowledgment

SMS sequence input/output accepts optional boolean `instantAcknowledgment`.
Only form submission sequences with a zero-delay first step can set it true;
direct-contact and appointment sequences reject it. It exempts only the first send
from sending hours, never repeats or subsequent messages. Consent is still required.
Use the normal draft-save revision/idempotency protections, then preview a time
outside sending hours with and without consent. Publication and enablement remain
separate actions. Publishing preserves existing run snapshots.
