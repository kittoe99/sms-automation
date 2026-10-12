# Customer Voice dashboard

## Staff setup and release

1. Open the CRM business record and confirm its active customer owner.
2. Save a reviewed business profile. Voice uses these approved facts, not draft edits.
3. Configure and publish an already registered voice agent with a phone number in
   the CRM Voice workspace. This feature does not register new agents, buy numbers
   or change Twilio connections. Toll-free calling does not wait for SMS approval.
4. Under Services, choose **Add Voice**. The service begins in draft.
5. Choose **Set live** to make Voice visible to that business's customer owner.
   Release uses the existing revision checks and audit trail. **Hide from customer**
   removes access. Ownership transfer also hides it until staff explicitly release
   it for the new owner. Saving/publishing agent configuration does not release it.

## Customer experience and data boundary

The main dashboard shows a Voice tab and Overview card only for released services.
`/dashboard/voice` redirects to `#voice`; unreleased direct links show a setup notice.
Owners with multiple released businesses select one business at a time. Viewers,
operators and staff login identities do not gain customer Voice access.

The view contains published agent names and numbers, reviewed business name,
description, contacts, services, service areas and time zone. Published/observed
configuration revisions are not an uptime indicator and are not shown.

History includes all retained calls for the authorized business, including calls
before release. It is sorted newest first, 25 per page, with agent/status/local-date
filters and caller/summary search. Details show caller, agent, start, duration,
status, outcome, summary, transcript and recording availability. There are no
customer configuration, prompt, deployment, lead-management or editing controls.

Recording playback is requested on demand through same-origin POST. Every request
rechecks active owner, live service and business/call ownership. Ready, unexpired
private media receives an audited signed URL for at most 300 seconds, bounded by
remaining retention. Existing URLs can remain usable until their short expiry.
The UI has playback only and no download control; this cannot prevent audio capture.
The existing 90-day recording/transcript policy remains unchanged. Expired media
and transcripts are blocked even before cleanup; historical call metadata remains.

Voice metadata uses the dashboard's account/session/revision cache (schema 6).
The component, overview and first call page warm behind foreground work. Detail
transcripts, signed URLs and audio are never persisted or prefetched. Access checks,
identity changes, business switches and tab changes close details and stop playback.
Call/agent changes that affect customer data invalidate tenant revisions; draft and
heartbeat-only updates do not. UI expiry timers hide cached expired transcripts/media.

## Paired rollout

1. Apply only CRM `20261011235651_customer_voice_projection.sql` (private,
   allowlisted projections and playback audit helper).
2. Apply only E2 `20261011235654_customer_voice_service.sql` (Voice service kind,
   staff release wrapper, server-only customer reader and scoped cache triggers).
   It explicitly checks the CRM prerequisite and bumps the runtime cache revision.
3. Deploy CRM frontend and E2 frontend/API together. Existing CRM API service routes
   are reused; no CRM Edge handler redeployment is required for this feature.
4. Verify draft services remain hidden, authorized owners can read released services,
   other businesses/users cannot read their calls or recordings, and hide/transfer
   revokes subsequent requests. Release individual real businesses only by explicit
   CRM staff action; the migrations do not seed or release any service.

Do not replay either migration history over the shared database. These two files
are forward-only and leave current connections, messaging activation and agents intact.

## Validation and current status

The two forward migrations are applied in production in the documented order.
Frontend deployment is in progress; no real Voice services have been added/released.
CRM customer Voice tests exercise the paired migrations, release prerequisites,
revision/authorization checks, server-only grants, owner-only isolation, multiple
owned businesses, pre-release history, business-time-zone filters, pagination,
retention, audited playback, transfer/hide revocation and selective invalidation.
E2 tests cover API revisions, same-origin recording requests, concurrent access
changes, signed-URL expiry bounds, validation, scoped metadata caching, transcript
exclusion, warmup and navigation. Existing Voice and paired business/cache tests
also run. Both frontend production builds pass.

Browser QA uses `node test/fixtures/customer-voice-preview.js` from the CRM repository
(port 8188): synthetic data and silent fixture audio only, with no production calls.
Desktop and 390px mobile layouts, call details, status filtering, business switching,
empty history, playback, unavailable/expired recording states and hidden service
notice were checked. Two pre-existing E2 ownership tests still fail on unrelated
website text expectations (`Production deployment`, `Your website starts here`).

Production migration history records the exact applied file payloads as
`20261012021000 customer_voice_projection` and
`20261012021005 customer_voice_service` (Supabase-generated versions). These
correspond to source files `20261011235651` and `20261011235654`; do not replay
those source files because their local timestamps differ from the remote entries.
