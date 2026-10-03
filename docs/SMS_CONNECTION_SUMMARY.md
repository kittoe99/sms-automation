# Read-only SMS connection summary

E2 customer owners see a released business's SMS connection in **Dashboard → SMS**.
The SMS app dashboard shows the same summary to staff and existing SMS-read
operators for their permitted workspace. Customer ownership does not grant CRM
access; forms-only access does not grant the summary.

The seven allowlisted fields are `businessName`, `profileName`, `phoneNumber`,
`senderType`, `connectionStatus`, `approvalStatus` and `messagingStatus`. Missing
profile/number/type values are null and display **Not available**. Credentials,
Twilio IDs, legal documents, rejection details and activation recipients are not
included. Approval and sending are independent: **Approved** can coexist with
**Sending disabled**. The display has no edit, connection or activation controls.
Staff retain their existing detailed setup and separately confirmed activation
workflow. Reading never queries Twilio, sends SMS or queues provider work.

`GET /api/sms/connection` requires a verified CRM identity and `X-Tenant-ID`;
`sms_private.read_sms_connection` enforces the canonical SMS-read guard. The
internal `sms_private.sms_connection_summary` projection has no direct browser
or API role execution grant. E2's service-role customer reader includes the same
object as `services[].smsConnection` only after existing owner/service-release
checks. Its account ID remains derived from the authenticated server session.

Connection states are `connected`, `in_progress`, `needs_attention` and
`not_available`. Approval states are `approved`, `in_progress`, `needs_attention`
and `not_available`; current registration state determines them, rather than
historical connection metadata. Messaging is `active` only for an active business
with sending enabled; a paused business/registration is `paused`, otherwise it is
`disabled`. Detailed registration GET and direct authenticated table reads are
staff-only. Existing messaging/form permissions remain unchanged.

Apply only CRM `20261003032940_sms_connection_summary.sql`, then E2
`20261003032943_customer_sms_connection_summary.sql`, after the established paired
registration/access release and CRM `20261003023928_connect_existing_twilio`.
Compare shared history and affected definitions first; never replay histories.
The E2 migration invalidates old dashboard snapshots and adds registration-change
cache invalidation. Provider changes already invalidate the cache. Older cached
services without `smsConnection` remain valid and display their original status
and number, with a details-unavailable message.

Deploy CRM API and both frontends. Record tests, applied migrations, API versions,
frontend source revisions and authenticated production evidence separately in
both project records. A UI rollback must not loosen the registration read policy
or replay an old database migration.
