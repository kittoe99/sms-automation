# Shared database table inventory

The owner-linked business setup/service tables and registration link were
subsequently applied in the October 1 paired release; they are not pending local
schema. The table list below is a dated September inventory, not today's complete
catalog. Canonical authority is enforced regardless of retained cutover switches;
legacy access tables remain only for compatibility/guarded cleanup.

Historical catalog review: September 29, 2026. These are the 69 application tables
reviewed before the shared registry migration; Supabase internal schemas are
excluded. Six additive platform tables extended that snapshot to 75. The E2
September 30 record adds two dashboard cache tables, listed below. This inventory
is a reconciliation of recorded reviews and repository definitions, not a fresh
live table count. See the [project record](../PROJECT_RECORD.md).

The only planned table consolidation is the three legacy access registries. They remain live during compatibility deployment. Profile, intake, original submission, contact, appointment and history tables have different purposes and remain intact.

| Schema/table | Purpose and decision |
| --- | --- |
| `public.contact_submissions` | Public E2 contact requests; retain separately from SMS contacts and attributed website enquiries. |
| `public.dashboard_account_businesses` | Legacy E2 enquiry/booking grants; consolidate into canonical memberships after verified cutover. |
| `public.dashboard_accounts` | Canonical account UUIDs, status, identity snapshots and Personal onboarding; retain. |
| `public.dashboard_business_profiles` | Customer onboarding business information; retain separately from SMS and website profiles. |
| `public.hosting_deployments` | Website source metadata, build versions and preview references; retain. |
| `public.hosting_form_submission_links` | Immutable website connection attribution to original SMS submissions; retain. |
| `public.hosting_site_forms` | Immutable website/business/form connections; retain. |
| `public.hosting_sites` | Websites, business association, compatibility owner and customer-safe details; retain. |
| `public.pricing_catalog` | Public E2 pricing definitions; retain outside tenant administration. |
| `public.pricing_requests` | Public E2 pricing requests; retain outside SMS intake. |
| `public.sms_ai_runs` | AI processing history; retain. |
| `public.sms_ai_settings` | Automation-group AI settings; retain. |
| `public.sms_automation_bookings` | Booking automation intake; retain separately from operational appointments. |
| `public.sms_automation_contacts` | Contact automation intake; retain separately from original contact submissions. |
| `public.sms_automation_enrollments` | Automation enrollment/lifecycle state; retain. |
| `public.sms_automation_groups` | Shared form automation rules; retain. |
| `public.sms_automation_intents` | Automation scheduling/intents; retain. |
| `public.sms_automation_quote_requests` | Quote automation intake; retain separately from original quote submissions. |
| `public.sms_automation_reviews` | Review automation intake; retain. |
| `public.sms_booking_sessions` | Booking conversation/session state; retain. |
| `public.sms_booking_settings` | Business booking availability/configuration; retain. |
| `public.sms_bookings` | Operational appointments; retain separately from booking-form requests. |
| `public.sms_business_ai_settings` | Business-wide AI settings; retain. |
| `public.sms_business_memberships` | Legacy subject/tenant SMS grants; consolidate into canonical memberships after verified cutover. |
| `public.sms_business_profile_versions` | Historical SMS profile versions; retain. |
| `public.sms_businesses` | Canonical tenant registry and SMS business profile; retain existing tenant IDs. |
| `public.sms_consent_events` | SMS consent history; retain. |
| `public.sms_contacts` | Operational SMS contacts; retain separately from accounts and original submissions. |
| `public.sms_conversations` | Operational message threads; retain. |
| `public.sms_daily_category_usage` | Automation-group usage aggregate; retain. |
| `public.sms_daily_usage` | Business/provider usage aggregate; retain. |
| `public.sms_handoffs` | Operational staff handoffs; retain. |
| `public.sms_knowledge_chunks` | Indexed knowledge content; retain. |
| `public.sms_knowledge_source_versions` | Historical source versions; retain. |
| `public.sms_knowledge_sources` | Business knowledge sources; retain. |
| `public.sms_leads` | SMS lead workflow; retain separately from website attribution. |
| `public.sms_message_events` | Provider delivery events; retain. |
| `public.sms_messages` | Original SMS messages; retain. |
| `public.sms_quotes` | Operational quote workflow; retain separately from quote-form intake. |
| `public.sms_thread_contacts` | Thread/contact association; retain. |
| `public.sms_twilio_registrations` | Provider compliance registration; retain. |
| `public.sms_voice_conversations` | Voice interaction history; retain. |
| `public.sms_voice_service_rules` | Voice booking service/market rules; retain. |
| `public.sms_web_form_booking_submissions` | Original booking requests and saved answers/labels; retain. |
| `public.sms_web_form_contact_submissions` | Original contact submissions and saved answers/labels; retain. |
| `public.sms_web_form_definitions` | Public form definitions, presets and fields; retain. |
| `public.sms_web_form_quote_request_submissions` | Original quote submissions and saved answers/labels; retain. |
| `sms_private.admins` | Legacy global staff subjects; consolidate into canonical staff grants after verified cutover. |
| `sms_private.archive_catalog` | Operational archive metadata; retain. |
| `sms_private.attempts` | Queue delivery/processing attempts; retain. |
| `sms_private.audit` | Existing SMS operational audit; retain alongside platform change audit. |
| `sms_private.edge_config` | Edge service configuration; retain. |
| `sms_private.edge_runs` | Edge execution history; retain. |
| `sms_private.email_consent_events` | Email consent history; retain. |
| `sms_private.email_enrollments` | Email automation enrollment state; retain. |
| `sms_private.email_group_settings` | Email automation-group configuration; retain. |
| `sms_private.email_jobs` | Email processing queue; retain. |
| `sms_private.email_provider_secrets` | Private provider credentials; retain server-side. |
| `sms_private.email_suppressions` | Email opt-outs/suppressions; retain. |
| `sms_private.email_webhook_events` | Email provider event deduplication; retain. |
| `sms_private.heartbeats` | Worker heartbeat records; retain. |
| `sms_private.jobs` | SMS/automation/AI queue; retain. |
| `sms_private.providers` | Provider routing/credentials; retain server-side. |
| `sms_private.remote_operations` | Provider provisioning operations; retain. |
| `sms_private.runtime` | SMS worker/queue runtime configuration; retain separately from platform cutover settings. |
| `sms_private.voice_booking_holds` | Prepared booking proposals; capacity is rechecked at confirmation, not reserved by preparation. |
| `sms_private.voice_otps` | Voice verification state; retain. |
| `sms_private.web_form_rate_buckets` | Public form rate-limit state; retain. |
| `sms_private.webhook_events` | SMS provider event deduplication; retain. |

| Additive canonical table | Purpose |
| --- | --- |
| `public.platform_account_identities` | Verified issuer/subject to stable account UUID mapping and deletion tombstones. |
| `public.platform_business_memberships` | Canonical account/business roles and explicit permissions. |
| `public.platform_staff_grants` | Global staff authority independent of business ownership. |
| `public.platform_audit` | Transactional staff changes with actor, target and previous/new values. |
| `public.platform_identity_events` | Signed account-event deduplication. |
| `public.platform_runtime` | Compatibility/canonical authorization switches. |

| E2-owned dashboard cache addition | Purpose |
| --- | --- |
| `public.dashboard_cache_versions` | Account/website/business revision counters for customer snapshot invalidation; no customer payloads. |
| `public.dashboard_refresh_limits` | Per-account last accepted manual refresh; server enforces the cross-tab/device refresh interval. |

The E2 cache migration beginning `20260930120000` is recorded live as
`20260930153439`. Both tables have RLS and no browser/SMS API/public-form grants
in the recorded E2 review. See [E2 cache](../../E2local-main/docs/dashboard-cache.md)
and [E2 inventory](../../E2local-main/docs/database-inventory.md). They do not
replace SMS message, intake or original submission tables.

The recorded review found RLS enabled on all reviewed public tables. Private operational tables without RLS remain unavailable to browser roles through schema/table grants; lack of RLS there does not imply public access. New platform tables have RLS and no browser grants. Existing SMS browser and Realtime policies use the patched authorization helpers.

The audit found no tenant orphans across 52 scoped tables. Automation intake `enrollment_id` fields lack a foreign key, and AI-run/handoff job references are not tenant-qualified. Reviewed cross-tenant mismatch counts were zero. These are follow-up integrity improvements, not changes made by this release.

The legacy Express `sms_business_accounts` registry is absent from the live catalog. Production uses the static CRM and Supabase Edge API; do not introduce that legacy registry or deploy the legacy Express server as a second identity authority.

See [staff CRM architecture and rollout](STAFF_CRM.md) for permissions, reviewed identity mappings, API workflows and actual deployment status. A separate guarded maintenance script archives and removes the three access tables only after successful cutover, pilot, dependency checks and an external verified backup. Still-used legacy identity/profile columns remain until their dependencies migrate; no cascading drops are used.

## Current schema additions

Source inventory reconciled October 13, 2026; this is not a new live catalog count.
The following later objects supplement the September snapshot. All listed private
objects belong to CRM; canonical account/service/cache objects belong to E2.

| Objects | Responsibility / owning guide |
| --- | --- |
| `public.platform_business_setup`, `public.platform_business_services` | E2 shared draft/review, revision and service visibility; [Business lifecycle](BUSINESS_LIFECYCLE.md) |
| `sms_private.form_sequences`, `form_sequence_versions`, `form_rule_presets`, `form_runs` | Published template versions, presets and durable runs; [Forms](FORM_AUTOMATIONS.md) |
| `sms_private.contact_sources`, `direct_templates`, `direct_versions`, `direct_operations` | Contact source history, reusable direct versions and operation idempotency; [Direct automations](DIRECT_CONTACT_AUTOMATIONS.md) |
| `sms_private.inbound_ai_settings`, `inbound_ai_sessions`, `inbound_ai_actions`, `inbound_ai_runs` | Settings, booking proposals and agent audit; [Inbound AI](INBOUND_AI.md) |
| `sms_private.activity_events`, `activity_responses`, `activity_bookings`, `activity_tags`, `activity_run_tags`, `activity_handoffs` | Explicit outcome attribution and reporting; [Activity](AUTOMATION_ACTIVITY.md) |
| `sms_private.twilio_connection_requests`, `twilio_sender_claims` | Provider reservation/reconciliation and exclusive number/Message Service binding; [Twilio](TWILIO_CONNECTIONS.md) |
| `sms_private.voice_agents`, `voice_configurations`, `voice_calls`, `voice_maintenance_settings` | Draft/published agents, retained calls and cleanup configuration; [Voice CRM](VOICE_CRM.md) |
| `voice_lookup_api`, `voice_booking_api`, `voice_runtime_api`, `voice_maintenance_api` | Restricted RPC schemas, not customer tables; separate scoped logins |
| Private Storage `voice-recordings`, `business-knowledge` | Object bytes require separate recovery from database metadata; [Recovery](RECOVERY.md) |

Later migrations also change existing objects and define customer Voice projections;
absence from this additions table does not imply a migration has no effect. Read
latest function replacements and the paired tests rather than using the earlier
SQL assembly files as the whole schema. Feature guides record dependencies and
source-to-remote aliases; neither repository alone is a fresh production baseline.

There is no implemented universal retention/deletion policy for every listed
record. Audio/full transcripts use the documented 90-day boundary; forms may be
recoverably archived. Other retention, erasure/export and backup policies require
service-owner decisions and scoped implementation, not ad hoc table deletion.
