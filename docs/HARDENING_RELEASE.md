# October 14 architecture hardening

This guide records local implementation from the project review on October 14,
2026. It is a release checklist, not evidence that migrations were applied or
services deployed. No live database, provider, sending, publication, DNS or
deployment changes were performed for this work. The two
[project](../PROJECT_RECORD.md) [records](../../E2local-main/PROJECT_RECORD.md)
own the exact verification and release evidence.

The subsequent main-application review is documented in
[E2 reliability and release](../../E2local-main/docs/reliability-release.md).
It adds dashboard query/cache/session protection, bounded public intake, contact
retry identity, static hosting builds, guarded hosting operations, security
headers and E2's full local release gate. Include these changes when releasing
the current paired checkout.

## Changes and boundaries

| Area | Implemented behavior | Verification still needed in the hosted system |
| --- | --- | --- |
| Browser request scope | Explicit business headers survive token retrieval; token/request identity is fenced across Clerk session changes. A session switch clears retained workspaces, requests and live subscriptions before fresh authorization. Server permissions remain authoritative. | Switch between two authorized accounts and businesses with a delayed request; verify the selected forms, drafts and live updates belong to the current account. |
| Tab lifecycle | Voice/Calls remount handlers from retained state and release media on departure. Each platform page owns its host and cancellable reads; navigation no longer waits for unrelated writes. Completed background writes leave a refresh hint. | Rapid navigation, editing, Voice playback and return to retained drafts in a real browser. |
| Request budgets | Platform reads have a 30-second deadline; that workspace's CRM writes 60 seconds; hosting writes and each four-worker upload batch 120 seconds. Batch failure cancels remaining uploads. | Large allowed folders, slow network and interrupted connections; confirm recovery without duplicate creation or publication. A browser timeout cannot undo an accepted server mutation. |
| Hosting reads | E2 directory reads are paginated metadata only. Site detail reads one site's deployment page and one bounded publication manifest; status remains correct when the live version is outside that page. | Staff-authenticated deployment paging, R2 timeout/unavailable state and a controlled upload/preview/restore workflow. |
| Public website ingestion | A shared HTTPS client validates addresses, pins the connection to an approved DNS result, revalidates redirects and caps response bodies. Enrichment and knowledge extraction use an overall 30-second deadline; knowledge saves are fenced after expiry. | Deployable Deno compatibility, TLS/SNI and redirect behavior with public test fixtures, including timeout and blocked destinations. Node mocks do not prove the hosted transport. |
| Queues and reporting | Bounded email lease recovery, rotating tenant admission, scheduler cursors, per-queue heartbeat records and indexed quiet-period reads reduce unbounded work. Email shares automation admission and claims at most five jobs in a 20-second claim budget. Activity reporting uses a maintained first-contact projection and narrows candidates before expensive work. | Real PostgreSQL query plans, concurrent scheduler/claim behavior, queue age and realistic multi-tenant load. Offline database tests are not a capacity measurement or a strict cross-provider fairness guarantee. |
| Build and source ownership | Reviewed environment destinations, reproducible static security headers, complete Edge import closure, current SQL source modules and a hashed paired baseline make release inputs explicit. | Hosted response headers and allowed Clerk, compliance/Persona, Realtime, private media, embeds and upload flows. |

The existing browser cache remains bounded and short-lived. It does not cache
tokens, bootstrap permissions, private detail records or arbitrary URLs. An
explicit request for a business other than the selected business bypasses that
business cache. Correcting a form picker does not relax server-side staff,
membership or same-business connection checks.

## Migration ownership and release order

Reconcile both project records with the destination's applied migration history
before applying any SQL. These are new forward migrations on the existing
paired access, automation, Voice and dashboard-cache baseline:

| Owner | New migration | Purpose |
| --- | --- | --- |
| CRM | `20261014061007_queue_reporting_hardening.sql` | Queue recovery/fairness, scheduler cursors, heartbeat normalization, reporting projection and indexes |
| E2 | `20261014061728_hosting_read_indexes.sql` | Stable site-directory and per-site deployment pagination indexes |
| E2 | `20261014065217_dashboard_scoped_reads.sql` | Authorized page keys before customer payloads, scoped service/cache readers and indexes |
| E2 | `20261014065602_contact_intake_limits.sql` | Contact request identity and atomic email/IP limits |
| E2 | `20261014071224_hosting_operation_fencing.sql` | Per-site operation exclusion, fenced lifecycle mutations and explicit interrupted-operation recovery |

1. Review both exact revisions and run the offline checks below. Confirm the
   existing shared baseline; never apply either repository's complete migration
   history to the shared database.
2. Apply only the intended missing forward migrations from their owning
   repositories. Review the CRM one-time projection backfill against actual
   table size and maintenance constraints before applying it. Before the E2
   hosting-operation migration, stop admission and drain all old hosting mutation
   invocations. Its guards reject old unfenced lifecycle writes. Deploy the new
   E2 API before reopening hosting changes. Contact intake also requires its new
   RPC migration before the updated API is enabled.
3. Release the E2 hosting API containing `GET /api/web-hosting/:siteId` and the
   paginated directory **before the new CRM frontend**. The CRM now depends on
   the detail endpoint and no longer scans the directory to open a website.
4. Deploy the affected CRM Edge functions from the complete dependency bundle
   with existing roles and secrets. Verify the shared public HTTPS transport in
   the deployed Deno runtime before relying on ingestion/enrichment changes.
5. Build and release the CRM frontend with the reviewed environment and matching
   generated static headers. Verify login, account/business switching, tab
   restore, website detail paging, media and embeds against the intended hosts.
6. Record deployed revisions, applied migration versions and actual hosted
   evidence in both project records. Keep sending, AI, service visibility and
   site publication governed by their separate controls.

The hosting indexes do not change authentication. Site detail and directory
routes retain CRM staff verification. The older October 10 upload-validation
fix could release independently; that does not remove the new detail-endpoint
dependency.

Hosting build/publish/unpublish/delete operations now serialize per website;
other websites remain independent. A `hosting_recovery_required` response means
the storage outcome is uncertain, and expiry does not permit an automatic retry.
Follow the E2 [hosting recovery procedure](../../E2local-main/docs/web-hosting.md)
to stop the old invocation, verify the publication pointer and files, and reconcile
the exact operation token/generation. A rollback to the old hosting application
cannot bypass the new database guards safely.

## SQL source and bootstrap policy

`supabase/sql/current/` contains reviewed source for this migration:

- `queue-reporting.sql` and `activity-report.sql` hold maintained function/view
  definitions.
- `queue-reporting-schema.sql` holds schema and index additions.
- `queue-reporting-bootstrap.sql` installs projection triggers and performs the
  one-time first-contact backfill.

`node scripts/check-current-sql.js` checks that the reviewed modules match the
new migration. It does not apply SQL. The schema/bootstrap files are migration
inputs, not routine scripts to replay. Once applied, a migration is immutable;
future changes need a new owning forward migration and a reviewed update to
the source/check relationship. The old `npm run db:assemble` command refuses to
run because its historical inputs omit later contracts. Do not use it to
reconstruct the current database.

## Offline release verification

Install each repository's locked dependencies. With E2 at the reviewed paired
revision in `../E2local-main` (or `E2_PROJECT_ROOT`), run from the CRM root:

```powershell
npm ci
npm run verify:release
```

The frontend build needs a public `SUPABASE_PUBLISHABLE_KEY`. For an offline CI
build, a clearly synthetic `sb_publishable_` fixture is sufficient; it must not
be deployed as a working key. `verify:release` runs source/header/current-SQL
checks, CRM tests, paired baseline/tests, the static build and secret-free Edge
packaging. It does not apply migrations, invoke workers, contact providers or
deploy the generated artifacts.

`npm run test:paired` first compares the checked-in
`config/paired-baseline.json` against all CRM/E2 migration hashes and selected
E2 hosting implementation/lockfile hashes, then runs the selected E2 contract
tests. The recorded CRM-then-E2 fixture order belongs to disposable tests and
is not production migration replay order. After intentional contract changes,
review both diffs, run the relevant paired tests and explicitly run
`npm run baseline:record`; never re-record an unexplained mismatch merely to
make CI pass. Commit the baseline with the reviewed source changes.

Pushes and pull requests run CRM source checks, an offline frontend build and
Edge packaging. The complete CRM suite requires the private E2 migration fixtures;
it runs in E2's paired workflow alongside E2's full release gate. This avoids
granting a public-repository workflow access to private source. The optional
manual CRM paired-release workflow also runs the full CRM suite and requires an exact
40-character E2 commit SHA. For a private E2 repository, configure
`PAIRED_REPO_TOKEN` with read-only access to that repository; it is a CI secret,
not browser or runtime configuration. Neither workflow deploys the application.

`node scripts/prepare-edge-deployment.js --bundle-only` creates the ignored
`data/edge-bundle.json` without reading secrets or producing Vault SQL. Its
dependency walk includes relative imports under `supabase/functions/` and
`src/`, plus the shared `public/phoneNormalization.js`, and fails for missing or
unexpected imports. Ordinary packaging with secrets remains an operator action.

## Evidence required before closing the release

Keep these checks separate from passing source tests:

- Run Deno entrypoint checks and a hosted public-HTTPS transport smoke. Deno was
  unavailable during the local security implementation.
- Use a real PostgreSQL environment with representative tenant/message/job
  volumes to inspect query plans, lock contention, fairness and queue progress.
  Check the one-time backfill duration separately from steady-state reporting.
- Verify actual static response headers and CSP with CRM Clerk, compliance and
  Persona, Realtime, Voice playback, uploads, public embeds and unsubscribe.
- Exercise the paired E2/CRM hosting contract and session/lifecycle behavior in
  an authenticated browser. Offline tests cover adversarial timing, but do not
  constitute a browser integration or production load test.
- Preserve backup and restore evidence required by [recovery](RECOVERY.md).
  A local migration fixture is not a tested disaster-recovery procedure.

If a deployed write times out, inspect the authoritative record before
retrying. Keep stable idempotency keys where supported; do not assume an abort
rolled back server work. Use the owning feature's rollback controls and retain
durable provider ledgers. Reverting a frontend does not roll back SQL or a
provider submission.
