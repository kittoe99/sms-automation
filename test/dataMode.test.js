import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyDataMiddleware } from '../src/lib/dataMode.js';
import { getSupabaseAdmin, isSupabaseConfigured } from '../src/lib/supabase.js';

test('disconnected mode returns empty records, preserves rule routes, and prevents database access', () => {
  const previous = process.env.CRM_DATA_MODE;
  process.env.CRM_DATA_MODE = 'empty';
  try {
    assert.equal(isSupabaseConfigured(), false);
    assert.throws(() => getSupabaseAdmin(), /Database disconnected/);
    for (const [path, key] of [['/messages', 'messages'], ['/directory', 'contacts'], ['/conversations', 'conversations'], ['/enrollments', 'enrollments'], ['/calls', 'calls']]) {
      let body;
      const res = { set() {}, json(value) { body = value; } };
      emptyDataMiddleware({ path, method: 'GET', query: {} }, res, () => assert.fail('Record handler reached'));
      assert.deepEqual(body[key], []);
      assert.equal(body.total, 0);
    }
    let status;
    const res = { status(value) { status = value; return this; }, json() {} };
    emptyDataMiddleware({ path: '/directory/message', method: 'POST' }, res, () => assert.fail('Send handler reached'));
    assert.equal(status, 503);
    let continued = false;
    emptyDataMiddleware({ path: '/automation-groups', method: 'POST' }, res, () => { continued = true; });
    assert.equal(continued, true);
  } finally {
    if (previous === undefined) delete process.env.CRM_DATA_MODE;
    else process.env.CRM_DATA_MODE = previous;
  }
});
