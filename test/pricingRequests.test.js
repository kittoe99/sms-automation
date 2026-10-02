import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase } from './helpers/database.js';

const input = (overrides = {}) => ({
  requestId: crypto.randomUUID(),
  name: 'Alex Customer',
  email: 'alex@example.com',
  phone: '+13035550123',
  serviceType: 'full-system',
  needs: ['customers', 'missed-calls'],
  otherNeed: null,
  smsConsent: true,
  consentEvidence: 'pricing-sms-v1',
  ipHash: 'a'.repeat(64),
  ...overrides,
});

async function submit(db, value) {
  const result = await db.query('select public.submit_pricing_request($1::jsonb) as value', [JSON.stringify(value)]);
  return result.rows[0].value;
}

test('pricing comes from the protected catalog and a live E2 tenant queues one transactional SMS', async () => {
  const db = await testDatabase();
  try {
    await db.exec(`
      insert into public.sms_businesses (tenant_id,name,time_zone,sending_enabled,status)
      values ('e2-local','E2 Local','America/Denver',true,'active');
    `);
    const request = input();
    const first = await submit(db, request);
    const second = await submit(db, request);
    assert.equal(first.smsStatus, 'queued');
    assert.deepEqual(second, first);
    assert.deepEqual(first.prices.map(price => [price.code, price.amountCents]), [
      ['full_system', 99700],
      ['individual_products', 29700],
    ]);
    const rows = await db.query('select pricing_snapshot,sms_status from public.pricing_requests where id=$1', [request.requestId]);
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].sms_status, 'queued');
    const messages = await db.query("select body,meta from public.sms_messages where tenant_id='e2-local'");
    assert.equal(messages.rows.length, 1);
    assert.match(messages.rows[0].body, /\$997\/month/);
    assert.match(messages.rows[0].body, /\$297\/month/);
    assert.equal(messages.rows[0].meta.purpose, 'transactional');
  } finally {
    await db.close();
  }
});

test('disabled sending still stores and returns authoritative pricing', async () => {
  const db = await testDatabase();
  try {
    await db.exec(`
      insert into public.sms_businesses (tenant_id,name,time_zone,sending_enabled,status)
      values ('e2-local','E2 Local','America/Denver',false,'pending');
    `);
    const result = await submit(db, input());
    assert.equal(result.smsStatus, 'unavailable');
    assert.equal(result.prices.length, 2);
    assert.equal((await db.query('select count(*)::int as count from public.pricing_requests')).rows[0].count, 1);
    assert.equal((await db.query("select count(*)::int as count from public.sms_messages where tenant_id='e2-local'")).rows[0].count, 0);
  } finally {
    await db.close();
  }
});

test('opt-outs block SMS while retaining the pricing request', async () => {
  const db = await testDatabase();
  try {
    await db.exec(`
      insert into public.sms_businesses (tenant_id,name,time_zone,sending_enabled,status)
      values ('e2-local','E2 Local','America/Denver',true,'active');
      insert into public.sms_contacts (tenant_id,phone,name,opted_out)
      values ('e2-local','+13035550123','Alex',true);
    `);
    const result = await submit(db, input());
    assert.equal(result.smsStatus, 'blocked');
    assert.equal((await db.query('select sms_status from public.pricing_requests')).rows[0].sms_status, 'blocked');
  } finally {
    await db.close();
  }
});

test('phone and IP limits prevent repeated sends', async () => {
  const db = await testDatabase();
  try {
    await db.exec(`
      insert into public.sms_businesses (tenant_id,name,time_zone,sending_enabled,status)
      values ('e2-local','E2 Local','America/Denver',true,'active');
    `);
    assert.equal((await submit(db, input())).smsStatus, 'queued');
    assert.equal((await submit(db, input({ requestId: crypto.randomUUID(), ipHash: 'b'.repeat(64) }))).smsStatus, 'rate_limited');
    for (let index = 0; index < 9; index++) {
      await submit(db, input({
        requestId: crypto.randomUUID(),
        phone: `+13035550${String(200 + index).padStart(3, '0')}`,
        ipHash: 'c'.repeat(64),
      }));
    }
    await submit(db, input({ requestId: crypto.randomUUID(), phone: '+13035550299', ipHash: 'c'.repeat(64) }));
    await assert.rejects(
      submit(db, input({ requestId: crypto.randomUUID(), phone: '+13035550300', ipHash: 'c'.repeat(64) })),
      /Too many pricing requests/,
    );
  } finally {
    await db.close();
  }
});

test('invalid enums, consent, and client-authored pricing are rejected or ignored', async () => {
  const db = await testDatabase();
  try {
    await assert.rejects(submit(db, input({ serviceType: 'tampered' })), /Valid service type/);
    await assert.rejects(submit(db, input({ smsConsent: false })), /SMS consent/);
    const result = await submit(db, input({ prices: [{ amountCents: 1 }], body: 'Free' }));
    assert.equal(result.prices[0].amountCents, 99700);
  } finally {
    await db.close();
  }
});

test('browser roles cannot read pricing records or execute the pricing RPC', async () => {
  const db = await testDatabase();
  try {
    await db.exec('set role anon');
    await assert.rejects(db.query('select * from public.pricing_catalog'), /permission denied/);
    await assert.rejects(
      db.query('select public.submit_pricing_request($1::jsonb)', [JSON.stringify(input())]),
      /permission denied/,
    );
    await db.exec('reset role');
  } finally {
    await db.close();
  }
});
