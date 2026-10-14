# Shared CRM and E2 recovery runbook

This procedure covers the shared WPacquisition database and its CRM/E2 consumers.
It was documented October 13, 2026 from source and provider documentation. No
backup inventory, restore drill or production configuration change was performed
as part of that documentation work. A code rollback is not a data restore.

The October 14 local E2 hardening adds a specific website-operation recovery
hold. On `hosting_recovery_required`, use the E2
[hosting runbook](../../E2local-main/docs/web-hosting.md) to inspect the held token
and generation, stop the prior invocation, verify R2 publication/files, and
record reconciliation evidence before allowing a new operation. Expiry alone
does not establish that an external write stopped. The new owning migration and
release drain requirement are in the [paired release guide](HARDENING_RELEASE.md).

## Ownership and recovery objectives

At incident start, record a named incident lead, database operator, CRM release
operator and E2/hosting operator in the private incident record. One person may
cover several roles. The incident lead coordinates the recovery point, write
freeze, customer impact and reopening; database work must include both products.
Provider-account administrators handle Clerk, Twilio, Resend, LiveKit and hosting
issues through their existing account support channels. Keep account recovery
contacts and credentials in the team's restricted operations store, not Git.

The repository does not identify a staffed on-call rota, verified backup plan,
approved recovery point objective (RPO: acceptable data loss) or recovery time
objective (RTO: acceptable outage). Before production handover, the service owner
must record those values, backup retention, storage-copy cadence, incident contact
and last successful drill in the private operations inventory. Measure achieved
loss/time during a drill; do not present untested targets as guarantees.

## Backup inventory

| Asset | Evidence to retain outside the failed system |
| --- | --- |
| Shared database | Project reference, backup method, earliest/latest recoverable UTC timestamps, last verified backup and tested restore method; include CRM and E2 application/private schemas, roles/grants and migration history |
| Private Storage | Separate recoverable copies/manifests for `business-knowledge` and `voice-recordings`; object paths, sizes and retention/deletion policy |
| Website hosting | E2-owned R2 objects, deployment manifests, domain/routing configuration and recovery procedure from the E2 hosting operator |
| Secrets and access | Restricted recovery store for scoped login credentials, Vault-dependent provider secrets, Edge settings, Clerk applications/webhooks, worker/HMAC keys and provider-account recovery |
| Deployable source | CRM and E2 commit IDs, lockfiles, frontend/Edge build inputs, external voice-worker revision and migration source-to-remote mapping |
| External provider ledger | Access to accepted SMS/email/call/resource IDs and timestamps needed to reconcile sends or bookings after the restore point |

Supabase database backups exclude Storage object bytes. Daily-backup recovery
also requires resetting custom-role passwords. Inspect the actual project's
backup/PITR coverage rather than assuming a plan or retention period.
See [Supabase database backups](https://supabase.com/docs/guides/platform/backups).

Use encrypted, access-controlled backup storage outside the application project.
Verify a sample object's bytes, not just database metadata. Backups containing
customer information remain subject to the same access restrictions. Recovery
must not resurrect expired recordings or deleted identities into customer access.
The implemented 90-day audio/transcript retention does not define a retention
policy for every other table; the service owner must document those separately.

## Contain and preserve evidence

1. Record incident time in UTC and America/Denver, affected businesses/components,
   observed failures, current release IDs and the last known good state. Preserve
   current logs, job/attempt IDs and available data before replacing anything.
2. Choose the smallest recovery: compatible code rollback, corrected configuration,
   provider reconciliation or a database restore. Use [Operations](OPERATIONS.md)
   for ordinary retries and authentication recovery.
3. For database recovery, freeze writes from both CRM and E2, including public
   forms, business events, identity webhooks, external voice runtime/booking,
   hosting mutations and inbound provider callbacks. Plan how each sender will
   retry or how missed events will be reconciled; do not assume indefinite retries.
4. Pause SMS/automation/AI dispatch and scheduling, business sending, direct
   automation dispatch and the separate email dispatcher. Stop external voice
   writes and affected maintenance jobs for the restore window. Record previous
   settings so reopening does not accidentally enable a formerly disabled feature.
5. Wait for in-flight provider calls or classify their outcomes as uncertain.
   Preserve the ledger. A restore cannot recall an accepted message or cancel a
   real provider resource. Do not bulk-retry jobs after recovery.

Database controls include `sms_private.runtime.edge_enabled`,
`scheduler_enabled`, `direct_automations_enabled`, queue `edge_config` switches
and business sending. Inbound AI has per-business mode/revision controls; email
and Voice have separate controls. Use the owning feature guide and verified live
schema. These names are not a universal single-switch kill command.

## Restore first in isolation

1. Select and record a backup/recovery timestamp before corruption. Preserve a
   pre-recovery snapshot where possible. Reconcile both products' release and
   migration history at that timestamp; never reconstruct production by replaying
   either repository's partial history.
2. Prepare an isolated target with no production provider credentials, no public
   callback traffic and blocked outbound provider access. A restored database can
   contain enabled Cron jobs and production URLs: isolate execution before allowing
   it to run. Coordinate with the platform operator if the chosen restore method
   cannot guarantee that containment.
3. Use the supported Dashboard restore workflow or the current
   [Supabase CLI backup/restore procedure](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).
   Verify installed CLI commands with `--help`. Include required custom roles,
   grants, extension configuration and migration metadata; inspect export scope
   because a default schema dump is not proof that private application schemas,
   Vault-dependent credentials or migration history are recoverable.
4. Restore Storage/hosting bytes using their separate manifests. Check that paths
   referenced by retained records exist and that expired media remains denied.
   Reset/rebind scoped role credentials and runtime secrets through the private
   recovery store. Do not rerun first-install bootstrap over existing roles.
5. Validate with the checklist below, then decide whether production requires an
   in-place restore or an explicitly reviewed retargeting. The CRM frontend builder
   intentionally pins WPacquisition; a new project cannot simply be substituted
   without coordinated configuration/code review across both repositories.

## Recovery acceptance checks

- Confirm the target project and migration history match the chosen recovery
  point. Check later function replacements, both repositories' prerequisites,
  scoped roles, grants, RLS, extensions and callback/Cron configuration.
- Compare counts and sampled relationships for accounts, issuer identities,
  memberships, owners, service releases, forms/submissions, bookings, contacts,
  consent, jobs/attempts, Voice calls and hosting attribution. Counts alone do
  not establish correctness.
- Reapply verified post-restore-point opt-outs, identity deletion/suspension,
  ownership transfers and access revocations before reopening customer reads or
  sending. Preserve immutable attribution and owner-history cutoffs.
- Reconcile every in-flight/uncertain send with provider records. Mark accepted
  work through the supported reconciliation path; do not regenerate idempotency
  keys or resubmit merely because the restored queue appears ready. Reconcile
  bookings and provider resources created after the recovery point separately.
- Check signed-in staff reads, cross-business denials, customer owner/service
  gates, form-only access, expired media denial and short-lived recording access.
  Use isolated synthetic records for mutation tests. Test retained public form
  IDs and connection attribution with sending disabled.
- Run the affected CRM and paired E2 suites in [Development](DEVELOPMENT.md).
  These are source/contract checks, not a substitute for verifying the restored
  roles and data. Keep provider egress blocked during restore validation.
- Record actual data loss, elapsed recovery time, mismatches, unresolved provider
  outcomes and the decision to reopen or remain contained.

## Reopen and follow up

Deploy source compatible with the restored schema. Rebind APIs, auth origins,
webhooks, Storage and hosting only after access checks pass. Restore incoming
traffic and customer reads in controlled stages; then restore only previously
authorized dispatch/sending settings. Use an explicitly selected canary recipient
when delivery verification is needed, inspect callbacks, and monitor queue age
and errors before expanding traffic. Resume retention cleanup and confirm it
works. Do not enable live AI, new businesses or customer service releases as a
side effect of recovery.

The incident lead closes the incident only after both products are checked.
Update both project records with actual recovered releases/migrations, checks,
remaining discrepancies and a private incident reference. Keep customer payloads
and secrets out of Git. A failed drill stays an open operational issue; assign
an owner and repeat after the defect is fixed.

## Drill and handover checklist

Before accepting an operations handover, and after material backup/credential/
schema changes, perform the isolated procedure above. The handover evidence must
name the responsible people, recovery objectives, backup locations/access checks,
tested restore point, Storage verification, provider reconciliation results and
actual elapsed time. Those facts were not established by the documentation edit.
