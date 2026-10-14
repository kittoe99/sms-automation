# Workspace loading and browser cache

## October 14 lifecycle and hosting changes — local only

Platform pages own independent hosts and cancellable read scopes. Navigation no
longer waits for all platform operations. Reads have a 30-second deadline and
cancel immediately when leaving, including while authentication/transport is
pending. Already submitted writes are not cancelled by ordinary tab navigation;
their results stay with the initiating page. Retained editors show a refresh hint
after background changes rather than losing unsaved values. A workspace/session
reset disposes old page controllers and prevents subsequent workflow steps.

Website deployments load only their site's paginated detail response, 25 versions
per page, instead of the complete hosting portfolio. Upload PUTs run with four
workers and a two-minute batch deadline; a failure stops remaining uploads. Build
requests have a separate two-minute deadline. An abandoned or failed upload remains
a staging deployment and can be inspected/deleted or rebuilt after verifying its
files; a deadline is not proof that a submitted server operation did not complete.
If E2 returns `hosting_recovery_required`, further mutations remain held until
the operator stops the original invocation, verifies storage and follows the
[hosting reconciliation procedure](../../E2local-main/docs/web-hosting.md#operation-recovery).
Neither repeated retries nor lease expiry clears that uncertainty. `hosting_busy`
means another operation is running; wait for its result and refresh.
Ordinary tab navigation can leave an upload running, with progress retained in its
page. Page reload, sign-out or changing business is not a durable background job.

Voice/Calls controls remount from their data model and preserve unsaved agent
drafts, while timers, audio sources and details are disposed on every departure.
Realtime connection ownership follows business/session changes and ignores retired
subscription callbacks. Explicit foreign-business reads retain their requested
tenant and bypass the selected-business cache.

The CRM deployment panel requires the paired E2 paginated site-detail endpoint
before release. Regression coverage includes Voice disposal/remount, explicit tenant
headers and cache bypass, platform cancellation with an uncooperative transport,
realtime reconnect/late SDK loading, upload concurrency/deadline, and paginated
deployment numbering. These are local functional checks, not production load tests.

## Existing cache release

Deployed October 11, 2026 as CRM `d507c4c` in Render deployment
`dep-db5tg067bikc73e0n9mg` (LIVE at 12:40:15 PM America/Denver). No API, database, migration, or paired E2
application release is required for these frontend changes.

The CRM uses E2 Local's Dashboard loader: a 30px blue rotating ring and small
label, with a 14px inline variant for refresh controls. Startup, main workspaces,
Forms panels, voice, activity, Twilio and contact automation loading states share
it. Reduced-motion preferences stop the rotation.

After the foreground workspace renders, permitted tabs warm one at a time during
browser idle periods. Lazy modules use the same imports as navigation. Overview,
Forms, Contacts, Inbox, Bookings, Message history, Opt-Outs, Delivery report and
staff platform directories warm their default summary/first-page GET requests.
Directory sizes match the visible page (50 CRM rows, 25 platform rows). Editors,
provider credentials/actions, individual records, searches, later pages, voice
recordings/transcripts and live activity details remain on-demand. No hidden
editor mounts, writes, message sends, booking actions or provider calls run as
part of warmup.

Warmup yields to navigation, refresh, writes and live invalidation; pauses while
the document is hidden; and is skipped for Save-Data or 2G connections. Requests
have low priority and a 15-second warmup timeout. Foreground requests can join
an in-flight warmup without being cancelled when the background caller stops.
Failed speculative requests do not prevent navigation; 401/403 stops the queue.

Successful allowlisted JSON responses are stored in memory and `sessionStorage`
under `e2-crm:workspace:v1`. This survives reloads in the same browser tab, not
browser restarts. It is bounded to 32 entries / approximately 1 MB serialized
UTF-16, at most 128,000 characters per response, with a 60-second freshness limit.
Storage denial/quota errors fall back to memory. Version the key when changing
the cached response contract.

The cache is activated only after fresh server authorization and workspace
resolution. Its scope includes API origin, Clerk user/session/organization,
selected business, returned workspace permissions and staff capability. Bootstrap
and auth responses are never cached. Foreign-business requests bypass it. Tokens
and headers are never serialized. Permission changes at the next bootstrap use
a different scope; authorization errors purge saved reads. Unlike E2's dashboard,
the CRM has no server revision handshake for these responses, so it uses bounded
time-based freshness rather than indefinite reuse.

Writes clear the read cache before and after the request. Refresh, live updates,
business changes, visibility return and sign-out also invalidate saved data.
Generation checks prevent an older request from refilling an invalidated cache.
Session/user identity is checked around token retrieval and response delivery,
so a delayed token from a prior Clerk account cannot start a request within the
new account's cache scope. Active-account changes clear retained drafts, selected
records, page reads and Realtime before a fresh authorized bootstrap.
Existing mounted-tab memory keeps drafts and scroll positions; aged or invalidated
tabs show “Refresh for latest activity” rather than silently replacing an editor.
Cached response data never grants write permission: the API still authorizes
every action. This is an acceleration layer, not offline CRM support or a promise
that every first visit will be instant.

Validation: 61 focused CRM checks (including cache cancellation, persistence,
expiry, authorization scoping, storage failure, and existing UI/workflows), 34
paired E2 dashboard/cache/warmup checks, and a successful production frontend
build. In a synthetic local preview with 350ms API delay, opening warmed Forms
made no additional Forms request; reloading made fresh auth/config and auth/me
requests while restoring the Forms data from session storage. These observations
are local functional evidence, not a production latency benchmark.

Release verification: the isolated production-config build and 37 focused checks
passed. The homepage and all eight entry/preload assets return 200 and match the
build; six served source files match the release commit. Render error logs are
empty. The isolated browser Forms check used synthetic data.
