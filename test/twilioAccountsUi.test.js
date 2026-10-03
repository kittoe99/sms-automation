import test from 'node:test';
import assert from 'node:assert/strict';
import {twilioAccountsHtml,twilioSendersHtml} from '../public/twilioAccounts.js';
import {canOpenWorkspace} from '../public/workspacePermissions.js';

test('standalone Twilio directory is staff-only and does not require a tenant',()=>{
 assert.equal(canOpenWorkspace('platform-twilio',true,null),true);
 for(const tenant of [null,{smsRead:true},{formsManage:true}])assert.equal(canOpenWorkspace('platform-twilio',false,tenant),false);
 const html=twilioAccountsHtml({accounts:[{sid:'AC-demo',name:'<Account>',isParent:true},{sid:'AC-linked',name:'Linked',assignedBusiness:{tenantId:'tenant',businessName:'Example'}}]});
 assert.match(html,/Not linked to a business/);assert.match(html,/Linked to Example/);assert.match(html,/Open linked business/);assert.match(html,/&lt;Account&gt;/);
 assert.doesNotMatch(html,/<form|data-enable|authToken/);
 assert.match(twilioAccountsHtml({accounts:[],truncated:true}),/No active Twilio accounts/);
});
test('standalone inventory renders approval, empty and attention states without secrets',()=>{
 const html=twilioSendersHtml({options:[{profileName:'Example',phoneNumber:'+18775550123',approvalStatus:'Toll-free verified',senderType:'toll_free',serviceName:'Service',authToken:'secret-should-not-render'}],unavailable:[{name:'<Old>',reason:'Registration pending'}],truncated:true});
 assert.match(html,/Toll-free verified/);assert.match(html,/Registration pending/);assert.match(html,/&lt;Old&gt;/);assert.match(html,/inventory limit/);
 assert.doesNotMatch(html,/secret-should-not-render|<form|<input/);
 assert.match(twilioSendersHtml({options:[],unavailable:[]}),/No approved senders/);
});
