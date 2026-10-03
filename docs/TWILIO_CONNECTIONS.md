# Connect approved Twilio senders

## Staff workflow

Open **Businesses**, select the registered business, and use **Twilio connection**
to jump to its connection card. Save a reviewed business profile first. Choose
**Choose approved profile**, select an active account, select its approved sender,
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

Connecting initializes the established SMS forms and automation groups, stores
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
