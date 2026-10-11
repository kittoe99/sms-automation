# Workspace loading and browser cache

Release prepared October 11, 2026 on the previous Dashboard design release
`bea0d57`. The isolated production-config build and all 37 focused release checks
passed. Deployment status and evidence are recorded in the paired project records. No API, database, migration, or paired E2
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
