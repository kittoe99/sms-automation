import 'dotenv/config';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error('Set MIGRATION_DATABASE_URL');
if (!url.includes('wxamwhfmelxqahkdtcci') && process.env.ALLOW_LOCAL_DATABASE !== 'true') {
  throw new Error('Database must target WPacquisition');
}
const db = postgres(url, { ssl: process.env.ALLOW_LOCAL_DATABASE === 'true' ? false : 'require', prepare: false, max: 1 });
try {
  const login = 'sms_form_public_login';
  const exists = await db`select 1 from pg_roles where rolname=${login}`;
  if (exists.length) throw new Error(`${login} already exists; rotate its existing credential explicitly`);
  const password = randomBytes(32).toString('hex');
  await db.unsafe(`create role ${login} login password '${password}' in role sms_form_public`);
  const parsed = new URL(url);
  const suffix = parsed.username.includes('.') ? '.wxamwhfmelxqahkdtcci' : '';
  parsed.username = login + suffix;
  parsed.password = password;
  await mkdir('data', { recursive: true });
  await writeFile('data/web-form-credentials.env', `WEB_FORM_DATABASE_URL=${parsed.href}\n`, { flag: 'wx', mode: 0o600 });
  console.log('Created the scoped public form database login. Credential saved in ignored data/web-form-credentials.env.');
} finally { await db.end(); }
