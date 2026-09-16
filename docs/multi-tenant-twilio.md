# Multi-business Twilio backend foundation

This implementation provisions one Twilio **subaccount** and one Messaging Service
per business, behind platform-administrator authorization. Registration is not
implemented, and multiple active CRM businesses are **not yet enabled**. The
existing database/provider isolation guard remains in place.

Twilio subaccounts isolate phone numbers, messages, and other provider resources,
but usage is billed to the parent account. They are not independent customer-owned
Twilio logins or billing accounts. See [Twilio's subaccount documentation](https://www.twilio.com/docs/iam/api/subaccounts).

## Prerequisites

1. Restore/replace the deployed application's public hostname. At inspection,
   `opek-sms-zllz4.ondigitalocean.app` did not resolve. New provisioning rejects a
   hostname that cannot resolve before creating provider resources.
2. Apply `supabase/migrations/20260916_sms_business_accounts.sql` to the platform's
   Supabase database. It adds only a private provisioning registry; it does not
   migrate or change existing messages, contacts, or CRM data.
3. Configure the following server-side secrets/settings:

   - `TENANT_REGISTRY_STORE=supabase`
   - `PLATFORM_ADMIN_USER_IDS`: comma-separated, explicit Clerk user IDs allowed to
     administer the platform. Being an organization's admin is not sufficient.
   - `TENANT_CREDENTIAL_ENCRYPTION_KEY`: a random 32-byte key encoded in base64.
   - `TWILIO_PARENT_ACCOUNT_SID` and `TWILIO_PARENT_AUTH_TOKEN`: credentials for the
     Twilio parent account that will own business subaccounts.
   - `PUBLIC_BASE_URL`: the deployed, publicly resolvable HTTPS application URL.
   - Existing Supabase and Clerk settings.
   - `DEFAULT_TENANT_CLERK_ORGANIZATION_ID` (or the slug) for the existing Opek
     business. Registry mode disables the legacy any-signed-in-user fallback, so
     new business users cannot inherit Opek access while their business is pending.
4. Create/identify a Clerk organization for each business manually. The later
   registration flow can automate that step.

Generate an encryption key privately, then save it in your secret manager:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Do not commit keys, credentials, or populated `.env` files. Back up the encryption
key; rotation requires re-encrypting stored secrets. Ciphertexts are authenticated
with AES-256-GCM and bound to both business ID and Twilio Account SID. The database
table has RLS enabled and grants access only to the server's service role.

## Administrator API

These routes require a verified Clerk session for an allowlisted platform admin.
The existing server-integration API key does **not** grant provisioning privileges.
There is no customer registration UI and no public account-creation endpoint.

Create a pending business with `POST /api/platform/businesses`:

```json
{
  "id": "acme",
  "name": "Acme Services",
  "shortName": "Acme",
  "timeZone": "America/Denver",
  "clerkOrganizationId": "org_actualClerkOrganizationId"
}
```

Business IDs and Clerk organization bindings are unique. Requests cannot inject
provider secrets or set `status=active`; new businesses always start pending.
The legacy default business ID is reserved to prevent accidental replacement.

List businesses with `GET /api/platform/businesses`. Responses use an explicit
public projection: ciphertext, auth tokens, API keys, and API secrets are omitted.

Provision resources with `POST /api/platform/businesses/acme/twilio/provision`.
**Calling this endpoint creates real Twilio resources under the parent account.**
It creates a subaccount using parent credentials, encrypts/checkpoints the
returned auth token, then creates the Messaging Service using the subaccount's
own credentials. Webhooks are configured as:

- `POST <PUBLIC_BASE_URL>/webhooks/twilio/inbound`
- `<PUBLIC_BASE_URL>/webhooks/twilio/status`
- `useInboundWebhookOnNumber=false` (the service owns inbound routing).

The returned `twilio.state=ready` means the subaccount and Messaging Service were
provisioned, **not** that SMS sending is ready. No phone numbers are bought, no
existing Opek resources are moved, and no messages/calls are sent by provisioning.
Each business still needs a sender in its own subaccount, sender-pool attachment,
applicable consent/compliance approval, and the app's data-isolation rollout.

## Retries and reconciliation

Database compare-and-set transitions prevent concurrent requests from creating
duplicate resources. Repeating a confirmed successful request returns the existing
business. If an account was checkpointed but service creation has not started,
retrying resumes at service creation without creating another subaccount.

A provider timeout or failed checkpoint may happen after a resource is created.
The registry records `subaccount_unknown` or `service_unknown`, and subsequent
provision calls are blocked rather than blindly creating duplicates. Inspect
Twilio Console to identify the resource, then use the admin-only, provider-read-only
reconciliation endpoint:

`POST /api/platform/businesses/acme/twilio/reconcile`

```json
{
  "accountSid": "AC00000000000000000000000000000000",
  "messagingServiceSid": "MG00000000000000000000000000000000"
}
```

Reconciliation verifies parent ownership, active account status, the exact business
friendly name (`Acme Services [acme]`), service ownership, and webhook settings.
For `subaccount_unknown`, omit the service SID only when no service was created;
the next provision call can safely start service creation. For `service_unknown`,
provide the existing service SID. No provider resources are created by reconciliation.

A process crash while in `subaccount_provisioning` or `service_provisioning` leaves
the attempt locked. An operator must first confirm the process is stopped, inspect
Twilio, and move that registry state to its corresponding `*_unknown` state before
using reconciliation. There is no automatic lock expiry that could cause duplicates.

## Existing runtime compatibility and remaining work

The default Opek business still uses `TWILIO_*` environment credentials and its
existing Messaging Service. New businesses never inherit Opek's credentials,
sender, or Clerk organization. Clients are cached by account/credential identity,
so switching businesses or rotating secrets cannot reuse the wrong client.

Inbound/status webhooks route by Twilio's `AccountSid` and validate signatures with
that business's auth token. Unknown or ambiguous Account SIDs are rejected; only
the legacy single-business mode permits webhooks without AccountSid. Signature
validation cannot be disabled when multiple businesses are active. Organization
membership remains checked on CRM routes. A default-business server API key cannot
authorize requests selected for another business.

Registry rows are refreshed into a server-only snapshot, but pending businesses
are not exposed as active workspaces. Do **not** flip capability flags or activate
multiple businesses yet. Before doing so, implement and verify:

- Database isolation for messages, contacts, bookings, enrollments, directory RPCs,
  automation workers, voice data, and uniqueness constraints.
- Tenant-isolated in-memory message/contact caches.
- Tenant-specific integration API keys and ElevenLabs credentials/agents/webhooks.
- Tenant context for background recovery, built-in automation runs, and voice sync.
- Sender/compliance onboarding and a controlled activation operation.
- The later registration, organization membership, invitation, and billing flows.

The data-isolation choice (shared database with tenant-scoped tables vs separate
Supabase projects) determines the next migration/runtime phase. This change does
not claim a complete multi-tenant security boundary.

## Verification

Run `node --test`. `test/twilioTenancy.test.js` covers credential encryption and
record binding, client isolation/rotation, pending state, Account SID routing,
safe provisioning/retries/concurrency, ambiguous-outcome reconciliation, platform
authorization, public response projection, and tenant integration-key boundaries.
Provider creation is mocked in tests; tests create no live Twilio resources.
