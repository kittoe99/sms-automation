# Shared database table inventory

Reviewed September 29, 2026 against the live catalog, policies, function definitions and both repositories. These are the 69 application tables reviewed before the shared registry migration. Supabase internal schemas are excluded. The six additive platform tables below bring the current application total to 75.

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
| `sms_private.voice_booking_holds` | Voice capacity reservations; retain. |
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

All reviewed public tables have RLS enabled. Private operational tables without RLS remain unavailable to browser roles through schema/table grants; lack of RLS there does not imply public access. New platform tables have RLS and no browser grants. Existing SMS browser and Realtime policies use the patched authorization helpers.

The audit found no tenant orphans across 52 scoped tables. Automation intake `enrollment_id` fields lack a foreign key, and AI-run/handoff job references are not tenant-qualified. Reviewed cross-tenant mismatch counts were zero. These are follow-up integrity improvements, not changes made by this release.

The legacy Express `sms_business_accounts` registry is absent from the live catalog. Production uses the static CRM and Supabase Edge API; do not introduce that legacy registry or deploy the legacy Express server as a second identity authority.

See [staff CRM architecture and rollout](STAFF_CRM.md) for permissions, reviewed identity mappings, API workflows and actual deployment status. A separate guarded maintenance script archives and removes the three access tables only after successful cutover, pilot, dependency checks and an external verified backup. Still-used legacy identity/profile columns remain until their dependencies migrate; no cascading drops are used.
