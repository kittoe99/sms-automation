# Twilio subaccounts for CRM businesses

Each CRM business receives a dedicated Twilio subaccount and Messaging Service.
The subaccount is owned by the platform's parent Twilio account, so its usage is
billed to the parent balance while phone numbers, messages, credentials, and
registration resources stay separated by business.

Twilio limits parent accounts to 1,000 subaccounts by default. The platform must
request a higher limit from Twilio before approaching that threshold. See
[Twilio's subaccount documentation](https://www.twilio.com/docs/iam/api/subaccounts).

## Automatic creation flow

1. An administrator creates a business in the CRM.
2. The database inserts a private provider row. An `AFTER INSERT` trigger queues
   one `twilio-bootstrap:v1` job in `provisioning_jobs`.
3. The provisioning Edge worker authenticates with the parent Account SID and
   Auth Token and creates a child account named `Business Name [tenant-id]`.
4. The returned child Auth Token is stored in Supabase Vault. It is never returned
   to the browser or written to logs.
5. The worker creates a Messaging Service in that child account and configures its
   inbound and delivery callbacks to the shared signed Twilio webhook function.
6. The business remains `pending` with sending disabled in the
   `awaiting_number` state.
7. A platform administrator selects and purchases a number in the child account,
   attaches it to the Messaging Service, and completes the applicable compliance
   registration. Sending is enabled only after those steps are verified.

The CRM dashboard shows the sanitized setup state. Account and Messaging Service
SIDs may be shown to an authenticated administrator; Auth Tokens and parent
credentials never leave the private worker/Vault boundary.

## Reliability rules

Remote Twilio mutations are checkpointed before and after the provider request.
If the worker crashes or times out while an account or Messaging Service may have
been created, the job moves to `submission_unknown`. It is not retried
automatically because a replay could create a second resource. An operator must
inspect the parent Twilio account and reconcile the exact child resource first.

The business creation transaction and its durable queue entry commit together.
The queue uses the business-scoped idempotency key `twilio-bootstrap:v1`, so
duplicate API requests or scheduler overlap do not create duplicate jobs.

## Phone numbers and campaign registration

Phone-number purchase is intentionally not part of automatic business creation
because it starts recurring charges and requires a geographic/type choice. The
number must be purchased in the child's account and attached to that child's
Messaging Service.

For US local numbers, each customer must have its own Secondary Customer Profile,
Brand, and Campaign under its subaccount. The platform follows Twilio's ISV A2P
10DLC flow. Registration needs the customer's legal and campaign information and
can incur fees, so submission remains an explicit administrator action. A
Campaign is associated with the business's saved Messaging Service; after approval,
Twilio registers numbers in that service's sender pool.

Toll-free numbers use toll-free verification rather than A2P 10DLC registration.
The setup flow must choose the sender type before collecting the appropriate form.

References:

- [Twilio ISV A2P 10DLC onboarding](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv-api)
- [Twilio A2P compliance embeddable](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/compliance-embeddable-onboarding)
- [Twilio phone-number provisioning](https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource)

## Required worker configuration

- `TWILIO_MASTER_ACCOUNT_SID`
- `TWILIO_MASTER_AUTH_TOKEN`
- `SUPABASE_URL`, or an explicit `TWILIO_WEBHOOK_BASE_URL`
- `PROVISIONING_WORKER_SECRET`
- `SMS_AUTOMATION_DATABASE_URL` using the scoped automation role

The master credential is used only by the provisioning worker. Regular messages
use the business subaccount credential from Vault through the SMS worker.
