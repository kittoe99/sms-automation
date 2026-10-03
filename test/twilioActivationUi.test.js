import test from 'node:test';import assert from 'node:assert/strict';
import {activationView,activationHtml,smsSetupActionsHtml} from '../public/twilioActivation.js';

test('staff dashboard exposes account selection and state-specific activation without granting readers controls',()=>{
 assert.equal(smsSetupActionsHtml({staff:false,summary:{activationStatus:'ready'}}),'');
 const ready=smsSetupActionsHtml({staff:true,summary:{messagingStatus:'disabled',activationStatus:'ready'}});
 assert.match(ready,/Approved Twilio accounts/);assert.match(ready,/Review and enable SMS/);assert.match(ready,/delivery test has passed/);
 assert.doesNotMatch(ready,/<details/);
 const pending=smsSetupActionsHtml({staff:true});assert.match(pending,/Continue SMS activation/);assert.doesNotMatch(pending,/delivery test has passed/);
 const active=smsSetupActionsHtml({staff:true,summary:{messagingStatus:'active',activationStatus:'active'}});assert.match(active,/View SMS activation/);assert.doesNotMatch(active,/One step remains/);
});

test('connected activation always provides access to approved accounts',()=>{
 for(const state of ['webhook_verified','canary_pending','ready','rejected']){
  const html=activationHtml({registration:{state}});
  assert.equal((html.match(/data-business/g)||[]).length,1);assert.match(html,/Approved Twilio accounts/);
 }
 assert.match(activationHtml({registration:{state:'ready'}}),/Awaiting activation/);
});
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
