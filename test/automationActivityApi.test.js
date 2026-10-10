import test from 'node:test';
import assert from 'node:assert/strict';
import {createCrmHandler} from '../supabase/functions/crm-api/handler.js';
import {canOpenWorkspace,canWriteWorkspace} from '../public/workspacePermissions.js';
test('reporting and mutations derive actor and tenant from verified request context',async()=>{
 const calls=[],handler=createCrmHandler({call:async(...args)=>{calls.push(args);return {reportingAt:'now'};}},async()=> 'verified');
 for(const action of ['summary','enquiries','timeline','unlinked']){
 const res=await handler(new Request(`https://example.test/crm-api/automation-activity/${action}?runId=abc`,{headers:{'X-Tenant-ID':'selected'}}));assert.equal(res.status,200);assert.deepEqual(calls.at(-1),['automation_activity','verified','selected',action,{runId:'abc'}]);}
 const res=await handler(new Request('https://example.test/crm-api/automation-activity/booking_link',{method:'POST',headers:{'X-Tenant-ID':'selected'},body:JSON.stringify({tenant:'forged',user:'forged'})}));assert.equal(res.status,200);assert.deepEqual(calls.at(-1).slice(0,4),['automation_activity','verified','selected','booking_link']);
 assert.equal((await handler(new Request('https://example.test/crm-api/automation-activity/tag',{headers:{'X-Tenant-ID':'selected'}}))).status,405);
 assert.equal((await handler(new Request('https://example.test/crm-api/automation-activity'))).status,400);
});
test('SMS readers can open reporting; forms-only operators cannot mutate or read it',()=>{
 assert.equal(canOpenWorkspace('automation-activity',false,{smsRead:true}),true);assert.equal(canOpenWorkspace('automation-activity',false,{formsManage:true}),false);
 assert.equal(canWriteWorkspace('/api/automation-activity/tag','POST',false,{smsRead:true,formsManage:true}),false);
});
