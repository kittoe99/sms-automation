import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.SUPABASE_URL;

const { getContact, getMessage, recordInbound, recordOutbound, updateDeliverability } = await import(
  '../src/lib/messageStore.js'
);

test('a retried inbound SID does not increment contact counters twice', async () => {
  const input = {
    from: '+17205550123',
    to: '+18777574365',
    body: 'Hello',
    sid: 'SM_test_duplicate_1',
  };
  await recordInbound(input);
  await recordInbound(input);

  const contact = await getContact(input.from);
  assert.equal(contact.messageCount, 1);
  assert.equal(contact.inboundCount, 1);
  assert.equal(contact.unreadCount, 1);
  assert.equal(contact.messages.length, 1);
});

test('an early status callback preserves status while the send fills message details', async () => {
  const sid = 'SM_test_early_status_1';
  const phone = '+17205550456';
  await updateDeliverability(sid, { status: 'delivered', to: phone });
  await recordOutbound({ sid, to: phone, body: 'Your quote is ready.' });

  const message = await getMessage(sid);
  const contact = await getContact(phone);
  assert.equal(message.deliverability, 'delivered');
  assert.equal(message.body, 'Your quote is ready.');
  assert.equal(contact.messageCount, 1);
});
