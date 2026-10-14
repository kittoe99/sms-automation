// Historical assembly inputs predate current authorization/queue contracts.
// Keep this old command fail-closed for scripts that still attempt to use it.
throw new Error('Historical SQL assembly is retired. Create an owning forward migration with the Supabase CLI, review current SQL functions separately from one-time DDL/bootstrap, and run node scripts/check-current-sql.js. See docs/HARDENING_RELEASE.md.');
