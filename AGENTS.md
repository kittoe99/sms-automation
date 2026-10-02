# Paired E2 Local and CRM work

Treat this CRM and `../E2local-main` (package `e2-local`, repository
`kittoe99/E2local`) as a paired system. Before changing business registration,
ownership, profiles, service linking, customer visibility, authentication, or
shared database contracts, inspect the corresponding implementation and
`PROJECT_RECORD.md` in both repositories. Validate the combined migration order
and relevant tests in both projects. Keep migrations in their owning repository
and document cross-project prerequisites; never replay either history over the
shared database. Preserve unrelated local changes.

After material changes, update both project records and affected workflow docs.
Distinguish local implementation and tests from applied migrations and releases.
