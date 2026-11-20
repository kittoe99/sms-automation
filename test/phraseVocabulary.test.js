import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {createCrmHandler} from '../supabase/functions/crm-api/handler.js';

const empty = {version:1, revision:0, categories:[]};
const category = {id:'00000000-0000-4000-8000-000000000001', name:'Customer Service', entries:[
  {id:'00000000-0000-4000-8000-000000000002', type:'phrase', text:'How can I help?', variations:['What can I do for you?']},
]};

test('vocabulary route uses the verified subject, accepts variants, and does not require a tenant', async () => {
  const calls = [];
  const handler = createCrmHandler({call:async (...args) => {calls.push(args); return empty;}}, async () => 'verified-user');
  const url = 'https://crm.example.test/crm-api/phrase-vocabulary';
  assert.equal((await handler(new Request(url))).status, 200);
  const put = categories => handler(new Request(url, {method:'PUT', body:JSON.stringify({...empty, categories, accountId:'spoofed'})}));
  assert.equal((await put([category])).status, 200);
  assert.equal((await put([{...category, entries:[{...category.entries[0], type:'instruction'}]}])).status, 400);
  assert.equal((await put([{...category, entries:[category.entries[0], category.entries[0]]}])).status, 400);
  assert.deepEqual(calls, [
    ['crm_phrase_vocabulary','verified-user',null,null],
    ['crm_phrase_vocabulary','verified-user',0,{categories:[{...category,entries:[{...category.entries[0],context:''}]}]}],
  ]);
});

test('private storage enforces staff access, account isolation, and revision checks', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role; create role sms_api;
      create schema sms_private; grant usage on schema sms_private to sms_api, authenticated;
      create table public.dashboard_accounts(id uuid primary key);
      insert into public.dashboard_accounts values
        ('00000000-0000-4000-8000-000000000001'), ('00000000-0000-4000-8000-000000000002');
      create function sms_private.require_admin(u text) returns void language plpgsql as $$
        begin if u not in ('one','two') then raise exception 'Staff required' using errcode='42501'; end if; end $$;
      create function sms_private.platform_actor(u text) returns uuid language sql as $$
        select ('00000000-0000-4000-8000-00000000000'||case u when 'one' then '1' else '2' end)::uuid $$;
    `);
    await db.exec(await readFile(new URL('../supabase/migrations/20261120043049_crm_phrase_vocabulary.sql', import.meta.url), 'utf8'));
    const read = async user => (await db.query('select sms_private.crm_phrase_vocabulary($1,null,null) as library', [user])).rows[0].library;
    const write = (revision, categories) => db.query('select sms_private.crm_phrase_vocabulary($1,$2,$3) as library',
      ['one', revision, JSON.stringify({categories})]);
    await db.exec('set role authenticated');
    await assert.rejects(read('one'), {code:'42501'});
    await db.exec('set role sms_api');
    await assert.rejects(db.query('select * from sms_private.crm_phrase_libraries'), {code:'42501'});
    await assert.rejects(read('non-staff'), {code:'42501'});
    assert.deepEqual(await read('one'), empty);
    await write(0, [category]);
    assert.deepEqual(await read('one'), {version:1, revision:1, categories:[category]});
    assert.deepEqual(await read('two'), empty);
    await assert.rejects(write(0, []), {code:'40001'});
    await write(1, []);
    await assert.rejects(write(1, [category]), {code:'40001'});
    assert.deepEqual(await read('one'), {version:1, revision:2, categories:[]});
  } finally {
    await db.close();
  }
});
