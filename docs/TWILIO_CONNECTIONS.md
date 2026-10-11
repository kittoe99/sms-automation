# Connect Twilio business numbers

## Standalone account directory

Staff always have a dedicated Twilio area in the CRM navigation. Twilio accounts
lists active parent/subaccounts and every linked **CRM business**, with its assigned
phone number, without requiring a selected
business. View phone numbers loads toll-free and approved A2P options, with a
separate disclosure for senders needing attention. Pending connections are listed
separately as Connecting or Needs review. **Open CRM business** continues
to the existing connection/activation flow. Directory reads neither connect numbers
nor send messages. The direct route is ?view=platform-twilio. Customer and operator
permissions are unchanged; this inventory is staff-only.

## Simplified activation

Staff can start directly from the CRM Dashboard's SMS setup & activation card:
Twilio accounts opens the selected business's account dropdown and sender
inventory. Review and enable SMS opens activation with fresh status when the test
has passed. The activation page also always exposes Twilio accounts.
These shortcuts are staff-only; E2 owners and SMS-read operators keep read-only details.

Open **SMS activation** from Setup, or **Finish SMS activation** in the business
connection card. The standard flow is **Choose existing number → Complete SMS approval → Test delivery →
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

The shared read-only summary includes activationStatus, exposing only a stage label.
E2 displays Awaiting activation for a ready sender with sending disabled, with a
separate Messaging value. Its owner view has no activation controls. Older summaries
without the new field remain supported. Apply CRM 20261003213902 first, then E2
20261003213905 to invalidate previous customer snapshots; never replay either history.

Account references and troubleshooting are collapsed. **Need a new number or
registration?** opens the existing registration flow; required Twilio answers and
paid-action confirmations are preserved. Loading failures show a retry instead of
assuming an approved state. This is a frontend refinement: no migrations or API
permission changes, and the E2 owner summary remains read-only.

## Staff workflow

Open **Businesses**, select the registered business, and use **Twilio connection**
to jump to its connection card. Save a reviewed business profile first. Choose
**Choose existing number**, select an active account and an available number,
and review the CRM business, Twilio profile, phone number, account and Messaging
Service. Confirm the number and any registration belong to that business and connect it.

The server inventories the configured `TWILIO_MASTER_ACCOUNT_SID` and its active
child accounts using `TWILIO_MASTER_AUTH_TOKEN`. Credentials are never entered in
this browser form. A connected provider's account token is stored in Supabase
Vault and read only by scoped workers and signature verification functions.

Voice-capable toll-free numbers can connect before SMS verification, including
unsubmitted, pending and rejected registrations. Calling does not depend on
toll-free SMS approval. SMS still requires `TWILIO_APPROVED` and the existing
profile checks before its delivery test and activation. A2P needs a `VERIFIED` campaign, an
`APPROVED` non-mock brand and its approved business profile. A profile alone is
insufficient. Unavailable senders show the missing approval or attachment.
Twilio's per-number carrier registration can lag behind campaign approval; a
successful delivery canary is still required for activation.

## Connection and activation

Customers receive only the [read-only connection summary](SMS_CONNECTION_SUMMARY.md)
in E2 Local's SMS tab after service release. Existing SMS-read operators see the
same essentials on the CRM dashboard. Full setup and activation remain staff-only.

Connecting rechecks SMS approval, account ownership and number capabilities.
Pending toll-free connections additionally require live voice capability. The
Messaging Service must have exactly one phone number, because sends use that
service's sender pool. The connection sets and verifies the existing CRM inbound
and status webhooks without changing voice configuration, moving a phone number,
buying resources or submitting another registration.

An active Twilio account, including the main account, can serve multiple CRM
businesses. Each business keeps one exclusive phone number and its own
single-number Messaging Service. Shared accounts remain selectable; occupied
numbers/services identify the CRM business that owns or reserves them and cannot
be chosen by another business. CRM names come from the CRM business records,
independently of the Twilio business profile's name. Replacing an already
connected account or sender still requires a separately reviewed transfer.

Connecting stores
provider details, and leaves sending disabled. New SMS services start with draft
visibility; an existing service keeps its visibility. In **Configure SMS**,
request the separately confirmed activation
canary, check delivery, and then enable sending. **Set live** controls customer
dashboard visibility separately. Existing **Add SMS** continues to create a new,
isolated Twilio child account; use the connection card to reuse an existing number.

## Recovery and isolation

A private connection request reserves the number and Messaging Service before
webhook changes. A private ownership registry with unique resource keys protects
both reservations and provider writes, including worker checkpoints. Concurrent
claims on the same resource, stale revisions and running provisioning/compliance
leases are rejected. Different senders may share an account. A held, uncertain bootstrap is cancelled when an existing
sender is adopted; this does not delete any remote resources from the earlier
attempt. Investigate those separately rather than recreating them blindly.

If a webhook update or database completion fails, the business remains disabled
and the connection is marked for review. Refresh the inventory and retry the same
sender. After an interrupted request, wait two minutes before retrying. Selecting
a different sender during unresolved verification requires staff review. Repeated
successful connection requests do not replace credentials or enable sending.

The private request table has RLS enabled and no direct API/customer grants. All
connection RPCs require a verified CRM staff session. Audit and request metadata
contain provider references, never authentication tokens. Failed requests keep
their sender reserved until the same connection is retried or reviewed.

Inbound SMS and inbound calls resolve by account plus receiving number. Delivery
callbacks resolve by stored send attempt or message SID and check account,
sender, recipient and Messaging Service when supplied. Unknown, conflicting and
ambiguous routes are rejected. Signature verification covers the unchanged form
and full callback URL before any event is recorded. Soni retains its fixed
business/number restriction using the same number-aware resolver. Legacy
account-only credential lookup returns nothing for a shared account.

## Toll-free calling correction (implemented locally, not released)

CRM migration `20261011233216_toll_free_voice_before_sms_approval.sql` replaces
only the connection reservation/completion functions. Apply it after the shared
account migrations and before the updated CRM API. Old approved-only API calls
remain compatible. No E2 migration or history replay is needed. Release both
frontend label changes; the customer summary contract/cache fields are unchanged.

A connected number remains configured while its SMS registration is
`verification_pending`, `in_review` or `rejected`. Sending stays disabled, and
neither an SMS test nor activation is permitted before the existing gates pass.
**Check status** discovers the verification by number and refreshes SMS approval;
reconnecting the same resources neither transfers the sender nor enables SMS.
Failed attempts can retry with fresh registration metadata for the same resources.
Number/service ownership, admin review and revision checks remain enforced.

Existing voice routing is preserved. This change does not provision voice agents,
change number voice URLs, place calls, purchase numbers or submit registrations.
The signed voice regression routes calls while SMS is in review. Twilio documents
that [unverified toll-free restrictions exclude voice](https://help.twilio.com/hc/en-us/articles/20212966914075-Toll-Free-Verification-and-Developers-Navigating-the-New-Restrictions).

## Paired release

### Shared accounts (deployed and verified October 11)

The new migrations are CRM-owned. Existing E2 registration/access prerequisites
and the customer summary reader must already be applied. The production read-only
preflight found all four prerequisites and zero cross-business sender conflicts;
both new migrations have now been applied in the order below. Messaging webhook v21,
Soni voice v10, and CRM API v56 are ACTIVE. Frontend commit e0e86bf is LIVE in Render deployment
`dep-db5u7l67bikc73e36je0` at crm.e2local.com. The order below records the completed
rollout; do not reapply these migrations.

1. Apply only `20261011192551_twilio_number_webhook_routing.sql`.
2. Deploy and verify **both** `twilio-webhook` and `soni-voice-inbound`, including
   their shared handler dependencies, with the existing JWT and secret settings.
   Verify signed routing with synthetic local tests and live non-mutating health
   checks; do not send SMS or place calls as an implicit deployment test.
3. Apply only `20261011192649_shared_twilio_accounts.sql`. It locks the two source
   tables, rejects existing cross-business number/service conflicts, backfills
   private sender ownership, then removes account uniqueness. If preflight fails,
   investigate the conflicting ownership; never delete or reassign it automatically.
4. Deploy the updated `crm-api` and CRM frontend. E2 requires no migration or
   runtime release. Its owner reader and cache remain business-scoped.

Do not bulk-push either migration history. Do not restore account-only webhook
routing or account uniqueness after shared connections exist; stop new connection
writes and forward-fix while preserving number-aware routing.

Validation: focused CRM suites cover shared linking, reservations, callbacks,
signatures, STOP isolation, private grants and migration preflight/backfill.
`node scripts/test-twilio-concurrency.js` uses a disposable local PostgreSQL
cluster for concurrent reservation, provider-write and rollback checks. The
paired E2 business-service regression verifies both owners see only their own
number and summary. `node test/fixtures/shared-twilio-preview.js` serves synthetic
UI QA at localhost:8094; it performs no provider/database mutations.

### Original connection release prerequisites

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

Security advisor: no ERROR findings. The new private claim table intentionally has
RLS without policies and no direct grants. Existing unrelated notices include
[pg_net in public](https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public)
and [legacy executable definer functions](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable);
these were not changed by this release.
