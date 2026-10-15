# API reference

## Staff MCP integration (local implementation)

The separate hosted MCP service and its nine business-setup tools are documented
in [CRM MCP](CRM_MCP.md). The browser API adds staff-only
`GET/POST /platform/ai-connections` and
`GET /platform/ai-connections/activity?connectionId=...&page=...`.
Connection updates require the expected revision and explicit grants/business
scope; `allBusinesses` includes future registrations. These routes require the
CRM-owned MCP migration before deployment. Browser and MCP OAuth validation are
separate; customer sessions cannot authorize either staff interface.

This reference covers the checked-in Edge interfaces. There is no separately versioned OpenAPI schema. The authoritative adapters are [CRM handler](../supabase/functions/crm-api/handler.js), [HTTP/auth helpers](../supabase/functions/_shared/http.js), the function-specific handlers and the latest SQL definitions in the owning repository. Examples use synthetic identifiers; mutation examples are illustrative and must not be sent to production as smoke tests.

## Bases and authentication

The current function root is `https://wxamwhfmelxqahkdtcci.supabase.co/functions/v1`. CRM routes below are relative to `/crm-api`. The CRM handler also strips an optional leading `/api` after that prefix to support browser adapter paths.

| Caller | Authentication and routing |
| --- | --- |
| CRM browser | `Authorization: Bearer <CRM Clerk session JWT>`; business routes additionally require `X-Tenant-ID` |
| Global staff directory/actions | Same CRM session and explicit staff grant; `/platform/*` does not require tenant selection |
| Public form | No login; public form ID and optional validated website connection |
| Twilio | Provider signature over canonical URL and form fields; tenant resolved from account plus destination sender or recorded attempt, never account alone for shared accounts |
| Business integration | Per-business timestamped HMAC and `X-Tenant-ID` |
| Email provider | Resend/Svix signature |
| Soni bridge | Timestamped HMAC; server fixes tenant to Opek |
| Worker dispatch | Queue bearer token; see [worker inventory](ARCHITECTURE.md#worker-inventory) |

`verify_jwt=false` in function configuration disables the Supabase gateway verifier, not these application checks. CRM expects JSON bodies (shared reader caps text length at 65,536), uses exact-origin CORS and returns no-store JSON. Use `Content-Type: application/json` for CRM writes. Customer Clerk sessions and legacy `X-API-Key` do not authorize CRM Edge calls.

The browser preserves an explicit `X-Tenant-ID` and captures it before token
retrieval; selecting another toolbar business cannot silently replace a request's
target. The header is routing context, not authority. Session/user changes reject
old token/response completions and clear the authorized workspace cache. Reads
addressing a different business bypass the selected-business cache.

The tables list the methods clients should use. Some CRM write branches accept additional non-GET methods because they share a dispatch block; do not rely on that permissiveness. Explicit method guards return 405 where implemented. A method not handled by a route can also produce 404.

## Session and global staff

| Method and path | Input / output |
| --- | --- |
| GET `/auth/config` | Public login configuration: `mode`, `loginApplication`, `manualBusinesses`, `configured`, publishable key and frontend issuer URL |
| GET `/auth/me`, `/tenants`, `/businesses` | Session/business workspace data; `user`, `tenants`, `businesses`, selected/first tenant, and `capabilities`; production session paths synchronize identity and return canonical workspaces with `smsRead`/`formsManage`; see [linking contract](CRM_LINKING_RELEASE.md#authorization-and-operator-access) |
| POST `/businesses` | `{accountId,tenantId?}`; compatibility entry for registered-customer setup; 200 `{business:{id}}` or `{business:{requiresReview:true}}`; staff only, rejects blank ownerless creation |
| GET `/platform/accounts`, `/platform/businesses`, `/platform/websites` | `q`, `page`, `pageSize`; 25 default, 100 maximum; staff directories |
| GET `/platform/{accounts|businesses|websites}/{id}` | Staff detail including related records |
| POST or PATCH `/platform/business-register` | `{accountId,tenantId?}`; completed active customer required; creates/reuses owner-linked registration |
| POST or PATCH `/platform/business-profile/draft`, `/platform/business-profile/review` | `{tenantId,revision,profile}`; save admin draft or approve extended facts; new setup revision is 0 |
| POST or PATCH `/platform/services` | `{tenantId,kind,siteId?,siteRevision?}`; website/SMS/enquiries/bookings/voice; reviewed profile required; idempotent service addition |
| POST or PATCH `/platform/services/visibility` | `{tenantId,serviceId,revision,visibility}`; draft/live customer visibility, independent of operational activation |
| POST or PATCH `/platform/status` | `{accountId,revision,status}`; active/suspended |
| POST or PATCH `/platform/memberships` | Account/business role, explicit permission booleans and revision; new membership revision is -1 |
| POST or PATCH `/platform/ownership` | Target account/business, membership revision and `previousOwnerId`; audited transfer |
| POST or PATCH `/platform/website-business` | `{siteId,tenantId,revision}` |
| POST or PATCH `/platform/connections` | `{siteId,formId}`; matching business and enabled form |
| POST or PATCH `/platform/connections/disable` | `{siteId,connectionId}`; retire without deleting attribution |

Registry schemas and action payload validation are E2-owned. See [staff CRM](STAFF_CRM.md#interfaces-and-security) and [E2 staff API](../../E2local-main/docs/staff-crm.md). Expected revisions prevent stale updates. Emails/names are search data, never identity or authorization keys.

Read-only session example, with a session token obtained through the intended CRM login:

```powershell
$crmBase = 'https://wxamwhfmelxqahkdtcci.supabase.co/functions/v1/crm-api'
Invoke-RestMethod "$crmBase/auth/me" -Headers @{
    Authorization = "Bearer $env:CRM_SESSION_TOKEN"
}
```

`CRM_SESSION_TOKEN` is an example shell variable, not an application configuration setting.

## Business reads

All routes in this section require `X-Tenant-ID` and the applicable database permission.

| GET path | Response / purpose |
| --- | --- |
| `/overview`, `/deliverability` | Message counts and derived delivery rate (null with no outbound denominator) |
| `/operations` | Runtime/job state plus `grounded` data; recent heartbeats summarize queues, not concurrent connections; problems/job counts are business-scoped |
| `/contacts`, `/directory`, `/opt-outs` | Paginated contact rows plus normalized `contacts`; opt-outs applies suppression filter |
| `/messages` | Paginated rows, normalized `messages` and `summary` |
| `/conversations` | Paginated conversation rows plus normalized `conversations` |
| `/conversations/{id}` | `{conversation}` with messages; may be null; ID can be a conversation UUID or encoded phone resolving a general thread |
| `/conversations/{id}/calls`, `/calls` | Call rows and `calls` |
| `/enrollments` | Rows plus `enrollments` with normalized drip metadata |
| `/categories`, `/automation-groups` | Retained fixed groups and email/legacy AI settings; no legacy SMS activation |
| `/automations/{groupId}` | `{sequence}` for a fixed automation, otherwise null |
| `/automation-intake/{type}` | Paginated fixed intake rows and enrollment status |
| `/web-forms` | Form definitions and editor permission data |
| `/web-forms/{preset}/submissions` | Original submissions with saved answers and field snapshots |
| `/booking-settings`, `/voice-booking-rules` | Booking configuration / `{rules}` |
| `/bookings`, `/bookings/{id}` | Operational appointment list / `{booking}` |
| `/email` | Email groups, enrollments, jobs and provider readiness |
| `/onboarding` | Shared draft, setup `revision`, review metadata and `approved` facts; administrator-only |
| `/business-ai` | Business AI settings |
| `/knowledge`, `/crm` | Knowledge overview and associated CRM work |
| `/provisioning` | Administrator-only sanitized provider state, including `serviceAdded` |
| `/twilio/registration`, `/twilio/readiness` | Registration state / activation readiness reasons |

Generic list responses include `rows`, `total`, `page`, `pageSize`, and `totalPages`; browser-facing aliases coexist with raw fields. Pagination limits and filters are resource-specific. Intake and form-submission adapters default to page 1 and 50 rows, with database caps; platform directories default to 25 and cap at 100. Do not assume one shared schema or one universal filter set. Inspect the corresponding RPC and its existing tests when adding an integration.

## Messaging and intake writes

| Method and path | Input / response |
| --- | --- |
| POST `/contacts` | Contact fields including `phone`; 201 `{contact}` |
| POST `/send`, `/directory/message` | `{phone,body,categoryId?,idempotencyKey?}` (`to` aliases phone); required idempotency; 202 outbox result |
| POST `/conversations/{id}/reply` | `{body,idempotencyKey?}`; required idempotency; 202 outbox result |
| POST `/contacts/{phone}/opt-in` | `{evidence}`; record genuine opt-in evidence |
| POST `/contacts/{phone}/opt-out` | Optional evidence; default “Admin suppression” |
| POST `/directory/unenroll` | Phone and enrollment/group context consumed by the database action |
| POST `/directory/enroll` | Disabled: 405 directing caller to fixed intake |
| POST `/conversations/{id}/read` | Mark thread read |
| POST `/conversations/{id}/ai/pause`, `/conversations/{id}/ai/resume` | Change thread AI state |
| POST `/conversation-messages/{id}/reassign` | `{groupId}` or null for general; inbound assignment |
| POST `/automation-intake/{type}` | `{name,phone,details,source?,sourceRecordId?,status?,appointmentAt?,email?,emailOptIn?,emailConsentEvidence?}`; 201 `{record}` |
| PATCH `/automation-intake/bookings/{id}` | Booking intake status and/or appointment; 200 `{record}` |
| POST `/bookings/{id}/cancel` | Required idempotency header/body key; 200 `{booking}` |
| POST `/jobs/{id}/retry`, `/automation-jobs/{id}/redraft` | Request eligible retry; 202; database safety checks still apply |

`type` is `contacts`, `quote_requests`, `bookings` or `reviews`. `details` must be an object. Intake deduplication uses business/type/source/source record; `sourceRecordId` takes precedence over the `Idempotency-Key` header. Reusing a source ID returns the existing record; it is not a record-update operation. Staff booking intake defaults to requested unless specified; confirmed appointments are required for reminder scheduling.

For sends/replies/cancellation, supply `Idempotency-Key` or the body `idempotencyKey`; the header wins. Reuse it for the same logical action after an uncertain response. Outbox conflicts are rejected when an existing key is reused with different request content. Do not create a new key solely to force a retry.

**Current `/send` is marketing-purpose**, unlike the old Express transactional API. A successful response is queued work, not proof of delivery. Example request shape:

```http
POST /functions/v1/crm-api/send
Authorization: Bearer <CRM-session-JWT>
X-Tenant-ID: example-business
Idempotency-Key: example-message-001
Content-Type: application/json

{"phone":"+13035550123","body":"Your requested follow-up is ready."}
```

Representative outbox response (IDs are placeholders):

```json
{"messageId":"<message-uuid>","jobId":"<job-uuid>","status":"queued"}
```

Phone helpers normalize international numbers and can add `+1` for ten-digit input; prefer E.164 explicitly. Booking adapters convert offsetless appointment timestamps using the business time zone; explicit ISO offsets avoid ambiguity. The public booking handler rejects nonexistent local times. Do not infer operational booking creation from an intake response.

## Configuration and administration writes

| Method and path | Contract |
| --- | --- |
| POST `/onboarding` | Profile fields plus required setup `revision` and `intent: "draft"` or `"review"` (default review); shared workflow; missing/stale revision returns 409 |
| POST `/provisioning/details` | Administrator-only; provider must already exist from explicit Add SMS |
| PUT `/booking-settings`, `/voice-booking-rules` | Save booking availability or a voice service/market rule |
| PUT `/web-forms/{preset}` | `{title,description,buttonLabel,enabled,fields,...}`; `{form}`; preserve existing consent settings when editing |
| PUT `/email/groups/{groupId}` | `{enabled,rule,intent,systemPrompt,businessContext,mailingAddress}`; `{settings}` |
| PATCH `/email/enrollments/{id}/resolve` | Resolve the email enrollment |
| POST `/email/jobs/{id}/retry` | Retry subject to email outcome/idempotency checks |
| POST `/enrich-website` | `{websiteUrl}`; public website enrichment draft |
| POST `/profile-versions` | Profile fields plus required setup `revision`; create shared draft, 201, returns `setupRevision` |
| POST `/profile-versions/{id}/approve` | `{revision}`; shared atomic review; missing/stale setup revision returns 409 |
| POST `/knowledge/uploads/sign` | `{fileName,contentType,size}`; 201 `{path,token,signedUrl,contentType,maxBytes}` |
| POST `/knowledge/sources` | Source configuration; queue extraction, 202 |
| DELETE `/knowledge/sources/{id}` | Archive source |
| POST `/knowledge/sources/{id}/refresh` | Queue refresh, 202 |
| POST `/knowledge/versions/{id}/approve` | Publish approved knowledge version |
| PATCH `/leads/{id}`, `/handoffs/{id}` | Update supported CRM work fields |
| POST `/handoffs/{id}/retry-alert` | Request deduplicated staff alert, 202 |

The old fixed-group schedule normalizer remains for compatibility and email;
its 1–30-send cadence is not the current form/direct SMS sequence contract.
Use the current sequence routes below for new SMS integrations.

Form presets are `contacts`, `quote_requests`, `bookings`. Up to 20 ordered custom fields use `{key,label,type,required,options?}`; public validation enforces the saved definition. Fixed name/phone/email/consent and booking time fields are not arbitrary custom fields. Knowledge uploads cap at 10 MiB and accept PDF, DOCX, plain text and Markdown MIME types; a signed URL does not itself create or approve a knowledge version.

These administration payloads are domain-specific objects, not interchangeable patches. Use the corresponding GET result, browser save implementation and latest RPC validation for the exact feature fields. Examples and regression fixtures live in [tests](../test/) and [browser forms](../public/formBuilder.js).

## Current form sequences

Current SMS uses versioned templates; the fixed-group cadence description above
applies only to retained compatibility/email data. Writes under
`/automation-groups` and `PUT /business-ai` return **410** before their legacy
branches execute. New integrations must use UUID form/direct routes and
`/inbound-ai`. UUID conversation AI pause/resume remains supported; legacy
non-UUID mutation paths are retired.

Form editing, SMS-read and staff automation-management are distinct permissions.
Read capability flags before offering actions. `id` below is a public form UUID;
type-based paths address only retained original forms. Multiple named forms may
share a contact, quote or booking starter.

| Method and path | Input / behavior |
| --- | --- |
| GET, POST `/web-forms` | List / create from `{title,preset,description,buttonLabel,fields,enabled}`; creation returns 201 `{form}` |
| PUT `/web-forms/{id}` | Save definition; disabling collection pauses active runs |
| POST `/web-forms/{id}/{duplicate,archive,restore}` | Copy, recoverably delete, or restore disabled; preserve history |
| GET `/web-forms/{id}/automation` | Draft, revision, published version and enabled state |
| GET `/web-forms/{id}/submissions` | Paginated original submissions and run state |
| GET `/automation-presets` | Business presets |
| PUT `/web-forms/{id}/automation/{draft,publish}` | `{sequence,revision}`; publish an immutable version |
| PUT `/web-forms/{id}/automation/state` | `{enabled}`; activation is separate from publishing |
| PUT `/web-forms/{id}/automation/preset-save` | `{name,sequence}` |
| PUT `/web-forms/{id}/automation/{pause,resume,stop}` | `{runId}` within the form/business |
| PUT `/web-forms/{id}/automation/enroll` | `{submissionId}`; eligible historical enrollment |
| POST `/web-forms/{id}/preview` | `sample` and optional unsaved form/sequence inputs; no real run or send |
| GET, POST `/web-forms/{id}/test-runs` | List / start actual scheduled SMS tests; start returns 202 |
| POST `/web-forms/{id}/test-runs/{runId}/stop` | Stop future test sends |

Sequences use `trigger,leadHours,replyPolicy,startHour,endHour,steps`; steps use
`body,delayCount,delayUnit,sendCount,intervalCount,intervalUnit`. Form reply policy
is pause/continue. Units are minute/hour/day/week/month; sequences allow 1–50
steps, each with 1–1,000 sends. `leadHours` is 1–8,760 and applies to appointment timing. See [validation](../public/formAutomation.js) and
[test payloads](../public/formTest.js). Preview payload: `{sample,fields?,sequence?,submittedLocal?,scenario?}`; sample
contains name, phone, email, SMS consent, details and optional appointmentLocal.
Real test start uses `{sample,fields?,sequence?,requestId,confirmed:true}`.
Real tests require confirmed recipient,
consent, stable request ID and enabled sending. See [Form automations](FORM_AUTOMATIONS.md).

## Direct contact automations

GET `/contact-automations/templates` returns `{templates,canManage}`;
GET `/contact-automations/read?contactId=...` returns contact, runs, overlap
snapshot and time zone. POST `/contact-automations/preview` takes contact/template
IDs, template revision, optional sequence, context and start time. It returns up
to 50 messages and template/contact revisions without mutation.

Staff mutation POSTs require a stable `Idempotency-Key`; body `idempotencyKey`
is a fallback and the header wins. Reuse it only for the same logical payload.

| POST suffix under `/contact-automations/` | Important fields |
| --- | --- |
| `save`, `publish` | Existing template `id` when applicable, `name,sequence,revision` |
| `archive` | Template `id,revision`; existing runs remain |
| `enroll` | `contactId,templateId,templateRevision,contactRevision,overlaps`; optional `sequence,context,startAt`; explicit `overlapChoice` and `stopRunIds` when needed |
| `run` | `contactId,runId,generation,operation`; pause/resume/stop |
| `block` | `contactId,revision,blocked`; unblock restarts nothing |
| `edit` | `contactId,revision` and explicit `name`/`email`; phone is immutable |

Direct sequences use submission timing and pause/continue/stop reply policies.
Their Continue quiet window applies even with AI off/shadow. See
[workflow](DIRECT_CONTACT_AUTOMATIONS.md) and [payload builder](../public/contactAutomations.js).

## Inbound AI and activity reporting

GET `/inbound-ai` reads settings/context. PUT takes `{revision,mode,systemPrompt,bookingEnabled}`; see [settings client](../public/inboundAi.js).
The database enforces pilot and live-validation gates. POST
`/conversations/{uuid}/ai/{pause,resume}` controls that conversation only.

GET `/automation-activity/{report,summary,enquiries,timeline,unlinked}` requires
SMS-read permission; the bare path aliases report. Filters include date range,
form, template, scope, status, search, tags, response, booking, handoff and quick
view. Timeline requires `runId`. Staff POST actions are `tag,tag_assignment,
booking_link,response_link,activity_link,sequence`, with applicable revision or
generation. Links require a scoped run and same-customer record, not just a
matching phone. See [action payloads](../public/automationActivity.js) and
[metric definitions](AUTOMATION_ACTIVITY.md). Reports do not call an LLM.

## Staff Voice workspace

CRM identity and selected business are required; customer reads use E2.

| Method and path | Input / behavior |
| --- | --- |
| GET `/voice` | Agent library, configuration and business summary |
| GET `/voice/{calls,leads}` | Paginated scoped lists and filters |
| GET `/voice/{call,media}?id=...` | Call detail / audited short-lived media URL |
| POST `/voice/create` | `{requestId,configuration}`; stable UUID, private draft only |
| POST `/voice/initialize` | Operator import of verified deployment; see Voice CRM |
| POST `/voice/save` | `{agentId,version,configuration}` |
| POST `/voice/publish` | `{agentId,version}`; connected phone/deployment required |
| POST `/voice/rollback` | `{agentId,version,revision}`; publish prior revision |
| GET `/platform/voice-setup?tenantId=...` | Staff release readiness; no tenant header required |

Configuration contains `name,persona,voice,brain,voiceName`. Service addition and
visibility use `/platform/services` actions with kind `voice`; they do not
provision a cloud worker. Media URLs last at most five minutes, bounded by
retention even before cleanup. See [Voice CRM](VOICE_CRM.md) and
[Customer Voice](CUSTOMER_VOICE.md).

## Twilio account connections

GET `/platform/twilio/accounts` returns authorized accounts and bindings/reservations.
GET `/platform/twilio/profiles?accountSid=...&tenantId=...` returns selectable
senders, unavailable reasons, truncation status and business connection state.
These provider-backed reads require staff authority.

POST `/platform/twilio/connect` takes `tenantId,accountSid,messagingServiceSid,
phoneNumberSid,registrationSid,revision,confirmedBusinessIdentity:true`.
Choose values from fresh inventory; registration SID may be null for a
voice-capable toll-free number awaiting SMS approval. The server revalidates
ownership, reserves the exclusive sender, updates/verifies webhooks and stores
credentials privately. An account can be shared; its number and Messaging Service
cannot be shared across businesses. Connection does not activate SMS.
GET `/sms/connection` returns the permitted sanitized business summary.
See [Twilio connections](TWILIO_CONNECTIONS.md).

## Twilio setup actions

| POST path | Result / effect |
| --- | --- |
| `/twilio/provision` | Administrator-only retry, 202; rejects before explicit Add SMS without creating a job |
| `/twilio/number-search` | Proxy to compliance-session with `action: search_numbers`; sanitized candidate numbers |
| `/twilio/registration-session` | Proxy to compliance-session; short-lived embedded session |
| `/twilio/registration/start` | Start saved registration workflow, 201 |
| `/twilio/paid-action` | Explicit paid-action confirmation, 202 |
| `/twilio/status-refresh`, `/twilio/reconcile` | Queue status/reconciliation work, 202 |
| `/twilio/canary` | Queue intended activation canary, 202 |
| `/twilio/activate` | Enable only after database readiness succeeds |

Direct `POST /compliance-session` uses the same CRM JWT, origin and tenant checks. Number search returns `{numbers}`; successful embedded session creation returns `stage`, `inquiryId` and `sessionToken` with saved operation data, normally 201. Provider ambiguity is checkpointed and can return 502. Tokens and legal answers must not be persisted in browser logs. See [Twilio setup](multi-tenant-twilio.md).

## Public forms and unsubscribe

`GET /web-form/{publicFormId}` returns `{form}`. `POST` at the same URL accepts JSON. Optional `?connection=<uuid>` must be present on both reads and submissions for E2 website attribution. Invalid or unavailable connections never fall back to an unconnected submission.

```json
{
  "submissionId": "3e516548-7779-46a6-849b-7b0ac44538a8",
  "name": "Example Customer",
  "phone": "+13035550123",
  "email": "customer@example.com",
  "smsOptIn": false,
  "emailOptIn": false,
  "details": {},
  "website": ""
}
```

Use a new UUID for a new submission, retaining it on retries. Populate required custom answers from the current definition. Booking forms also require `appointmentAt`. `website` is a honeypot: a filled field returns simulated success without saving. Actual creation returns 201, an identical duplicate 200, typically `{ok:true,submissionId,duplicate}`. Changed content under an existing ID is rejected; attribution also participates in retry identity.

Public forms allow wildcard CORS, require JSON for POST, cap bodies at 16 KiB and use database rate buckets (10 attempts per 10-minute form/IP bucket, 100 per hour per form). Rate denial returns 429 with `Retry-After: 600`. Storage success does not imply consent or enrollment. Contact/Quote unchecked SMS consent saves without starting SMS. Email needs its separate enabled switches and consent. Booking submissions are confirmed reminder intake, not operational appointments.

`POST /web-form/email/unsubscribe?token=<uuid>` applies email unsubscribe without a login; GET is rejected with 405. The static unsubscribe page calls this endpoint. Treat tokens as private recipient capabilities.

## Provider and business webhooks

| Endpoint | Contract |
| --- | --- |
| POST `/twilio-webhook/inbound` | URL-encoded Twilio fields and `X-Twilio-Signature`; inbound `To` checked against configured sender |
| POST `/twilio-webhook/status` | Signed delivery callback; optional `attempt_id` query is included in canonical signature URL |
| POST `/twilio-webhook/call` | Signed call event |
| POST `/email-webhook` | Raw Resend event plus Svix headers; accepted types: sent, delivered, delivery_delayed, bounced, complained, failed, suppressed |
| POST `/business-events` | `X-Tenant-ID`, `X-Event-Timestamp` in Unix seconds, `X-Event-Signature`; HMAC-SHA256 lowercase hex over `timestamp.rawBody`, tolerance 300 seconds |

Twilio rejects duplicate form fields and unsupported content type; its success response is empty `<Response/>` XML. Email verifies the raw signed payload and records provider events; irrelevant valid event types return `{ok:true}`. Neither webhook is an invitation to replay production events as tests.

Business events require `eventId`, `id` and `phone`. Supported types are `quote.created`, `booking.created`, `booking.rescheduled`, `booking.cancelled`. Booking events use `appointment_at`; optional `name` and object `metadata` carry context. Sign the exact raw JSON string transmitted. Accepted events return 202 with `{ok:true}` or `{duplicate:true}`. `eventId` identifies a logical event, while `id` identifies the operational quote/booking. Each new reschedule/cancellation needs a new event ID. Database hooks create the corresponding intake; callers must not enroll a second time.

## Voice and internal workers

`POST /voice-agent` requires `X-Voice-Timestamp` and `X-Voice-Signature` using HMAC-SHA256 lowercase hex over `timestamp.rawBody`, with a 60-second tolerance. Bodies cap at 16,384 characters. Envelope: `{action,callId,callerNumber?,payload,requestId?}`; call IDs are 8–160 characters. Responses wrap RPC data as `{ok:true,result}`.

Actions are `verify.start`, `verify.check`, `customer.lookup`, `intake.create`, `record.update`, `booking.prepare`, `booking.confirm`, `booking.cancel`, and `sms.send`. Intake creation, cancellation and text sending require a stable request ID of 8–160 characters. Verification and confirmation gates remain inside the voice RPCs. See the [voice handler](../supabase/functions/voice-agent/handler.js) and [voice guide](SONI_VOICE_BRIDGE.md) for payloads and caller interaction requirements.

`POST /soni-voice-inbound` requires Twilio URL-encoded fields and its signature, the configured exact destination/account and SIP credentials. It returns TwiML for the fixed LiveKit route. It is not a general outbound calling endpoint.

The nine queue worker endpoints accept POST with their configured bearer. Generic workers return `{status:"paused_or_busy",processed:0}` or `{status:"completed",processed:n}`; email returns `{processed:n}`. Calling one can process real jobs. Missing configuration returns 503, wrong bearer 401, wrong method 405.

## Registered-business Voice gateways

These are separate Edge functions, not `/crm-api` routes. Lookup, booking and
runtime use `X-Voice-Timestamp` (Unix seconds) and `X-Voice-Signature`, HMAC-SHA256
lowercase hex over `timestamp.rawBody`, with 60-second tolerance and separate
secrets. Envelope: `{action,callId,payload}`; call IDs are 8–160 characters.
The business is pinned server-side. Success is `{ok:true,result}`.

| POST function | Actions / boundary |
| --- | --- |
| `/voice-lookup` | `business.lookup` with `{query}` (max 500 characters); `verify.start` with `{phone}`; `verify.check` with `{phone,code}` (six digits); `customer.lookup` with `{phone}` after verification; body max 4,096 characters |
| `/voice-booking` | `availability` with service/variant/ZIP/local date; `prepare` also local time, phone, name, address, details; `confirm` with `{holdId}` UUID; max 16,384 characters; enabled flag, verification, capacity and fresh confirmation required |
| `/voice-runtime` | `configuration,start,heartbeat,finish,outcome,upload,uploaded`; max 600,000 bytes; enabled flag and action-specific fields required |
| `/voice-maintenance` | Separate bearer; cleanup stale calls/expired media; returns `{deleted:n}`; invocation can delete expired objects |

Runtime payloads: start uses `room,sipCallId,phone,revision,source`; finish uses
`status,duration,transcript,audio`; outcome uses
`outcome,summary,phone,name,service,location,request`; upload/uploaded use `bytes`;
configuration/heartbeat use `{}`. Database-generated paths and storage size/MIME
checks protect finalization. Maintenance has only cleanup authority. See
[Voice configuration](CONFIGURATION.md#voice-configuration),
[runtime](VOICE_CRM.md), [lookup](SONI_VOICE_BRIDGE.md), and
[booking](BOOKING_AVAILABILITY.md).

## E2 staff hosting reads

These endpoints belong to E2 at the reviewed `HOSTING_API_BASE`, normally
`https://www.e2local.com/api/web-hosting`. They use the CRM Clerk session and
canonical staff authorization. They are separate from `/crm-api/platform/websites`
and do not grant customer tokens access.

| GET path relative to the hosting base | Contract |
| --- | --- |
| `/` | `{sites,page,pageSize,total,totalPages}`; metadata-only directory, no deployment history or storage lookup per site |
| `/{siteId}` | `{site,page,pageSize,total,totalPages}`; site metadata, current `deployments` page, `liveDeploymentId` and `publicationStatus` |

Both accept positive integer `page` (default 1, maximum 1,000,000) and `pageSize`
(default 25, maximum 100); invalid pagination returns 400. Ordering is newest
`created_at` then descending `id`. `total` means sites in the directory and
deployments in site detail. `publicationStatus` is `published`, `unpublished` or
`unavailable`; a failed/timed-out manifest read is unavailable. A published ID is
validated as belonging to that site even when it is not on the deployment page.

The new CRM depends on the detail endpoint; deploy E2 first. Existing create,
upload/build, publish/unpublish, domain, form and update-request actions retain
their owning E2 contracts. See [website integration](WEBSITE_E2_INTEGRATION.md)
and [E2 hosting](../../E2local-main/docs/web-hosting.md) for those workflows.

## Errors and compatibility

CRM failures use `{error:"..."}`. Common statuses are 400 for invalid input/missing tenant, 401 for missing/invalid session, 403 for origin/access denial, 404 for unknown route/resource, 409 for conflicts, 413 for size and 500/503 for service/configuration failure. SQL errors are mapped centrally; not every missing row returns 404. Refresh stale revisions before retrying staff changes. Server errors intentionally omit internal details; inspect authorized logs by error code.

E2 `/api/web-hosting/**`, customer readers and signed Clerk lifecycle webhooks are external interfaces owned by E2. See [E2 references](README.md#e2-reference-checkout). Legacy `/api/send` with `X-API-Key`, `/health`, ElevenLabs calls and Express WebSockets are documented separately in [legacy reference](LEGACY.md).
