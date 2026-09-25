import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase, call } from './helpers/database.js';
import { createCrmHandler } from '../supabase/functions/crm-api/handler.js';
import { processAutomation } from '../src/workers/automation.js';

const aiConfig = {
  systemPrompt: 'Write a direct SMS about the exact quote request. Ask only for missing information.',
  businessContext: 'Alpha Painting serves Denver. Business hours are Monday through Friday, 9 AM to 5 PM.',
};

function request(tenant, method = 'GET', body) {
  return new Request('https://example.com/functions/v1/crm-api/automation-groups/quote-requests', {
    method,
    headers: { 'X-Tenant-ID': tenant, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

test('dashboard API stores manually authored outgoing AI fields per business and group', async () => {
  const db = await testDatabase();
  try {
    for (const tenant of ['alpha', 'beta']) {
      await call(db, 'api_action', 'admin', null, 'create_business', { id: tenant, name: tenant, timeZone: 'UTC' });
    }
    const handler = createCrmHandler({ call: (name, ...args) => call(db, name, ...args) }, async () => 'admin');
    const businessAiUrl = 'https://example.com/functions/v1/crm-api/business-ai';
    const businessSave = await handler(new Request(businessAiUrl, {
      method:'PUT', headers:{'X-Tenant-ID':'alpha','Content-Type':'application/json'},
      body:JSON.stringify({enabled:true,systemPrompt:'Ask unfamiliar texters what they need.'}),
    }));
    assert.equal(businessSave.status,200);
    const readBusinessAi = async tenant => (await handler(new Request(businessAiUrl,{
      headers:{'X-Tenant-ID':tenant},
    }))).json();
    assert.equal((await readBusinessAi('alpha')).enabled,true);
    assert.match((await readBusinessAi('alpha')).systemPrompt,/unfamiliar texters/);
    assert.equal((await readBusinessAi('beta')).enabled,false);
    const list = async (tenant) => {
      const response = await handler(new Request('https://example.com/functions/v1/crm-api/automation-groups', {
        headers: { 'X-Tenant-ID': tenant },
      }));
      assert.equal(response.status, 200);
      return (await response.json()).groups.find((group) => group.id === 'quote-requests');
    };
    const initial = await list('alpha');
    assert.equal(initial.automationAiConfigured, false);
    assert.equal(initial.systemPrompt, '');
    assert.equal(initial.businessContext, '');

    const incomplete = await handler(request('alpha', 'PUT', {
      rule: initial.rule, intent: initial.intent, activeAutomation: true,
    }));
    assert.equal(incomplete.status, 400);
    assert.match((await incomplete.json()).error, /AI instructions and business details/);

    const inactive = await handler(request('alpha', 'PUT', {
      rule: initial.rule, intent: initial.intent, activeAutomation: false,
    }));
    assert.equal(inactive.status, 200);
    assert.equal((await inactive.json()).group.automationAiConfigured, false);

    const saved = await handler(request('alpha', 'PUT', {
      rule: initial.rule, intent: initial.intent, activeAutomation: true, ...aiConfig,
    }));
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).group.automationAiConfigured, true);
    const alpha = await list('alpha');
    assert.equal(alpha.systemPrompt, aiConfig.systemPrompt);
    assert.equal(alpha.businessContext, aiConfig.businessContext);
    assert.equal(alpha.automationAiConfigured, true);
    const otherAlphaGroup = (await call(db, 'api_read', 'admin', 'alpha', 'groups', { id: 'sms-contact' })).rows[0];
    assert.equal(otherAlphaGroup.ai_configured, false);
    assert.equal(otherAlphaGroup.system_prompt, null);
    const beta = await list('beta');
    assert.equal(beta.automationAiConfigured, false);
    assert.equal(beta.systemPrompt, '');
    assert.equal(beta.businessContext, '');
  } finally { await db.close(); }
});

test('known inbound replies use the enrolled group context; business prompt stays separate', async () => {
  const db = await testDatabase();
  try {
    await call(db, 'api_action', 'admin', null, 'create_business', { id:'alpha', name:'Alpha', timeZone:'UTC' });
    const group = (await call(db, 'api_read', 'admin', 'alpha', 'groups', { id:'quote-requests' })).rows[0];
    await call(db, 'api_action', 'admin', 'alpha', 'group', {
      id:group.id, name:group.name, description:group.description, rule:group.rule,
      intent:group.intent, active:true, ...aiConfig,
    });
    await call(db, 'configure_ai', 'admin', 'alpha', 'quote-requests', true, 'Legacy instruction', true);
    await call(db, 'save_business_ai_settings', 'admin', 'alpha', {
      enabled:true, systemPrompt:'Ask unfamiliar texters what they need.',
    });
    const phone = '+13035550199';
    await call(db, 'api_action', 'admin', 'alpha', 'contact', {phone, name:'Alex'});
    await call(db, 'api_action', 'admin', 'alpha', 'consent', {phone, consent:true, evidence:'Test opt-in'});
    await call(db, 'create_intake', 'admin', 'alpha', 'quote_requests', {
      name:'Alex', phone, details:{service:'painting'}, sourceRecordId:'inbound-group-1',
    });
    await db.query("insert into public.sms_messages(tenant_id,contact_phone,direction,body,category_id,status,provider_accepted_at) values('alpha',$1,'outbound','Alpha here about your painting request.','quote-requests','accepted',now())",[phone]);
    await call(db, 'record_webhook', 'alpha', 'inbound', {From:phone, MessageSid:'SM_scoped_group', Body:'How long does it take?'});
    const job = await call(db, 'claim', 'ai_reply_jobs', 'ai');
    assert.equal(job.payload.group_id, 'quote-requests');
    const context = await call(db, 'job_context', job.id, job.lease_token);
    assert.equal(context.inboundAi.scope, 'group');
    assert.equal(context.inboundAi.systemPrompt, aiConfig.systemPrompt);
    assert.equal(context.inboundAi.businessContext, aiConfig.businessContext);
    assert.equal(context.profile, undefined);
    assert.equal(context.active_request?.phone, phone);
    await call(db, 'finish', job.id, job.lease_token, 'completed', null, 0);
  } finally { await db.close(); }
});

test('unconfigured groups hold sends, then draft from group context and cancel stale queued SMS', async () => {
  const db = await testDatabase();
  try {
    await call(db, 'api_action', 'admin', null, 'create_business', {
      id: 'alpha', name: 'Alpha Painting', timeZone: 'UTC',
    });
    const phone = '+13035550198';
    await call(db, 'api_action', 'admin', 'alpha', 'contact', { phone, name: 'Alex' });
    await call(db, 'api_action', 'admin', 'alpha', 'consent', {
      phone, consent: true, evidence: 'Test opt-in',
    });
    await call(db, 'create_intake', 'admin', 'alpha', 'quote_requests', {
      name: 'Alex', phone, details: { service: 'interior painting' }, sourceRecordId: 'quote-1',
    });
    await db.exec("update public.sms_businesses set status='active',sending_enabled=true where tenant_id='alpha'; update sms_private.runtime set scheduler_enabled=true");
    assert.equal(await call(db, 'tick'), 0);
    assert.equal((await db.query("select count(*) from sms_private.jobs where queue='automation_jobs'")).rows[0].count, 0);

    const group = (await call(db, 'api_read', 'admin', 'alpha', 'groups', { id: 'quote-requests' })).rows[0];
    await call(db, 'api_action', 'admin', 'alpha', 'group', {
      id: group.id, name: group.name, description: group.description,
      rule: { ...group.rule, startHour: 0, endHour: 24 },
      intent: group.intent, active: true, ...aiConfig,
    });
    assert.equal(await call(db, 'tick'), 1);
    const job = await call(db, 'claim', 'automation_jobs', 'automation');
    const context = await call(db, 'job_context', job.id, job.lease_token);
    assert.equal(context.profile, undefined);
    assert.deepEqual(Object.keys(context.business).sort(), ['name', 'time_zone']);
    assert.deepEqual(context.automationAi, aiConfig);

    const outbox = await processAutomation(job, { call: (name, ...args) => call(db, name, ...args) }, {
      apiKey: 'test',
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        assert.match(body.instructions, /exact quote request/);
        assert.match(body.input, /Alpha Painting serves Denver/);
        assert.match(body.input, /interior painting/);
        return Response.json({ status: 'completed', output: [{ type: 'message', content: [{
          type: 'output_text', text: JSON.stringify({ message: 'Alpha Painting here about your interior painting request. What rooms need painting?' }),
        }] }] });
      },
    });
    assert.ok(outbox.messageId);

    await call(db, 'api_action', 'admin', 'alpha', 'group', {
      id: group.id, name: group.name, description: group.description,
      rule: group.rule, intent: group.intent, active: false, systemPrompt: '', businessContext: '',
    });
    const sms = await call(db, 'claim', 'sms_send_jobs', 'sms');
    assert.equal(await call(db, 'begin_submission', sms.id, sms.lease_token), null);
    assert.equal((await db.query('select status,error_code from sms_private.jobs where id=$1', [sms.id])).rows[0].error_code, 'AI_CONFIG_REQUIRED');
    assert.equal((await db.query('select status from public.sms_messages where id=$1', [outbox.messageId])).rows[0].status, 'cancelled');
  } finally { await db.close(); }
});

