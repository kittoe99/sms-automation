import test from 'node:test';import assert from 'node:assert/strict';
import {activationView,activationHtml} from '../public/twilioActivation.js';
test('activation actions follow verified delivery state and never assume missing approval',()=>{
 for(const state of ['draft','in_review','rejected','submission_unknown',undefined]){const v=activationView({}, {state});assert.equal(v.test,false);assert.equal(v.enable,false);assert.equal(v.approved,false);}
 assert.equal(activationView({}, {state:'webhook_verified'}).test,true);
 assert.equal(activationView({}, {state:'canary_pending'}).pending,true);
 assert.equal(activationView({}, {state:'ready'}).enable,true);
 const active=activationView({sendingEnabled:true},{state:'ready'});assert.equal(active.active,true);assert.equal(active.test,false);assert.equal(active.enable,false);
});
test('approved sender activation asks only for a test recipient and hides technical references',()=>{
 const html=activationHtml({provider:{phoneNumber:'+18775550123',connectionDetails:{profileName:'Example <LLC>',accountSid:'AC-reference',senderType:'toll_free'}},registration:{state:'webhook_verified'},businessName:'Example'});
 assert.equal((html.match(/<input /g)||[]).length,1);assert.match(html,/name="phone"/);assert.doesNotMatch(html,/textarea|campaignDescription|notificationEmail|data-enable/);
 assert.match(html,/Example &lt;LLC&gt;/);assert.ok(html.indexOf('AC-reference')>html.indexOf('<details'));
});
test('pending and active states cannot send another test; delivered state exposes explicit activation',()=>{
 for(const state of ['canary_pending','ready'])assert.doesNotMatch(activationHtml({registration:{state}}),/data-test/);
 assert.match(activationHtml({registration:{state:'ready'}}),/data-enable/);
 const html=activationHtml({provider:{sendingEnabled:true},registration:{state:'ready'}});assert.match(html,/data-forms/);assert.doesNotMatch(html,/data-enable|data-test|data-refresh/);
});
