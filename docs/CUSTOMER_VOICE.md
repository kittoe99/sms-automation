# Customer Voice dashboard

## October 12 production rollout status

CRM migrations are applied as `20261012202507 staff_voice_overview` and
`20261012202514 voice_setup_flow`; `crm-api` version 58 is ACTIVE. CRM frontend
commit `c43600a` is live in Render `dep-db6k4uavcj2c7389muug` at
https://crm.e2local.com; authenticated library and call-history checks passed. E2 application code is unchanged. The local-only/pending
notes below are historical and superseded by this status. Existing customer
Voice visibility stays draft until staff explicitly enable access.

## Staff setup and release

Use the [Voice Agents library and guided release](#voice-agents-library-and-guided-release)
procedure below. It is the current October 12 deployed workflow. Verify the active
owner and reviewed profile, manage a connected agent or create a private draft,
then use **Enable customer Voice** after the release checklist passes. Creating
a draft does not provision a cloud worker or connect a phone. **Hide customer
access** leaves calling connected. Publishing configuration and customer release
remain separate; ownership transfer hides the service until released again.

## Customer experience and data boundary

The main dashboard always shows the Voice tab. Its Overview card and customer
data require a released service. `/dashboard/voice` redirects to `#voice`; without
a released service, the tab shows "No voice agent yet" and a disabled **Add Voice
Agent** button with a setup-coming-soon note. Forms will be connected later.
This navigation update is deployed in E2 07f8f6c (October 12); customer access gates remain.
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
CRM release `4e9a5d5` is LIVE (`dep-db643tlckfvc73c2evk0`); E2 release
`fb4ada4` is Ready/Production (`dpl_GqrZQeWa8RiVuJ3aERM4qGoVoqh9`).
Live access gating, HTTP checks, grants and all 13 CRM JavaScript assets were
verified. No real Voice services have been added/released.
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

Security advisors after deployment reported no ERROR findings. Existing warnings:
[public extension](https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public),
[legacy anonymous definer grants](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable),
[legacy authenticated definer grants](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable).
The new reader is invoker in public, definer in the private schema, with execution
revoked from browser roles and granted only to the server role.

## Historical October 12 workspace implementation

Select a business in CRM, then open **Voice Agent**. Its overview shows reviewed
business information, services/service areas, agent names/numbers and the customer
Voice release status. **Manage business & Voice setup** opens that business's
record at Services. Use **Add Voice → Set live** there, or **Hide from customer**.
This releases an existing registered agent; generic agent deployment assignment
and provisioning still require the existing integration setup outside this screen.

The agent selector controls the admin configuration editor and preserves each
agent's draft. Calls can be filtered by agent, status, caller/summary and dates in
the business time zone; details include summaries, transcripts and private audio.
Playback has no download button, stops when leaving details/workspace, and expires
with its signed link. Configuration, availability, lead and booking controls remain
available only in CRM. Publishing settings still does not release customer access.

Historical rollout plan (completed; do not reapply): CRM `20261012195517_staff_voice_overview.sql` after the
previous paired customer Voice migrations, then deploy CRM API and frontend.
The updated API forwards the retention-bounded TTL to private Storage signing.
No E2 code/migration deployment is needed for these staff additions. Local tests
and browser verification are recorded in both PROJECT_RECORD files; these additions
were subsequently applied and released as recorded at the top of this guide.

## Voice Agents library and guided release

1. Select the CRM business and open **Voice Agents**. The business record also
   provides **Open Voice Agents** in its Voice panel.
2. Existing connected agents appear immediately with their phone and customer
   visibility. Use **Manage agent** or **Call history**. **Choose deployed agent**
   lists CRM-connected deployments; other-business assignments are labelled and
   disabled. It does not discover unregistered LiveKit deployments or transfer them.
3. **Create agent → Create draft agent** saves a new private CRM agent from a name,
   voice and instructions. Continue editing in Configuration. Creation retries
   reuse the same request UUID and do not duplicate agents. Drafts have no phone or
   deployment; the existing integration setup must connect their business-scoped
   runtime and phone before publishing. This UI does not provision cloud workers.
4. The release panel checks the active customer owner, reviewed profile and
   connected/published agent. Already attached agents resume here. Preview the
   customer-facing business information and agents, then explicitly choose
   **Enable customer Voice**. A missing service is added in draft before release;
   an existing draft is reused. **Hide customer access** leaves calling connected.
5. New unconnected drafts stay private even if another agent's customer Voice
   service is already live. Publishing agent configuration and releasing customer
   access remain separate operations. Toll-free SMS approval does not gate calls.

The new flow supersedes the generic Add Voice / Set live instructions above for
Voice. Those routes remain the underlying compatibility API. Existing customer
readers, history, recordings and owner-only access are unchanged.

Historical rollout plan (completed; see top-of-page mapping): CRM `20261012195517_staff_voice_overview.sql`, followed
by `20261012200816_voice_setup_flow.sql`; then release the CRM API and frontend.
The earlier paired customer Voice migrations are prerequisites and must not be
replayed. The local redesign initially made no releases; the subsequent production rollout is recorded above.
