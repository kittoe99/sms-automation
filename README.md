# Opek SMS and E2 staff CRM

`opek-sms` provides the staff CRM for business contacts, SMS conversations, bookings, AI-assisted follow-ups, email automations, website forms, and shared E2 accounts and websites.

The current application is a static browser frontend backed by **Supabase Postgres, authenticated Edge Functions, durable queues, and bounded workers** in WPacquisition. Clerk supplies the independent CRM login. Render hosts the static frontend. E2 Local supplies the customer dashboard and website hosting API in a separate repository.

Start with the [documentation index](docs/README.md). The [project record](PROJECT_RECORD.md) distinguishes checked-in implementation from previously recorded deployment status and outstanding verification.

## Quick start

Requires Node.js **20.9 or newer** and npm, as declared in [package.json](package.json).

```powershell
npm ci
npm run demo
```

Open `http://127.0.0.1:8081` for a read-only CRM with synthetic data and no provider credentials. Stop with Ctrl+C.

For the real frontend preview, create an ignored `.env` containing these public settings, supplying the project's publishable key. If `.env` already exists, edit it without replacing unrelated settings.

```dotenv
CRM_ENVIRONMENT=production
SUPABASE_PUBLISHABLE_KEY=sb_publishable_REPLACE_ME
```

The reviewed [production environment](config/environments/production.json)
supplies API, Supabase, hosting and embed destinations. Production is the default;
unknown environments and conflicting destination overrides fail the build.
See [configuration](docs/CONFIGURATION.md) before adding another environment.

```powershell
npm start
```

Open `http://127.0.0.1:8080`. This preview uses the configured **shared backend**; authenticated actions can change real records and queue messages. It needs a CRM account with appropriate grants and an allowed browser origin. It does not need database passwords, Twilio credentials, or Clerk secret keys locally. See [development](docs/DEVELOPMENT.md).

## Capabilities

- Business-scoped contacts, conversations, consent, delivery history, bookings and reporting.
- Published, versioned SMS template sequences attached to forms or directly to contacts, with consent checks, reply policies and per-run controls.
- Independently configured email schedules, consent, suppression and unsubscribe handling.
- Approved business knowledge, a separate off/shadow/live Inbound AI agent and staff handoffs; live activation requires the documented pilot gates.
- Twilio subaccount provisioning, registration, sender readiness and controlled activation.
- Contact, Quote Request and Booking form builders with stable embed IDs and optional E2 website attribution.
- Global staff Users, Businesses and Websites management with explicit permissions and separate customer/staff identities.
- A staff Voice Agents library, draft/publish workflow, private call history and explicitly released customer Voice views; the external phone worker is maintained separately.

## Read next

| Need | Guide |
| --- | --- |
| Use the CRM | [Staff user guide](docs/USER_GUIDE.md) |
| Understand runtime and data boundaries | [Architecture](docs/ARCHITECTURE.md) |
| Configure development or deployment | [Development](docs/DEVELOPMENT.md), [configuration](docs/CONFIGURATION.md) |
| Integrate with endpoints | [API reference](docs/API_REFERENCE.md) |
| Deploy, monitor or recover | [Operations](docs/OPERATIONS.md), [worker deployment](docs/WORKER_DEPLOYMENT.md) |
| Release the October 14 hardening | [Paired release checklist](docs/HARDENING_RELEASE.md) |
| Work on E2 integration | [Website integration](docs/WEBSITE_E2_INTEGRATION.md), [staff registry](docs/STAFF_CRM.md) |
| Work on the main E2 application | [E2 documentation](../E2local-main/docs/README.md), [E2 release guide](../E2local-main/docs/reliability-release.md) |
| Inspect recorded status | [Project record](PROJECT_RECORD.md) |

## Runtime boundaries

The former Express server, DigitalOcean deployment, API-key send examples and process-based workers are retained for historical or isolated migration work. See [legacy reference](docs/LEGACY.md); they are not the current production setup. The Express entrypoint rejects `NODE_ENV=production`.

This repository contains only part of the shared database history. E2 owns canonical account/registry, website-attribution, customer booking-read and dashboard-cache migrations. Follow migration ownership guidance before applying changes; do not replay either checkout's migration history over the shared database.

No secret keys, customer records or generated credential files belong in documentation or source control.

## Documentation status

The current reading paths were reconciled with local source on October 14, 2026.
The [hardening release](docs/HARDENING_RELEASE.md) records request/session isolation,
tab lifecycle, bounded hosting and ingestion, queue/reporting changes and the
paired migration/API order. These changes are locally implemented; their hosted
validation and deployment remain separate. Use `npm run check` and `npm test`
for offline CRM verification; `npm run verify:release` also checks the pinned
paired checkout and builds release artifacts without deploying them.
Start with [form follow-ups](docs/FORM_AUTOMATIONS.md),
[direct contact automations](docs/DIRECT_CONTACT_AUTOMATIONS.md), and
[Inbound AI](docs/INBOUND_AI.md) for current SMS behavior. Fixed-group SMS
generation is retired; the four-group email integration remains separate.
Deployment observations are dated evidence, not a fresh health check. The
[recovery runbook](docs/RECOVERY.md) identifies operational evidence still needed
before claiming a tested disaster-recovery capability.
