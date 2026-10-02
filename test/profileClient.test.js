import test from 'node:test';
import assert from 'node:assert/strict';
import {readBusinessProfile,writeBusinessProfile} from '../public/profileClient.js';
import {canOpenWorkspace,canWriteWorkspace} from '../public/workspacePermissions.js';
test('profile writes carry the read revision and errors never become local successes',async()=>{
  const calls=[];
  const api=async(path,options)=>{calls.push([path,options]);return Response.json({revision:3,onboarding:{businessName:'Saved'}});};
  const saved=await readBusinessProfile(api);
  await writeBusinessProfile(api,{businessName:'Draft'},saved.revision,'draft');
  assert.deepEqual(JSON.parse(calls[1][1].body),{businessName:'Draft',revision:3,intent:'draft'});
  for(const status of [403,409,500,503])await assert.rejects(()=>writeBusinessProfile(async()=>Response.json({error:'Save rejected'},{status}),{businessName:'Keep me'},3),/Save rejected/);
  await assert.rejects(()=>writeBusinessProfile(async()=>{throw Error('Network failed');},{},3),/Network failed/);
  await assert.rejects(()=>readBusinessProfile(async()=>Response.json({error:'Read failed'},{status:503})),/Read failed/);
});
test('operator screens and writes match separate SMS and form capabilities',()=>{
  const sms={smsRead:true,formsManage:false},forms={smsRead:false,formsManage:true};
  for(const view of ['overview','messaging','contacts','bookings','automations','call'])assert.equal(canOpenWorkspace(view,false,sms),true);
  for(const view of ['platform-accounts','email','business-context','business-setup','booking-setup','ai-instructions'])assert.equal(canOpenWorkspace(view,false,sms),false);
  assert.equal(canOpenWorkspace('web-forms',false,forms),true);
  assert.equal(canOpenWorkspace('messaging',false,forms),false);
  assert.equal(canWriteWorkspace('/api/conversations/id/read','POST',false,sms),false);
  assert.equal(canWriteWorkspace('/api/web-forms/contacts','PUT',false,forms),true);
  assert.equal(canWriteWorkspace('/api/web-forms/contacts','PUT',false,sms),false);
  assert.equal(canWriteWorkspace('/api/twilio/provision','POST',true,sms),true);
});
