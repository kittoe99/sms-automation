import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const sources = ['queue-reporting-schema.sql', 'queue-reporting.sql', 'queue-reporting-bootstrap.sql', 'activity-report.sql'];
const migration = new URL('../supabase/migrations/20261014061007_queue_reporting_hardening.sql', import.meta.url);
const header = '-- CRM-owned forward migration. Requires current paired E2 access/cache baseline.\n'
  + '-- Generated from the four queue/reporting modules in supabase/sql/current/.\n'
  + '-- Do not apply historical migrations or these source modules directly.\n';
const bodies = await Promise.all(sources.map(name => readFile(new URL(`../supabase/sql/current/${name}`, import.meta.url), 'utf8')));
const normalize = text => text.replaceAll('\r\n', '\n');
assert.equal(normalize(await readFile(migration, 'utf8')), normalize(header + bodies.join('\n')),
  'Current SQL sources and their forward migration differ. Create a new reviewed migration for released changes; never regenerate an applied migration.');
console.log('Current queue/reporting SQL matches its forward migration.');
