# Current queue and reporting SQL

These files are maintained source for CRM-owned forward migrations. They are not
a database reset, a replacement for migration history, or commands to replay over
the shared database.

The initial local change is `20261014061007_queue_reporting_hardening.sql`, in this
order:

1. `queue-reporting-schema.sql`: one-time indexes, private tables and columns.
2. `queue-reporting.sql`: current replaceable queue/health functions and grants.
3. `queue-reporting-bootstrap.sql`: one-time trigger installation and acceptance
   backfill. The backfill derives first accepted contact times from existing SMS
   records, without changing delivery history or sending messages.
4. `activity-report.sql`: current reporting view and API function.

Run `node scripts/check-current-sql.js` to verify the checked-in migration matches
all four source files. This command does not query or change a database.

For subsequent work, create a new empty migration using `supabase migration new`.
Edit the maintained function module and copy only the changed function definitions
and necessary grants into the new forward migration. Put new one-time DDL in a
separate migration/module; never replay the schema or bootstrap modules. Update
the verifier's source-to-migration mapping for the changed module. Never regenerate
an applied migration to make a check pass.

Before release, reconcile the actual remote history with both project records.
These definitions require the existing CRM Voice setup and paired E2 canonical
access/cache baseline. E2's new hosting read indexes are independent. Apply only
the new CRM migration, then deploy `email-worker` with `handler.js`. No E2 customer
API or ownership contract changes. Stop dispatch while applying and inspect the
one-time acceptance backfill/index work against database size before scheduling
the release. Local PGlite regression tests do not measure production index build
time, lock contention, PGMQ, or pg_net delivery.
