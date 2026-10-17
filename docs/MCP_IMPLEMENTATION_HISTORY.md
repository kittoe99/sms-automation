# CRM MCP business setup

> HISTORICAL ARCHIVE: preserved implementation checkpoints, including superseded local-only/unapplied statements and earlier catalog counts. This is not the current operating guide. Use [MCP documentation](CRM_MCP.md) and [current release status](MCP_ROLLOUT.md). Dates and statements below describe their original checkpoint only.

## AI reply previews — local only

`crm_preview_ai_reply` requires `ai_reply_preview`, explicit business/profile
identity and current business/settings revisions. It returns a hypothetical
Business Info answer and captured version metadata without customer reads,
executed actions or sends. The model request is external and non-idempotent;
context/revision and permission changes during generation discard the reply.
See [AI reply previews](AI_REPLY_DIAGNOSTICS.md) for the contract, limits, audit
and deployment prerequisites. One new CRM migration is unapplied. No E2 release.

## Business Info version tracking — released October 16, 2026

The existing AI run list/detail schemas now accept server-recorded Business Info
version metadata. One CRM forward migration captures the actual leased context
and copies it into new results; historical results remain not recorded. No new
tools or grants are added. See [AI diagnostics](AI_REPLY_DIAGNOSTICS.md) for retry,
recovery, isolation, tests and the compatible MCP-first release order. MCP and frontend runtime `1006b79` and CRM migration `20261016235631` are live.
Read-only Codex checks passed; no E2 release, mark-read or SMS was performed.

## AI reply diagnostics — released October 16, 2026

Two new read tools and two default-off permissions are released at 066d2ef.
See [AI reply diagnostics](AI_REPLY_DIAGNOSTICS.md) for scope, content access,
redaction, missing historical profile provenance and release prerequisites.
Migration 20261016222634 is applied; 155 tools are live. Twelve attributed Codex
read checks passed without domain changes, read marks or SMS.

## Form lifecycle/preset MCP release — October 16, 2026

Stage 3 is LIVE at 95b6c36cbc0e9d8643a9aa9165d07d0bd6ead1ff. Migration
20261016193231 alone was applied after reconciling 139 prior entries and a guarded
rollback rehearsal (140 now live). Five expected function hashes match; private
helpers remain denied. MCP dep-db97sidg1s2s73caj66g completed 19:43:48 UTC;
frontend dep-db97t1bodcbs739lfj4g completed 19:44:27 UTC. The frontend required an
explicit trigger after no automatic push event appeared. Admin connection:
revision 10, 55 grants, all-business scope.

Fresh Codex discovery found 79 tools. Nine read/preview checks passed, including
Opek's form, inert saved-draft preview, published enabled SMS v1 and preset scope.
All nine audit records are attributed; zero mutation receipts were created.
Opek collection/follow-ups stay enabled, both canary runs stay stopped, and the
conversation still has one unread reply at revision 1. Full domain snapshots and
existing security-advisor findings are unchanged. No messages were marked read,
queued or sent. CRM 635 passed / 29 existing skips, paired 63, relevant E2 23;
both checks and frontend/Edge builds passed. No E2 release was needed.
Stages 4–9 remain in progress/pending; see docs/MCP_ROLLOUT.md.

## Form lifecycle and preset MCP — October 16, 2026 (local)

Stage 3 implements seven tools and six independent permissions: inactive form
duplication, archive, inactive restore, direct-template archive, preset list/detail
and saving a reviewed form SMS draft as an immutable preset. Local catalog:
79 tools / 55 grants. Shared form revisions now advance for every browser/worker
row update; identity cannot change. Strict wrappers require current revisions,
transactional retry receipts and audits. Duplication copies applied fields and
the saved SMS draft but no published version, enabled collection or runs.

Canonical form archive disables collection/follow-ups, stops associated active or
paused SMS runs, and cancels active/paused email enrollments. Each affected ID and
resulting generation is audited. Restore remains inactive and does not resume
work. Template archive preserves existing direct runs. Preset creation returns
the exact inserted ID rather than looking up a nonunique name or timestamp.
All new tools leave ownership, customer visibility and website links unchanged.

Local CRM 635 passed / 29 existing skips; relevant E2 23 passed; both project checks
passed. Disposable PostgreSQL verified duplicate retries, browser conflicts,
locked-run exclusion, competing archives and interrupted restore rollback.
Paired checks passed (63 tests); frontend and 65-file Edge bundle built. Migration 20261016193231
is reconciled against 139 live entries and rollback-rehearsed, NOT yet applied.
No E2 migration/runtime release is required; release verification is read-only.

## Conversation/activity MCP release — October 16, 2026

Stage 2 is LIVE at d60dd359f498ec730c304a6e47589a2ff200eebc. Only migration
20261016191603 was applied after reconciling 138 prior entries and a guarded
rollback rehearsal; live history is now 139. Six function hashes match, private
execution remains denied, and domain snapshots/security-advisor findings are
unchanged. MCP deploy dep-db97nggn74is738nqhv0 completed 19:33:02 UTC; frontend
dep-db97nt2jnfac739mhttg completed 19:33:31 UTC (manual trigger after no automatic
push event). Canonical admin grants are revision 9, 49 permissions, all-business.

Fresh Codex discovery: 72 tools; eleven allowlisted reads passed, including the
activity report, tags and four attribution candidate types. Opek's conversation
remains revision 1 with one unread reply, both canary runs remain stopped with
no next send, and no mutation receipts were created. No live messages were
marked read or sent and no customer data changed. CRM 628 passed / 29 existing
skips, paired 63, relevant E2 27; both checks and frontend/Edge builds passed.
Disposable PostgreSQL concurrency checks passed. No E2 runtime release needed.
Earlier local-only entries are historical. Stages 3–9 remain in progress/pending.

## Conversation controls and activity MCP — October 16, 2026 (local)

Stage 2 adds 13 tools and seven separate grants: AI pause/resume, same-contact
message reassignment, eligible failed handoff alert retry, activity reports,
tags and explicit same-customer attribution. Lead/handoff owner and status edits
already exist and remain the canonical supported fields. The local catalog has
72 tools and 49 permissions. Strict generated input schemas are also enforced
inside private database wrappers. Private schema storage and helpers are denied
to application roles.

Activity changes advance a separate shared activity_revision on form_runs, never
SMS generation. Tag/attribution edits require both counters plus source revisions.
AI controls preserve unread state and run lifecycle; reassignment checks both
thread revisions and cancels stale AI work. Alert retry locks related jobs and
rejects leased, uncertain or submitted work. It can queue a staff alert, so live
verification must not invoke it. Retry receipts and audits remain transactional.

Local isolation/retry/rollback tests and disposable PostgreSQL concurrency checks
pass. Full CRM: 628 passed / 29 existing skips; paired: 63 passed; relevant E2:
27 passed; both checks, frontend build and 65-file Edge bundle passed. CRM migration
20261016191603_crm_mcp_conversation_activity.sql has passed a guarded rollback-only
live rehearsal against 138 reconciled entries but is NOT applied or released yet.
No E2 runtime or contract change is required. No customer records or SMS were
changed for verification. See docs/MCP_ROLLOUT.md and ignored data/activity-*.

## Contacts MCP release — October 16, 2026

CRM migration 20261016190248 and commit c3d717a are live. Codex discovered
59 tools; contact/consent reads and a non-queued preview passed. Admin grants
are active at connection revision 8. No messages were read/sent or domain records
changed during verification. Earlier local-only entries are historical. See
both project records and CRM MCP_ROLLOUT.md for remaining stages.

## Contacts and consent MCP stage — October 16, 2026 (local)

CRM adds independent contact/consent and marketing-message tools, with revisions,
retry receipts and redacted audits. Preview does not send; successful canonical
staff sending pauses AI on the resulting thread without marking read. Contact
creation never grants consent; opt-in/unblocking never enrolls or resumes runs.
CRM migration 20261016190248 is pending. No E2 release is needed. See the CRM
MCP_ROLLOUT.md and both project records for progress and release evidence.

## Conversation actions production status — October 16, 2026

The four CRM migrations 20261016180739, 20261016181809, 20261016183011 and
20261016183855 are applied. MCP and the CRM permissions UI are live at commit
7ea1dc8fe1d1e2abc366d6dc9f76bdfb295c937c, with 49 discoverable tools.
conversation_reply grants preview/reply; conversation_mark_read separately grants
selected-message read updates. Neither implies metadata/message-read permission.
The existing all-business admin connection has both grants (revision 7).

Fresh Codex verification used only reads and preview: Opek remains at conversation
revision 1, five messages and one unread reply; preview queued nothing and both
test runs remain stopped with no next send. No messages were marked read or sent.
Read the current revision before any explicitly requested mutation and reuse the
same payload/idempotency key after an uncertain response. A queued reply receipt
is not proof of provider acceptance or delivery. Earlier local-only entries below
describe implementation-time state; the production release is now recorded in
PROJECT_RECORD.md. No E2 migration or runtime release is needed.

## Conversation replies — October 16, 2026 (local only)

crm_reply_to_conversation now implements the existing opt-in conversation_reply
grant. The local catalog has 49 tools and 33 permissions. The grant covers preview
and reply; it does not imply metadata/message-read or mark-read access. No existing
grants change in this step. Discovery marks reply as a write with external effects,
idempotent retries and a strict input/output schema.

Input: businessId, conversationId, current positive safe-integer revision, trimmed
body (1–1600 UTF-16 units), and idempotencyKey (8–128 characters). There is no caller
recipient, purpose, actor or scheduling override. Read/review the latest thread,
optionally preview, then submit explicitly. A prior preview never authorizes a send.
The operation rechecks exact scope and revision, locks contact/business/provider/
credential metadata, and reruns current eligibility before invoking the canonical
CRM conversation reply. NOWAIT on related rows prevents lock cycles with workers;
contention safely rolls back with TEMPORARY_FAILURE. Opt-outs and inactive/disabled
sending are denied, as is an unconfigured sender or missing credential metadata.
The transactional consent rules match CRM; marketing consent remains separate.

The canonical operation queues one outbound message and pauses AI for exactly the
chosen general/group thread. It does not mark inbound messages read, change consent,
start/stop automations or enroll contacts. Existing worker dispatch checks remain
authoritative when asynchronous sending begins. Recipient and group are derived
from the scoped thread, and the queued result is checked against that exact target.

Outbox dedupe keys are namespaced by verified connection and a hash of the retry
key; different OAuth connections cannot accidentally share a job. Mutation,
revision, AI takeover, retry receipt and audit commit together. An uncertain
response must be retried with the identical normalized payload/key. A changed
payload conflicts. On revision conflict, reread and review before issuing a new
request/key. Cached retries recheck staff/connection/permission/business access and
return the original committed receipt without requeuing or reapplying takeover.
Later consent/status changes do not turn a receipt replay into a new send.

Receipt: business/conversation IDs, previous/result revisions, databaseStatus:
committed, messageId, jobId, deliveryStatus:queued, aiPaused:true. Queued is an
enqueue receipt, not provider acceptance/delivery; retries return historical receipt
state. Use scoped conversation/activity reads to inspect later delivery status.
Audit includes actor, connection, target, request, outcome, revisions and affected
message ID/count. Reply text and recipient are stored only in the normal operational
message/outbox records, not MCP audits or retry receipts. No credentials are exposed.
Application roles cannot call the private helper directly.

Local verification covers permission/scope denial, body limits, sender/consent gates,
stale revisions, exact group targeting, retry collisions, rollback on receipt/audit
failure, no read marks and audit redaction. Disposable PostgreSQL covers simultaneous
retries, competing revisions, consent/provider contention and interrupted transactions.
No provider is called by these tests. See project records for full verification.

Pending CRM order after released 20261016174527: 20261016180739 revision foundation,
20261016181809 mark-read, 20261016183011 preview, then
20261016183855_crm_mcp_conversation_reply.sql. No E2 migration/runtime change.
Reconcile live aliases before a later release; apply only new forward migrations,
never either full history. No migration, release, live grant change or SMS occurred
in this local implementation step.

## Conversation reply preview — October 16, 2026 (local only)

crm_preview_conversation_reply is now registered as read-only, idempotent and
closed-world under the opt-in conversation_reply permission. The local catalog
has 48 tools and 33 permissions. Sending a reply is still unimplemented; no live
grants change. Metadata and message-body reads retain their separate permissions.

Strict input: businessId, conversationId, current positive safe-integer revision
and body. Text is trimmed using JavaScript whitespace semantics and limited to
1600 UTF-16 units. No phone, purpose, actor, scheduling or idempotency override is
accepted. The recipient comes only from the scoped conversation/contact. Missing,
foreign or malformed thread relationships fail closed. Stale revisions return
CONFLICT and require rereading; they never return a sendable stale preview.

The result contains the trimmed body, recipientPhone, revision, estimatedSegments,
eligible, blockers, aiWillPause and queued:false. Segment estimates match the SMS
worker's GSM basic/extension and UTF-16 calculations; they are not billing quotes.
Consent follows the existing CRM transactional staff-reply path: opted_out blocks
the reply; marketing_consent is a separate campaign rule and is not bypassed for
campaigns. This preview does not grant or change consent. A paused/inactive
business or disabled sending produces BUSINESS_SENDING_DISABLED. Missing configured
provider, account, stored credential metadata or sender route produces
SENDER_NOT_READY. CONTACT_OPTED_OUT is independent, so all applicable blockers are
returned. No credential is decrypted or exposed and no provider is contacted.

The shared conversation guard waits for related committed changes before checking
revision. Eligibility fields are then read together in one database snapshot.
Business/provider readiness is freshly checked each time even when the thread's
revision has not changed. Eligibility is a local snapshot, not a reservation or a
delivery guarantee. Provider health, rate limiting and actual delivery remain
send-time concerns. Any future reply tool must recheck revision and eligibility.
aiWillPause means a future successful reply would newly pause this thread's AI;
it is false if AI is already paused. The preview itself never pauses AI, marks
messages read, creates an outbox/job/receipt, or changes consent or automations.

The normal gateway records connection use and an audit of actor, target, request,
outcome and revision. Reply text, recipient phone and credentials are excluded
from audit storage. Application roles cannot directly execute private helpers.
Local isolation, eligibility, no-side-effect, Unicode-parity and concurrent-consent
tests cover these contracts; project records contain the broader verification.

Pending CRM migration order: 20261016180739 revision foundation, 20261016181809
selected-message mark-read, then 20261016183011_crm_mcp_conversation_reply_preview.sql.
Released baseline remains 20261016174527. No E2 migration/runtime change is needed.
Reconcile live aliases before a later release and apply only forward migrations.
No migration is applied and no live data or SMS is changed by this local step.

## Selected conversation messages: mark read — October 16, 2026 (local only)

The local catalog now exposes 47 tools and 33 possible permissions. The opt-in
conversation_mark_read grant enables crm_mark_conversation_messages_read; reply
and reply preview remain reserved. Existing connection grants are unchanged.
Mark-read does not imply conversation_read or conversation_messages_read. To
inspect a thread before selecting messages, grant those read permissions separately.

Input is strict: businessId, conversationId, current positive safe-integer revision,
1–100 distinct messageIds and an 8–128 character idempotencyKey. Only selected
inbound messages in the exact business/thread/contact phone can be marked. Any
missing, foreign, mismatched or outbound ID rejects the whole request. There is
no mark-all option. Already-read messages keep their original timestamps; an
all-read selection is a successful no-op with an unchanged revision.

Read the latest thread, select explicit IDs, then submit once. On CONFLICT,
reread and review the selection before making a new request with a new key.
After an uncertain response or TEMPORARY_FAILURE, retry the identical payload
with the same key. Receipts are committed atomically with the read updates and
revisions; changed payloads with the same key conflict. Identical retries return
the original receipt (including its original unread count), not a fresh snapshot.
Connection/staff/action/business grants are rechecked even for a cached receipt.

The result reports committed database status, previous/current revisions,
changedMessageIds, changedCount and scoped unreadCount. Only read_at changes
(plus existing timestamp/revision triggers); generation, AI pause, consent,
automations and send queues are untouched. Messages arriving after the selection
remain unread. Parent-first locking matches CRM; selected message locks use
NOWAIT to safely roll back contention with message-first worker updates.

Private activity records include actor, connection, request ID, target, outcome,
previous/result revisions and changed message IDs/count. Receipts and audits
contain no message body, phone, credentials or arbitrary payload. Application
roles cannot call the private mutation helper directly.

Pending order: released 20261016174527 conversation reads, then local
20261016180739 conversation revision foundation, then local
20261016181809_crm_mcp_conversation_mark_read.sql. Both pending migrations belong
to CRM; no E2 schema/runtime change. Reconcile live aliases before a future release
and apply only new forward migrations, never either complete history. This step
does not apply migrations, release code, grant live permissions or change messages.

Local tests: test/mcpConversationMarkRead.test.js exercises grants, strict input,
scope substitution, stale revisions, no-ops, retries, rollback and audit redaction.
scripts/test-conversation-mark-read-concurrency.js uses disposable loopback
PostgreSQL to verify concurrent retries/edits, worker contention and late inbound
messages. See project records for the completed broader verification.

## Conversation action foundation — October 16, 2026 (local only)

The catalog still exposes 46 tools. Two new opt-in permissions bring the local
permission catalog to 33: `conversation_reply` and `conversation_mark_read`.
Both are labeled reserved in AI connections. They do not imply metadata/content
access, and no reply, preview or mark-read MCP tool is executable in this step.
Existing grants are unchanged.

Strict input/output contracts are defined for the next increments:

| Contract | Required inputs beyond explicit business/conversation IDs |
| --- | --- |
| crm_preview_conversation_reply | positive safe-integer revision; trimmed body, 1–1600 characters |
| crm_reply_to_conversation | same revision/body; 8–128 character idempotencyKey |
| crm_mark_conversation_messages_read | revision; 1–100 distinct message UUIDs; idempotencyKey |

Caller-selected recipients, senders, purpose, scheduling, mark-all, actor and
generation substitutions are rejected. Preview output is explicitly unqueued;
reply output describes a committed queued receipt with message/job IDs and the
canonical AI-pause effect, not delivery. Mark-read output identifies changed IDs,
their count and remaining unread count. These contracts do not implement retry
storage, enqueueing, preview eligibility or read-state mutation yet.

CRM-owned pending migration `20261016180739_crm_mcp_conversation_revisions.sql`
follows released `20261016174527`. Existing conversations gain revision 1 without
changing their historical fields. The revision is a database-managed safe bigint,
separate from automation `generation`. Conversation changes and message inserts,
updates, deletes and reassignment bump it; reassignment touches both scoped
threads. Contact and group changes invalidate only their related conversations.
Timestamp-only message/contact/group updates and identical conversation updates
do not bump it. Multiple existing triggers may advance it more than once; treat
it as an opaque version, not an event count. The new triggers never alter generation.

CRM list/detail and MCP list/detail expose the shared revision. Detail MCP reads
pin the parent row while fetching metadata and messages, preventing a mixed
revision/page. Private MCP detail audits now record revision instead of generation.
The private `lock_conversation_revision` primitive validates staff/scope and a
strict expected revision, locks the parent and returns CONFLICT on stale input.
Application roles cannot call it directly. Future mutation wrappers must check
connection/action grants first and use the guard and mutation in one transaction.

Existing CRM actions keep their current behavior; their changes now invalidate
MCP snapshots. This step does not retrofit revision arguments into legacy CRM
actions or provide MCP writes. The next mark-read/reply increments must integrate
the guard, atomic retry receipts, bounded message selection, audits and consistent
mutation lock ordering. Worker delivery/consent fencing continues to use existing
generation and eligibility checks; a read-state revision must not cancel a send.

No migration, live grant or release was applied. Before a later release reconcile
both repositories' live migration aliases, apply only this forward migration,
then release matching MCP/frontend code. No E2 migration/runtime change is needed.
See both project records for local isolation and PostgreSQL concurrency results.

## Conversation-read MCP production release — October 16, 2026

Applied only CRM migration 20261016174527_crm_mcp_conversation_reads.sql after
reconciling both repositories against all 132 live entries, including aliases and
documented historical remote-only entries. Guarded rollback rehearsal matched
the local function hashes; isolated CLI dry run selected exactly one migration
with no role/seed/vault changes. Live history now has 133 entries with the previous
132 unchanged. All three function hashes match; the private helper denies direct
execution to all five application roles. Security advisors are unchanged. No
history repair/replay, unrelated pending migration, E2 migration or Edge release.

Released code eaae604a54c816df080b2d3c2232eebf603afd0c to the existing services in
the previously confirmed Micah workspace. MCP deploy dep-db96bdrbc2fs738g51ng
and CRM frontend deploy dep-db96buc9v7es73963740 are live. MCP health is HTTP 200,
and served permission assets contain both conversation grants. The frontend
produced no automatic deployment/event after the push; one explicit deployment
released it. No MCP runtime errors appeared in the post-release log check. The
Supabase connector required reauthentication; the existing authenticated CLI
performed reconciliation, migration and verification. E2 runtime is unchanged.

The verified all-business admin connection received only conversation_read and
conversation_messages_read under the user's standing admin-control request.
All existing grants/scope were preserved; revision advanced 5 -> 6 through the
canonical audited administrator operation. Other connections received no grants.

A fresh authenticated Codex MCP session discovered 46 tools and checked both
new tools' strict schemas and read-only annotations. Ten read-only calls passed
(nine successful, one correctly denied missing-record probe). Opek has one
conversation with five messages and one unread message. Metadata excluded bodies;
explicit detail returned the scoped message page. Contact/unread/search filters
and audit actor/connection/request attribution were verified. The two successful
detail audits identify the exact conversation and generation. Both existing test
runs remain stopped with next send null. No mutation tool was invoked.

Before/after hashes match for conversation state, every message's read state,
messages, contacts, submissions, forms, sequences, runs, bookings, lead/handoff
content and email enrollments. SMS send-job hashes/counts and outbound-message
counts are unchanged. Only expected migration, connection grant/last-use and
private audit writes occurred. No messages were marked read and no SMS was sent.

Local verification remains separate: CRM 572 passed/29 existing skips, E2 relevant
tests 26 passed, paired tests 63 passed, both project checks, frontend build and
65-function Edge bundling passed. Release-time focused conversation/discovery
tests passed 13/13 and the CRM required check passed again. Receipts are ignored
data/conversation-release-*. Both project records and affected workflow docs are
updated; unrelated main-checkout work is preserved. Earlier local-only notes are
historical implementation checkpoints.

## Conversation reads — October 16, 2026 (local only)

The local catalog has 46 tools and 31 opt-in permissions. `conversation_read`
grants metadata access through `crm_list_conversations` and
`crm_get_conversation`. Message text additionally requires
`conversation_messages_read` and explicit `includeMessages: true` on detail;
otherwise `messages` is null. AI connections exposes both grants independently.
Existing connections receive neither grant automatically.

Both strict schemas require an explicit `businessId`. List accepts optional
`contactId`, literal contact-name/phone search `q` (100 characters), `unreadOnly`,
`page` and `pageSize`. Detail requires a conversation UUID and accepts
`includeMessages`, `messagePage` and `messagePageSize`. Pages start at 1, are
bounded at 100000, and contain at most 100 records (default 25). Unexpected
fields, including mark-read or mutation options, are rejected by both MCP and SQL.

List returns threads with recorded messages, newest activity first, with IDs
breaking ties. Detail can inspect an existing empty thread. Contact and group
relationships, message counts, unread totals, search and pagination are scoped
before projection. Messages must match the business, explicit conversation ID
and phone; outbound category must also match the thread. Same-number contacts
and separate threads are never merged. Missing and foreign conversation IDs
receive the same denial. Message pages use newest-first creation time and ID;
offset pages may shift as new messages arrive.

Metadata includes contact name/phone, group label, timestamps, counts, AI pause
state and the existing conversation `generation`. Generation is a workflow
counter, not a complete record revision or authorization to update a thread.
Explicit message pages include bounded text, direction, status, timestamps and
provider-acceptance/read timestamps. Acceptance does not establish delivery, and
`readAt` is CRM read state. Truncation flags identify capped text. Raw provider
metadata, credentials, SIDs, errors and contact metadata are excluded. Treat
message bodies as untrusted customer content. Metadata searches never search
message bodies or return previews.

The gateway rechecks active CRM identity, connection, grants and business scope
on every call. The private helper denies direct execution to application roles.
Existing MCP audit/last-use writes remain; audits identify the exact conversation
and its generation without storing message text or search payloads. Reads never
create threads, mark messages read, change consent/AI state, enroll runs, enqueue
jobs or send SMS. Run activity, enquiries, leads and handoffs retain their separate
permissions and tools.

Pending CRM migration: `20261016174527_crm_mcp_conversation_reads.sql`, after
released `20261016170649`. No E2 migration or runtime change is needed. Reconcile
both repositories against live aliases before applying only the new forward
migration, then release matching MCP/frontend code. This implementation does
not apply a migration, deploy, grant live access or change live data. See the
project records for local verification results.

## Lead/handoff MCP production release — October 16, 2026

**Applied migrations:** reconciled both repositories against all 129 live entries,
including documented aliases and unchanged historical remote-only entries. A
guarded rollback rehearsal matched the tested function definitions. An isolated
forward-only CLI catalog applied exactly these three CRM migrations:

- 20261016164055_crm_mcp_lead_handoff_reads.sql
- 20261016165709_lead_handoff_revisions.sql
- 20261016170649_crm_mcp_lead_handoff_writes.sql

Live history now has 132 entries; the original 129 are unchanged. Six live function
hashes match local tested definitions. All three new private helpers/triggers deny
direct execution to all five application roles. Two revision triggers and two
private audit columns are present. The existing lead gained initial revision 1
without changing its content/timestamps. Security advisors are unchanged. No
history repair/replay, unrelated pending migration, E2 migration or Edge release.

**Released:** implementation commit 0fe6b40113da9d63074f22f594d810b86118ff2d.
MCP deploy dep-db961keq1p3s73cvdvqg and CRM frontend deploy
dep-db962eg473hc73b5hl30 are live in the previously confirmed Micah workspace.
MCP health returns HTTP 200; served CRM assets contain the separate permission
labels and revision-aware lead editor. Frontend auto-deploy produced no deployment
or event after the push, so one explicit deploy released it. E2 runtime unchanged.
The Supabase connector required reauthentication; the already-authenticated CLI
performed the release. Git SSH host verification failed, so the existing HTTPS
repository URL was used without changing SSH security settings.

**Connection:** the existing verified all-business admin connection received only
lead_read, lead_assign, lead_status_update, handoff_read, handoff_assign and
handoff_status_update, consistent with the user's standing admin-control request.
Its revision advanced 4 -> 5; all prior grants and scope were preserved. The
canonical administrator operation recorded the grant change. Permissions remain
independently controllable in AI connections.

**Live verification through Codex:** a fresh authenticated app-server MCP session
discovered 44 tools, checked strict input schemas and accurate read/write,
idempotency and external-effect annotations for all eight lead/handoff tools, and
made ten read-only calls. Eight succeeded; two missing-record detail probes were
correctly denied. Opek returned one lead with its actual shared revision and zero
handoffs. No handoff record was created to test detail success; that path was
covered locally. All ten calls have matching actor/connection/request attribution;
the successful lead detail audit identifies its exact record and revision.
No assignment/status mutation tool was invoked. Both existing test SMS runs remain
stopped with next send null. Final content hashes/counts match the pre-migration
snapshot for leads/handoffs (excluding the new revision metadata), submissions,
contacts, forms, sequences, runs, bookings, messages and email enrollments. SMS send
job and outbound-message counts are unchanged. Only expected migration metadata,
permission, audit and connection-last-use writes occurred; no SMS was sent.

**Local verification before release:** CRM 563 passed/29 existing skips; final
focused discovery/write tests 14 passed; E2 relevant tests 26 passed; paired tests
63 passed; both required project checks, frontend build, Edge bundle and real
PostgreSQL concurrency checks passed. These local results are separate from the
production checks above. Receipts: ignored data/lead-release-* and data/lead-writes-*.
Both project records and affected workflow docs are updated. Unrelated local
main-checkout work is preserved. Earlier local-only notes are historical checkpoints.

## Lead/handoff assignment and status — October 16, 2026 (local only)

The catalog now has 44 tools and 29 opt-in permissions. This supersedes the
reserved-write/next-increment notes in earlier checkpoints below.

| Tool | Required permission | Editable field |
| --- | --- | --- |
| crm_assign_lead | lead_assign | owner |
| crm_set_lead_status | lead_status_update | status |
| crm_assign_handoff | handoff_assign | owner |
| crm_set_handoff_status | handoff_status_update | status |

All require explicit businessId, the resource UUID (leadId or handoffId), current
positive safe-integer revision and an 8–128 character idempotencyKey. Assignment
accepts a text owner label of at most 200 characters, trims it, and clears it with
null or whitespace. It does not establish staff identity or change status. Status
is open, assigned, resolved or closed; changing it preserves the owner. Strict
schemas reject other fields. Reads remain independently granted. The result is
only businessId, databaseStatus committed, record id/revision/updatedAt,
previousRevision and changedFields (owner/status or empty for a no-op).

The gateway checks active CRM staff, current connection, action grant and business
scope before mutation or replay. The private helper locks the scoped record,
checks its contact belongs to that business, and invokes update_lead_handoff.
Shared triggers cover worker and CRM edits. Stale revisions and conflicting
reopens return CONFLICT; reread and review before choosing a new request. No
automatic overwrites. Missing and foreign references share the same denial.

Retry keys are per connection and bound to tool plus the entire payload excluding
the key. The change and receipt commit together. Identical retries return the
original receipt, even after a later edit; they do not reapply the old change.
Changed payload/tool conflicts. Current grants and revocation still gate replays.
Failed writes leave no retry receipt or domain change. Identical fresh edits keep
revision and timestamp unchanged; they still receive an audited receipt.

Private activity records retain actor, connection, tool, target, request ID, time,
success/denial/replay, resulting revision, previous_revision and changed_fields.
They contain no owner labels, answers, message bodies, credentials or raw payloads.
The administrator activity endpoint includes these fields. Native handoff status
events remain authoritative; retries do not duplicate the domain transition.

These edits manage existing leads/handoffs. They do not create a sales stage for
every submission, change SMS runs or consent, change bookings or another resource,
retry alerts, or enqueue messages. Existing workers retain their field ownership.

Forward release order after the already-reconciled paired baseline:
20261016164055_crm_mcp_lead_handoff_reads.sql,
20261016165709_lead_handoff_revisions.sql,
20261016170649_crm_mcp_lead_handoff_writes.sql, then matching CRM frontend/MCP
release. All three remain local/unapplied. No E2 migration/runtime change is
required. Reconcile live aliases before any future deployment; never replay either
history. Grant changes remain a separate administrator action.

Local verification includes database isolation, independent grants, strict direct
gateway inputs, revision and uniqueness conflicts, receipt-failure rollback,
revocation even on retries, audit redaction, and unchanged messaging state.
scripts/test-mcp-lead-handoff-concurrency.js uses disposable loopback PostgreSQL
with two clients for simultaneous retries, competing edits, worker conflicts and
transaction rollback. It never accepts a production database URL.

## Shared lead/handoff revisions — October 16, 2026 (local only)

CRM migration 20261016165709_lead_handoff_revisions.sql follows the pending
20261016164055 read migration. Both remain unapplied. No new MCP mutation tools
or permission grants are introduced; the local catalog remains 40 tools.

Existing leads/handoffs start at revision 1 without changing their saved content
or timestamps. A shared BEFORE INSERT/UPDATE trigger owns the counter: every
meaningful row change increments it, including worker summary/fields, handoff
reason/priority and alert status/error changes. INSERT sets revision 1; UPDATE
cannot supply a different revision. Identical values and timestamp-only updates
keep both revision and updated_at unchanged. Revisions are positive JS-safe
integers; exceeding the bound aborts the transaction.

The canonical update_lead_handoff operation now requires revision and at least
one of status/owner, rejects extra/invalid fields and checks staff/business scope.
It locks the scoped row, compares the expected revision and applies only supplied
fields. Missing/foreign IDs share Record unavailable. A stale snapshot is SQLSTATE
40001 / HTTP 409; a conflicting reopen remains a 409 through the existing unique
open-record constraint. No silent retry or overwrite. Owner remains a text label.

The Voice Agent lead editor sends the rendered revision, retains entered values
on errors and requires a refresh/review after conflict. Existing voice and general
record readers include the counter. MCP list/detail outputs and detail read audit
records now contain the actual counter; the null-revision checkpoint below is
historical. updatedAt remains informational. Worker SQL keeps its existing field
ownership and atomic merges/upserts; database triggers cover all those writers.

No new SMS/AI/run/booking/consent/alert action is introduced. Revision triggers
do not enqueue work or invalidate customer caches. Existing status events remain
in place. MCP mutation idempotency and independent assignment/status tools remain
the next increment. This is not an editable sales stage for every submission.

Release must apply the two pending CRM migrations in order before the matching
frontend and MCP service; old clients lacking revisions fail closed and need a
refresh. E2 schema/runtime is unchanged. Never replay either migration history.
Local conflict/isolation tests include disposable real PostgreSQL with two clients
racing staff/staff and worker/staff updates for both record types; stale writes
fail after the lock holder commits and a freshly read revision succeeds.

## Lead and handoff reads — October 16, 2026 (local only)

The local catalog adds four read-only tools, bringing it to 40:

| Tool | Permission | Inputs |
| --- | --- | --- |
| crm_list_leads | lead_read | businessId; optional status, contactId, q, page, pageSize |
| crm_get_lead | lead_read | businessId, leadId |
| crm_list_handoffs | handoff_read | businessId; optional status, contactId, q, page, pageSize |
| crm_get_handoff | handoff_read | businessId, handoffId |

The four future grants lead_status_update, lead_assign, handoff_status_update and
handoff_assign are registered but expose no write tools. All six grants are
opt-in; existing connection grants are preserved. Neither read implies the other,
submission answers/status access, automation activity, consent changes or SMS.

These are existing lead/handoff records, not new statuses for every submission.
Outputs contain status (open/assigned/resolved/closed), priority, owner text label,
createdAt/updatedAt, scoped contact id/name/phone, and summary/reason. Owner is not
a verified staff assignment. Canonical revision counters do not exist yet:
revision is explicitly null, including in read audits. updatedAt is not a lock
token. Write protection remains a separate increment for all canonical writers.

Strict schemas reject unknown fields. Pages default to 25, cap at 100 and page at
100000; q caps at 100 and uses literal case-insensitive substring matching.
Tenant/contact/status/search filters precede totals and deterministic pagination
(createdAt descending, id ascending). Foreign/missing detail IDs share Record
unavailable. Contact joins include tenant. Text caps: owner/name 200, phone 32,
lead summary 4000, handoff reason 1000; textTruncated signals clipping. Raw fields,
message bodies, consent evidence, job/alert internals and related lead contents
are excluded.

Detail enquiry references use only explicit source-message response or handoff
attribution. Both endpoints must match business/customer. Form references require
the exact canonical form/submission; direct references have null form/submission
IDs. Unlinked, malformed, foreign, test and appointment-run references return
null. Phone matching alone never establishes a link. No nested run state or
answers are exposed.

CRM owns 20261016164055_crm_mcp_lead_handoff_reads.sql, after 20261016063330 and
the paired E2 baseline. Application roles cannot execute the private helper;
only the connection-authorized gateway invokes it. Staff, connection, business
and action checks run each call. Successes and denials audit actor/connection,
tool, target and request ID, without customer content. Reads change only
audit/last-use bookkeeping. No E2 schema/runtime change is required.

Local tests: CRM 545 passed/29 existing skips, 12 focused MCP checks, 26 E2
enquiry/customer-lead/cache checks, 63 paired contracts, both required project
checks, frontend build (synthetic local publishable key) and 65-function Edge
packaging passed. Isolation tests cover grants, counts/pages/search, malformed
nested links, direct/test references, revocation, private roles, redaction and
unchanged domain/cache/queue/message snapshots. No live grants/data/deployment.
The migration remains unapplied; reconcile aliases before any forward-only release.

## Enquiry MCP released — October 16, 2026

Both enquiry migrations (20261016061921, 20261016063330) are applied and CRM
MCP/frontend commit 3c85353 is live. Codex discovers all 36 tools, including
crm_list_enquiries and crm_get_enquiry under enquiry_read, and
crm_get_enquiry_status under the separate enquiry_status_read permission.
The existing admin connection has both reads; other connections receive no grants
automatically. Opek's two existing submissions were verified: no consent means
CONSENT_REQUIRED/no run; the consented submission's version 1 run is stopped with
no next send. Both submissions have zero recorded booking/handoff links. SMS state
and linked outcomes remain distinct. Both test runs remain stopped; collection
and future-consented follow-ups remain enabled. No SMS or domain changes were
made during release verification. E2 schema/runtime is unchanged. See
PROJECT_RECORD.md for exact migration/deploy IDs and separate local/live checks.
The local-only enquiry notes below describe earlier implementation checkpoints.

## Enquiry milestone step 2 — local implementation, October 16, 2026

`crm_get_enquiry_status` now uses the independent `enquiry_status_read` grant;
it is no longer reserved. Local discovery contains 36 tools. No existing
connection gains a permission. `enquiry_read` alone cannot read status, and
status-only access cannot read submission answers, SMS timelines, or control runs.

Required inputs: businessId, formId and submissionId. Extra keys, including
runId, expected revisions and mutation retry keys, are rejected. Each request
rechecks active CRM staff, connection, permission and business scope. Missing
and inaccessible references use the same `Enquiry unavailable` error. The private
helper is not executable by MCP, API, browser or service roles directly.

The strict output has one reportingAt and business timeZone, with an enquiryStatus
object containing source IDs, preset, submittedAt, saved submittedFormVersion and
requestedAppointmentAt. Facts remain separate:

- `intake`: canonical intake state and an allowlisted skip reason. Unknown states
  become unknown; arbitrary error/reason text is excluded.
- `sms`: exact form-run state takes precedence over the tenant-scoped legacy
  enrollment, then intake skipped/received. Source, run/enrollment ID, generation,
  published version and nextRunAt are explicit. Only active runs/enrollments
  expose nextRunAt; paused records may retain an internal due timestamp but are
  not scheduled to send. Requested appointments are never confirmed bookings.
- `responses.linked`: inbound responses with recorded run attribution.
- `bookings`: linked, confirmed, cancelled and requested counts from current
  booking records. Cancellation and attribution corrections affect subsequent reads.
- `handoffs`: linked, open, assigned, resolved and closed counts from current
  handoff records. These do not change or infer SMS or booking state.

All related links and source rows must match the permitted business and exact
run. No outcome is inferred from a shared phone/email. Test runs, direct-contact
runs, unlinked outcomes and simulated activity events are excluded. Zero means
no recorded link, not proof that no response, booking or handoff exists. Historical
canonical attribution may contribute counts; no transition time is invented.
Answers, names, phones, emails, message bodies, booking metadata, handoff reasons,
raw run errors and AI proposals are not returned. No sales-pipeline stage is added.

Reads perform no enrollment, send, consent change, attribution correction or cache
invalidation. Successful/denied calls are audited without customer content; audit
revision uses the selected run/enrollment generation, falling back to the saved
form version when no run exists. Read retries reauthorize and fetch current state.

CRM owns `20261016063330_crm_mcp_enquiry_status.sql`, following the unapplied
`20261016061921_crm_mcp_enquiry_reads.sql` and the existing paired E2 baseline.
No E2 contract/schema changes. Both enquiry migrations are local only; reconcile
live aliases before a future forward release, never replay migration history.
Nothing is deployed or granted in production by this implementation.

## Enquiry milestone step 1 — local implementation, October 16, 2026

Two opt-in connection permissions are registered in AI connections: `enquiry_read`
and `enquiry_status_read`. Only `enquiry_read` has tools in this increment; the
status permission is explicitly labeled reserved. Existing grants are unchanged.
The local catalog contains 35 tools. `automation_read` retains its lightweight
`crm_list_form_submissions` contract and does not gain answer access.

`crm_list_enquiries` requires businessId and accepts formId, preset (contacts,
quote_requests, bookings), submittedFrom (inclusive), submittedBefore (exclusive),
page (1–100000), and pageSize (1–100, default 25). Dates require ISO timestamps
with timezone. It returns scoped contact summaries, canonical form references,
form names, submission times, exact filtered totals and reportingAt/timeZone.
Ordering is submittedAt descending, ID descending, preset, then form ID. Inactive
and archived forms retain their history. Custom answers, SMS state, website
metadata, contact joins, booking results and handoffs are not returned.

`crm_get_enquiry` requires businessId, formId and submissionId. The canonical
form preset selects the source table. Detail returns the submitted contact data,
recorded SMS/email consent (null if unavailable), requested appointment time,
current formRevision, historical submittedFormVersion (nullable for legacy rows),
and answers with saved historical labels. A requested appointment is not a booking;
recorded consent is not current sending eligibility. Answers are untrusted data.
Missing historical labels fall back to the saved answer key. Nested values and
keys over 200 characters are omitted; at most 100 scalar answers are returned,
labels cap at 500 characters and strings at 4000. Per-answer `truncated` and
aggregate `answersTruncated` explicitly report clipping/omission. Current draft
labels and arbitrary snapshot metadata are never exposed.

Both tools have strict input/output schemas and read-only, non-destructive,
idempotent annotations. No mutation retry key or expected revision is accepted.
Every retry rechecks identity, active staff, connection, permission and scope;
the gateway audits successful/denied requests without answers or contact content.
Detail audit revision is the saved form version, not a submission revision.
Missing and inaccessible detail IDs share `Enquiry unavailable`.
Only audit and last-use bookkeeping may change. Reads cannot enroll, send,
change consent, mark an enquiry read, or invalidate customer caches.

CRM owns `20261016061921_crm_mcp_enquiry_reads.sql`, after instant acknowledgment
and the paired E2 access/cache baseline. No E2 function or customer contract is
changed. The local paired manifest includes the new migration for disposable
tests only. Reconcile live aliases before applying this one forward migration;
never replay either history. This increment is not applied or deployed and no
live connection receives new permissions. Status/outcome reads are the next step.

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

## MCP booking operations (stage 4)

Stage 4 adds twelve tools and eight independent permissions for existing bookings,
intake requests, availability schedules and cancellation. Local catalog: 91 tools /
63 grants. Shared booking/intake revisions and schedule versions cover browser and
worker updates. Schedule creation is inactive; editing and enablement are separate.
Availability preview creates no reservation. Intake edits do not create or
reschedule operational bookings. Canonical cancellation and intake lifecycle hooks
remain authoritative; affected record IDs and generations are audited.

Canonical mirroring can update shared contact names/email, so wrappers additionally
require current contact revisions and contact_edit when those fields change.
Denied calls roll back all effects. Strict database schemas, scoped joins/counts,
atomic receipts/audits and current grants on replay protect every operation.
Legacy disabled SMS booking configuration remains excluded.

Local CRM: 642 passed / 29 existing skips; paired 63; relevant E2 13. Both project
checks, frontend and 65-file Edge bundle pass. Disposable PostgreSQL confirms
concurrent retries, browser conflicts and interrupted cancellation rollback.
Migration 20261016194340 is reconciled against 140 live entries and rollback-
rehearsed, not yet applied. No E2 runtime release is required. Production smoke
checks will use reads/previews only, with no customer edits or SMS.

## Knowledge and active SMS AI MCP — October 16, 2026 (local)

Stage 5 adds twelve tools and nine independent grants. Local catalog: 103 tools /
72 permissions. Source/version reads are scoped and bounded, with explicit IDs and
paginated extracted text. Manual text is untrusted content. Creation queues indexing;
refresh, archive and version approval are independent and revision protected.
Duplicate origins conflict instead of overwriting. Shared triggers fence browser,
worker and MCP changes. Archive rejects in-flight indexing, cancels pending jobs,
and audits affected versions/jobs; archived knowledge cannot be resurrected by a
stale worker. Structured profile knowledge stays in the profile-review workflow.

Private file uploads use a committed upload intent and a 60-second, one-use adapter
ticket. The restricted database login can mint tickets only for its own authorized
intent; CRM Edge consumes them after rechecking identity, grants and business scope.
Storage credentials remain in Edge. Signed upload URLs are ephemeral responses,
never audit or retry-receipt content. Storage URLs expire after two hours and do not
permit overwrite; uploaded size/MIME must match the intent before indexing. Intent
expiry is 24 hours. Lost signing responses recover the same intent with the same
idempotency key and a fresh URL. No OAuth token is forwarded as a browser session.

AI reads do not insert defaults. Instruction edits preserve mode/booking activation;
activation is separately granted and requires a reviewed profile plus an active,
sending-enabled business with a ready SMS connection. The October 16 Business Info
release removed the pilot/live-validation prerequisite; legacy shadow and
liveValidated fields remain historical compatibility data. No tool sets the private validation flag or queues
an SMS. AI instruction content is excluded from mutation receipts and audit.

Local CRM 651 passed / 29 existing skips; paired 63; relevant E2 15; both project
checks and frontend/66-file Edge bundle pass. Real PostgreSQL concurrency covers
same-key indexing/settings retries, worker lock/revision conflicts, archive versus
refresh, interrupted transactions and one-use upload races. Migration 20261016200143
is reconciled against 141 entries and rollback-rehearsed, not yet applied. Release
order: migration, CRM Edge adapter, MCP environment/service, frontend. No E2 runtime
release required. Live smoke checks use only reads and existing previews.

## Email MCP — October 16, 2026 (local)

Stage 6 adds twelve tools and eight separate grants (115 tools / 80 permissions).
Scoped group, enrollment and job reads keep content behind email_content_read;
no unsubscribe credentials, provider payloads or leases are exposed. Deterministic
schedule preview creates no AI draft or enrollment. Configuration preserves
activation; browser and MCP edits share revisions. Enablement uses a one-use,
payload-bound CRM Edge ticket to retain provider/AI readiness checks. Secrets stay
in Edge. Resolution fences existing work; retry requires current job/enrollment
revisions, generation, recorded and current source consent, no suppression/overlap,
and the provider retry window. Frozen content/provider idempotency are preserved.

The separately granted form email-consent switch applies only to existing legacy
email-connected forms, preserves collection/SMS settings and creates no backfill.
Disabling cancels email enrollments and audits their revisions. Draft bases advance
only when previously current. All mutations use transactional receipts and audits.

Local verification: CRM 659 passed / 29 existing skips, paired 63, relevant E2 7;
both checks, frontend and 67-file Edge bundle passed. Disposable PostgreSQL verifies
concurrent retries, browser conflicts, interrupted transactions and one-use ticket
races. Migration 20261016202046 alone reconciles against 142 live entries; rollback
rehearsal matches twelve function hashes. Not yet applied/released. Release order:
CRM migration, CRM Edge adapter, MCP/frontend, admin grants, read-only verification.
No E2 runtime change. No customer records or sending workers used in verification.

## Email MCP release — October 16, 2026

Stage 6 is LIVE at a0ce383c151c83c68986fee16e77cd3874d66a6c. Only migration
20261016202046 advanced reconciled history 142 to 143; twelve function hashes
match and private helpers remain denied. CRM Edge deployed before the service.
MCP dep-db98m0e1egvs73csslpg completed 20:37:56 UTC; frontend
 dep-db98m2vf3r2c73ai0b6g completed 20:37:44 UTC (no automatic push event).
Admin connection revision 13 now has 80 permissions. Codex discovered 115 tools;
23 allowlisted reads/previews passed, with 23 attributed audits and zero mutation
receipts. Domain snapshots and security advisors are unchanged. Opek forms and SMS
v1 remain enabled, both test runs stopped, and the reply unread. No email/SMS send,
enrollment, activation or content edit occurred during verification. Local CRM
659 passed / 29 existing skips, paired 63, relevant E2 7, checks/builds and real
PostgreSQL concurrency passed. Stages 7–9 remain.

## Voice MCP — October 16, 2026 (local)

Stage 7 adds twelve tools and eight independent grants (127 tools / 88 permissions).
Agent/configuration/history and call reads use scoped projections and bounded pages.
Draft creation deploys nothing; canonical draft_version protects browser and MCP
saves, publication and rollback. Publication requires an existing deployment/phone
and applies to new calls; rollback copies history while preserving the saved draft.
Current calls and customer service visibility remain separate. Browser lock races
return retryable failure promptly; subsequent stale revisions conflict.

Transcripts and private recordings each require a separate grant and honor deletion
and retention. One-use, 60-second media tickets recheck current identity, grants and
scope in CRM Edge. Recording URLs expire within five minutes; credentials remain in
Edge and are absent from receipts/audit. MCP never calls the global deployment
catalog or exposes raw call request payloads, SIP/room/job identifiers or media paths.

Local CRM 668 passed / 29 existing skips; paired 63 and relevant E2 4 passed. Both
project checks, frontend/68-file Edge bundle, final targeted tests and disposable
PostgreSQL concurrency passed. The final lock-handling change was rechecked with
targeted and concurrency tests; the paired baseline was rerecorded and checks rerun.
Migration 20261016203800 reconciles against 143 live entries and ten function hashes
match rollback rehearsal. Not yet applied/released. Release order: CRM migration,
CRM Edge media adapter, MCP/frontend, grants, read-only Codex checks. No E2 runtime
change. No live calls, publication, transcript edits or SMS in release verification.

## Voice MCP release — October 16, 2026

Stage 7 is LIVE at 42e82935fff1d0944883c5492c79b57c7bad0a69. Migration
20261016203800 alone advanced reconciled history 143 to 144. Ten function hashes
match and private helper access remains denied. CRM Edge deployed before MCP.
MCP dep-db98qfjbc2fs73eq3r80 finished 20:47:34 UTC; frontend
 dep-db98qm8m7kps73bj6n9g finished 20:47:35 UTC. Admin revision 14 has 88 grants.
Fresh Codex discovered 127 tools and passed 31 allowlisted reads, with 31 attributed
audits and zero mutation receipts. Voice and other domain snapshots and security
advisors are unchanged. Both canary runs remain stopped and the reply unread.
No recording URL requested, call started, configuration published or SMS sent in
live verification. Local CRM 668 passed / 29 existing skips, paired 63, E2 4,
checks/builds and final PostgreSQL concurrency passed. Stages 8–9 remain.

## Website MCP — October 16, 2026 (local)

Stage 8 adds fifteen tools and ten grants (142 tools / 98 permissions). Reads scope
site links, deployments, form connections and update requests before pagination/counts.
Details edits preserve ownership/domain/publication and share site revisions with
browser saves. E2 adds deployment/connection revisions, site revision changes for
connections/publication, and fences metadata edits during hosting operations.
Request edits reuse the E2 revisioned workflow. Connections never enable collection
or SMS; no tool creates websites, uploads files, builds, buys domains or transfers ownership.

CRM owns durable publication intents, fingerprints/receipts, grants, audit and hashed
one-use tickets. The E2-owned /api/web-hosting/mcp adapter consumes those proofs with
its existing server credentials, rechecks the CRM identity/connection/business grants,
and uses the canonical hosting lease, R2 publication and cache invalidation. Completed
operations replay status; interrupted or unknown external writes remain held for
operator reconciliation. Read-only publication checks distinguish unavailable from
unpublished and recheck scope after storage. No OAuth token becomes a browser session;
R2 credentials, manifests, source files and preview tokens never enter MCP receipts.

Local CRM 679 passed / 29 existing skips; paired 63. E2 full run had 240 passes and
one fixture-path failure; that fixture now honors SMS_PROJECT_ROOT and all eight of
its tests pass. E2 checks, six worker tests, paired 63, production build and targeted
adapter/site tests pass. Disposable PostgreSQL covers concurrent details/intent
retries, browser conflicts, interrupted transactions, competing execution claims
and one-use proofs. CRM frontend/68-file Edge bundle pass. Two forward migrations
reconcile against 144 live entries and match rollback rehearsal. Not yet applied.
Order: CRM 20261016204900 integration state, E2 20261016204903 hosting contract,
E2 runtime, MCP trusted adapter URL/service, CRM frontend, grants, read-only checks.
No production website publication, customer record edit or messaging verification.

## Operational MCP — October 16, 2026 (local)

Stage 9 adds eleven tools and six independent grants (153 tools / 104 permissions):
scoped queue/job and provider-operation metadata, assigned sender inventory,
activation readiness, status refresh, safe status reconciliation, eligible failed
status-check recovery and sending activation. Inventory explicitly reports saved
connection state and last-check time; it never enumerates parent-account resources.
No job payload, credential, provider response or customer content is projected.

Business, provider, registration, job and remote-operation revisions advance for
all writers. Mutations lock/check all relevant revisions, use the existing
connection-scoped transactional fingerprints/receipts and audit affected job and
operation revisions. Only failed, unleased, non-reconciliation refresh_status jobs
with pending/failed remote state can be retried; send, purchase, canary and unknown
outcomes remain excluded. A queued MCP reconciliation is pinned to a specific
uncertain status/registration operation and rechecked by the canonical worker
context before any provider call. Purchase/binding reconciliation is rejected.
Activation uses canonical readiness and requires ready/delivered-canary state; it
may release existing eligible work but does not enroll contacts or create a test.

CRM owns forward migration 20261016211044. It follows the released website/E2
contract; no E2 schema or runtime change is required. Customer cache invalidation
and provider workers retain their canonical behavior. No live mutation verification.
Local validation and release outcome are recorded separately below.

## Operational MCP validation and migration — October 16, 2026

Final CRM verify:release passed: 686 tests, 29 existing skips, 63 paired tests,
checks, frontend build and complete 68-file Edge bundle. E2 verify:release passed:
248 tests, six worker tests, 63 paired tests, lint/type/worker checks and production
build. Final real-PostgreSQL concurrency tests passed for refresh, retry, activation,
worker locks, stale revisions and interrupted rollback; no provider calls or sends.

Reconciled 146 live migrations including aliases. Rehearsed and applied only
20261016211044_crm_mcp_operations (147 live history entries), with nine matching
function hashes and no private helper execute grants. No E2 migration or worker
runtime release was needed. MCP/frontend deployment and read-only verification
follow; this entry does not claim that release is complete.

## Nine-stage MCP rollout complete — October 16, 2026

All nine planned stages are implemented and released. The final catalog has
153 tools and 104 independent permissions, compared with 49 tools / 33 grants at
the starting baseline. The authorized all-business admin connection is active at
revision 16 with all released grants; new connections still receive no grants.
The exclusions in docs/MCP_ROLLOUT.md remain explicit.

Final implementation commit 8a724e1c0d6f8443158d4a256092b8cd6d0a9eca is live on
MCP dep-db99bcrbc2fs73ert380 (21:23:39 UTC) and frontend
dep-db99begpd3as73be8pi0 (21:23:19 UTC). Migration 20261016211044 alone advanced
history from 146 to 147 after reconciliation/rehearsal; nine function hashes
matched and private helper execution stayed denied. E2 hosting runtime remains
the verified 4b41268 release; this stage needed no E2 runtime or worker redeploy.

Fresh Codex discovered all 153 tools and completed 52 allowlisted read/preview
calls by 21:24:23 UTC. All 52 had attributed audit records and zero mutation
receipts. Domain snapshots and security advisors were unchanged. Opek's two
canary runs remain stopped with no next run; its reply remains unread. No customer
record changes, publication, activation, enrollment, mark-read or SMS/email sends
were performed during release verification.

Final local verification: CRM verify:release 686 passed / 29 existing skips;
E2 verify:release 248 passed plus six worker tests; paired suites 63 passed;
checks/builds and disposable PostgreSQL concurrency passed. Local checks, applied
migrations and live deployments are separate evidence, recorded above.

## Terminal operation lifecycle and archive

CRM owns 20261016213635_compliance_operation_lifecycle, applied after the
operational MCP migration (20261016211044). Do not replay either project history.
Terminal failed/cancelled compliance jobs now conclude only safe pending canary
preflight or non-reconciliation status operations. The check excludes successful
or uncertain results, external resource SIDs and canaries with downstream send
records. Worker finish and exhausted-lease recovery use the same transaction,
revision and redacted audit path.

Archive is owner-only maintenance using archive_obsolete_provider_job, not a
new MCP permission or browser action. It requires canonical active staff access,
an explicit business/job ID and current job/operation revisions. Only old,
unleased failed preflight canaries with a later successful delivered replacement,
or cancelled bootstrap jobs superseded by a configured connection, qualify.
Rehearse scoped maintenance in a rollback transaction and compare protected
domain hashes before committing. No queues, sends or credentials are created.

Archived rows retain payloads, dedupe keys and audit history; updates/retries
are rejected. CRM operations, grounded diagnostics and MCP operational lists
exclude archives before counts/paging. Scoped MCP details remain readable by ID
with the original terminal status; archive timestamps are private maintenance
metadata. Successful delivery history and active services are never archive
candidates in this workflow. E2 public/customer contracts and caches are unchanged.

October 16 release: history 148; two obsolete Opek jobs and their one failed
operation archived, with all other domain hashes unchanged. Nine fresh Codex
read calls verified readiness and filtered diagnostics. See both project records
for local tests and the separate database-only release evidence.
