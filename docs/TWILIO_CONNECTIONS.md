# Connect approved Twilio senders

## Simplified activation

Open **SMS activation** from Setup, or **Finish SMS activation** in the business
connection card. The standard flow is **Choose approved sender → Test delivery →
Enable SMS**. An approved connected sender only needs a test mobile number; its
profile and registration are reused. Phone formatting spaces/dashes are accepted.
A charge confirmation precedes the test. Delivery must succeed before the explicit
Enable SMS action. An active business links straight to Forms.

Check status revalidates approval, sender attachment and the saved test receipt.
A delivered test stays ready across repeated refreshes, including recovery from
an older refresh that reset it to webhook_verified. The receipt must match the
current account, service, sender and test recipient. Pending/failed tests and lost
approval do not pass. Refresh never enables sending or sends another test.
The dashboard remains Sending disabled until the separate Enable SMS action succeeds.

Account references and troubleshooting are collapsed. **Need a new number or
registration?** opens the existing registration flow; required Twilio answers and
paid-action confirmations are preserved. Loading failures show a retry instead of
assuming an approved state. This is a frontend refinement: no migrations or API
permission changes, and the E2 owner summary remains read-only.

## Staff workflow

Open **Businesses**, select the registered business, and use **Twilio connection**
to jump to its connection card. Save a reviewed business profile first. Choose
**Choose approved sender**, select an active account, select its approved sender,
and review the CRM business, Twilio profile, phone number, account and Messaging
Service. Confirm the profile belongs to that business and connect it.

The server inventories the configured `TWILIO_MASTER_ACCOUNT_SID` and its active
child accounts using `TWILIO_MASTER_AUTH_TOKEN`. Credentials are never entered in
this browser form. A connected provider's account token is stored in Supabase
Vault and read only by scoped workers and signature verification functions.

Both verified toll-free senders and US A2P senders are supported. Toll-free
verification must be `TWILIO_APPROVED`. A2P needs a `VERIFIED` campaign, an
`APPROVED` non-mock brand and its approved business profile. A profile alone is
insufficient. Unavailable senders show the missing approval or attachment.
Twilio's per-number carrier registration can lag behind campaign approval; a
successful delivery canary is still required for activation.

## Connection and activation

Customers receive only the [read-only connection summary](SMS_CONNECTION_SUMMARY.md)
in E2 Local's SMS tab after service release. Existing SMS-read operators see the
same essentials on the CRM dashboard. Full setup and activation remain staff-only.

Connecting rechecks approval, account ownership and the owned SMS number. The
Messaging Service must have exactly one phone number, because sends use that
service's sender pool. The connection sets and verifies the existing CRM inbound
and status webhooks without changing voice configuration, moving a phone number,
buying resources or submitting another registration.

Each Twilio account is assigned to one CRM business. This includes the main
account when its existing approved sender is adopted. Other businesses use
separate child accounts; an assigned account cannot be selected for another
business. Replacing an already connected account requires a separately reviewed
transfer and is deliberately unavailable in this initial connection workflow.

Connecting stores
provider details, and leaves sending disabled. New SMS services start with draft
visibility; an existing service keeps its visibility. In **Configure SMS**,
request the separately confirmed activation
canary, check delivery, and then enable sending. **Set live** controls customer
dashboard visibility separately. Existing **Add SMS** continues to create a new,
isolated Twilio child account; use the connection card to reuse an approved one.

## Recovery and isolation

A private connection request reserves the account before webhook changes.
Concurrent connections, stale revisions and running provisioning/compliance
leases are rejected. A held, uncertain bootstrap is cancelled when an existing
sender is adopted; this does not delete any remote resources from the earlier
attempt. Investigate those separately rather than recreating them blindly.

If a webhook update or database completion fails, the business remains disabled
and the connection is marked for review. Refresh the inventory and retry the same
sender. After an interrupted request, wait two minutes before retrying. Selecting
a different sender during unresolved verification requires staff review. Repeated
successful connection requests do not replace credentials or enable sending.

The private request table has RLS enabled and no direct API/customer grants. All
connection RPCs require a verified CRM staff session. Audit and request metadata
contain provider references, never authentication tokens. The account uniqueness
constraint preserves existing signed-webhook routing by account.

## Paired release

CRM owns `20261003023928_connect_existing_twilio.sql`. Apply this forward migration
only after E2's `20261001235352_business_registration_services.sql` and
`20261002024330_canonical_crm_access_profiles.sql` and their CRM prerequisites.
Compare the actual shared history first; never push or replay either complete
repository migration history over the shared database.

Deploy `crm-api`, `provisioning-worker` and `compliance-worker`, then deploy the
CRM frontend. The E2 customer reader and cache triggers already derive the number
from the private provider and respect per-service visibility. No E2 application
change or additional E2 migration is required. Release evidence belongs in both
project records and must distinguish local tests, applied migration and live
connection/activation status.


### Activation verification troubleshooting

An activation test stopped with ACTIVATION_VERIFICATION_FAILED before any message
was created in compliance-worker v10. Version 11 fixes the Messaging Service
PhoneNumber response check to use `sid` (the create request uses `phoneNumberSid`).
After deployment, Check status verifies the sender again. The user may then submit
a new test; failed tests are not automatically replayed and activation still waits
for delivered status.
