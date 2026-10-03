import test from 'node:test';
import assert from 'node:assert/strict';
import {processCompliance} from '../src/workers/compliance.js';

const account='AC'+'1'.repeat(32),service='MG'+'2'.repeat(32),phoneSid='PN'+'3'.repeat(32);
test('refresh keeps delivered tests ready, recovers regressed tests and never enables sending',async()=>{
 for(const senderType of ['toll_free','local_a2p'])for(const initial of ['canary_pending','ready','webhook_verified']){
  const result=await refreshTest({senderType,initial});
  assert.equal(result.checkpoint.registrationState,'ready');
  assert.deepEqual(result.calls.map(x=>x[0]),['compliance_job_context','compliance_checkpoint','finish']);
  assert.equal(result.messageReads,1);
 }
});

test('refresh validates current approval, sender and test identity before accepting delivery',async()=>{
 for(const patch of [{accountSid:'AC'+'9'.repeat(32)},{from:'+13035550999'},{to:'+13035550999'},{messagingServiceSid:'MG'+'9'.repeat(32)},{sid:'SM'+'9'.repeat(32)}]){
  assert.equal((await refreshTest({messagePatch:patch})).checkpoint.registrationState,'webhook_verified');
 }
 for(const approval of ['REJECTED','IN_REVIEW']){
  const result=await refreshTest({approval});
  assert.equal(result.checkpoint.registrationState,approval==='REJECTED'?'rejected':'in_review');
  assert.equal(result.messageReads,0);
 }
 const detached=await refreshTest({attached:false});
 assert.equal(detached.checkpoint.registrationState,'approved');assert.equal(detached.messageReads,0);
 const absent=await refreshTest({hasTest:false});
 assert.equal(absent.checkpoint.registrationState,'webhook_verified');assert.equal(absent.messageReads,0);
});

test('refresh distinguishes pending, failed and unknown test delivery',async()=>{
 for(const status of ['accepted','queued','sending','sent','failed','undelivered','canceled','unknown']){
  const result=await refreshTest({messagePatch:{status,errorCode:status==='undelivered'?30007:null,errorMessage:status==='undelivered'?'Filtered':null}});
  assert.equal(result.checkpoint.registrationState,['accepted','queued','sending','sent'].includes(status)?'canary_pending':'webhook_verified');
  if(status==='undelivered'){assert.equal(result.checkpoint.rejectionCode,'30007');assert.equal(result.checkpoint.rejectionReason,'Filtered');}
 }
});

async function refreshTest({senderType='toll_free',initial='ready',approval='APPROVED',attached=true,hasTest=true,messagePatch={}}={}){
 const calls=[],messageSid='SM'+'5'.repeat(32),registrationSid='HH'+'4'.repeat(32);let messageReads=0;
 const ctx={operation:{state:'pending',operation:'refresh_status',request:{}},registration:{sender_type:senderType,state:initial,verification_sid:registrationSid,campaign_sid:registrationSid,canary_message_sid:hasTest?messageSid:null,canary_phone:'+13035550123'},provider:{account_sid:account,auth_token:'secret',messaging_service_sid:service,phone_number_sid:phoneSid,from_number:'+18775550123'}};
 const db={call:async(name,...args)=>{calls.push([name,...args]);if(name==='compliance_job_context')return ctx;}};
 const numbers=()=>({fetch:async()=>({accountSid:account})});
 const services=()=>({fetch:async()=>({inboundRequestUrl:'https://example.test/inbound',statusCallback:'https://example.test/status'}),phoneNumbers:{list:async()=>attached?[{sid:phoneSid}]:[]}});
 const messages=()=>({fetch:async()=>{messageReads++;return {sid:messageSid,accountSid:account,from:ctx.provider.from_number,to:ctx.registration.canary_phone,messagingServiceSid:service,status:'delivered',...messagePatch};}});
 await processCompliance({id:'job',lease_token:'lease'},db,{clientFactory:()=>({incomingPhoneNumbers:numbers,messaging:{v1:{services}},messages}),fetchImpl:async()=>new Response(JSON.stringify({sid:registrationSid,status:approval}))});
 return {calls,messageReads,checkpoint:calls.find(x=>x[0]==='compliance_checkpoint')[4]};
}

function context(state='pending'){return {operation:{state,operation:'purchase_number',request:{selection:{phoneNumber:'+17205550123'}}},registration:{sender_type:'toll_free',state:'number_pending'},provider:{account_sid:account,auth_token:'secret',messaging_service_sid:service}};}
function client({purchaseError}={}){
 const numbers=()=>({fetch:async()=>({accountSid:account})});numbers.create=async()=>{if(purchaseError)throw purchaseError;return {sid:phoneSid,accountSid:account,phoneNumber:'+17205550123'};};
 const services=()=>({phoneNumbers:{create:async({phoneNumberSid})=>({sid:phoneNumberSid})}});
 return {incomingPhoneNumbers:numbers,messaging:{v1:{services}},messages:{create:async()=>{}}};
}

test('number purchase checkpoints before and after the paid provider mutation and attaches the sender',async()=>{
 const calls=[];const db={call:async(name,...args)=>{calls.push([name,...args]);if(name==='compliance_job_context')return context();}};
 await processCompliance({id:'job',lease_token:'lease'},db,{clientFactory:()=>client()});
 const checkpoints=calls.filter(x=>x[0]==='compliance_checkpoint').map(x=>x[3]);assert.deepEqual(checkpoints,['submitting','completed']);
 const completed=calls.find(x=>x[0]==='compliance_checkpoint'&&x[3]==='completed')[4];assert.equal(completed.phoneNumberSid,phoneSid);assert.equal(completed.messagingServiceSid,service);
 assert.deepEqual(calls.at(-1).slice(0,5),['finish','job','lease','completed',null]);
});

test('ambiguous Twilio purchase is never replayed automatically',async()=>{
 const calls=[];const db={call:async(name,...args)=>{calls.push([name,...args]);if(name==='compliance_job_context')return context();}};
 await processCompliance({id:'job',lease_token:'lease'},db,{clientFactory:()=>client({purchaseError:Object.assign(new Error('timeout'),{code:'ETIMEDOUT'})})});
 assert.equal(calls.filter(x=>x[0]==='compliance_checkpoint').at(-1)[3],'submission_unknown');assert.equal(calls.at(-1)[3],'submission_unknown');
});

test('toll-free polling discovers and persists a verification SID before approval',async()=>{
 const calls=[],ctx={operation:{state:'pending',operation:'refresh_status',request:{}},registration:{sender_type:'toll_free',state:'verification_pending',verification_sid:null},provider:{account_sid:account,auth_token:'secret',messaging_service_sid:service,phone_number_sid:phoneSid}};
 const db={call:async(name,...args)=>{calls.push([name,...args]);if(name==='compliance_job_context')return ctx;}};
 let requested;await processCompliance({id:'job',lease_token:'lease'},db,{clientFactory:()=>client(),fetchImpl:async url=>{requested=String(url);return new Response(JSON.stringify({verifications:[{sid:'VT'+'4'.repeat(32),status:'IN_REVIEW'}]}),{status:200});}});
 assert.match(requested,/Tollfree\/Verifications\?TollfreePhoneNumberSid=PN/);
 const checkpoint=calls.find(x=>x[0]==='compliance_checkpoint');assert.equal(checkpoint[3],'completed');assert.equal(checkpoint[4].verificationSid,'VT'+'4'.repeat(32));assert.equal(checkpoint[4].registrationState,'in_review');
});

test('uncertain number reconciliation is read-only and adopts only an owned attached sender',async()=>{
 const uncertainId='00000000-0000-4000-8000-000000000001',calls=[],ctx={operation:{state:'pending',operation:'refresh_status',request:{reconcile:true}},uncertain_operation:{id:uncertainId,state:'submission_unknown',operation:'purchase_number',request:{selection:{phoneNumber:'+17205550123'}}},registration:{sender_type:'local_a2p',state:'submission_unknown'},provider:{account_sid:account,auth_token:'secret',messaging_service_sid:service}};
 const db={call:async(name,...args)=>{calls.push([name,...args]);if(name==='compliance_job_context')return ctx;}};
 const numbers=()=>({});numbers.list=async()=>[{sid:phoneSid,accountSid:account,phoneNumber:'+17205550123'}];
 const services=()=>({phoneNumbers:{list:async()=>[{sid:phoneSid}]}});
 await processCompliance({id:'job',lease_token:'lease'},db,{clientFactory:()=>({incomingPhoneNumbers:numbers,messaging:{v1:{services}}})});
 const checkpoint=calls.find(x=>x[0]==='compliance_checkpoint');assert.equal(checkpoint[4].registrationState,'in_review');assert.equal(checkpoint[4].phoneNumberSid,phoneSid);assert.equal(checkpoint[4].reconciledOperationId,uncertainId);
 assert.equal(calls.some(x=>x[0]==='compliance_checkpoint'&&x[3]==='submitting'),false);
});

test('status refresh recognizes approved toll-free records and the A2P compliance list envelope',async()=>{
 for(const senderType of ['toll_free','local_a2p']){
  const calls=[],registrationSid=(senderType==='toll_free'?'HH':'QE')+'4'.repeat(32);
  const ctx={operation:{state:'pending',operation:'refresh_status',request:{}},registration:{sender_type:senderType,state:'webhook_verified',verification_sid:senderType==='toll_free'?registrationSid:null,campaign_sid:senderType==='local_a2p'?registrationSid:null},provider:{account_sid:account,auth_token:'secret',messaging_service_sid:service,phone_number_sid:phoneSid}};
  const db={call:async(name,...args)=>{calls.push([name,...args]);if(name==='compliance_job_context')return ctx;}};
  const numbers=()=>({fetch:async()=>({accountSid:account})});
  const services=()=>({fetch:async()=>({inboundRequestUrl:'https://example.test/inbound',statusCallback:'https://example.test/status'}),phoneNumbers:{list:async()=>[{sid:phoneSid}]}});
  const payload=senderType==='toll_free'?{sid:registrationSid,status:'TWILIO_APPROVED'}:{compliance:[{sid:registrationSid,campaign_status:'VERIFIED'}]};
  await processCompliance({id:'job',lease_token:'lease'},db,{clientFactory:()=>({incomingPhoneNumbers:numbers,messaging:{v1:{services}}}),fetchImpl:async()=>new Response(JSON.stringify(payload))});
  const checkpoint=calls.find(x=>x[0]==='compliance_checkpoint')[4];assert.equal(checkpoint.registrationState,'webhook_verified');assert.equal(senderType==='toll_free'?checkpoint.verificationSid:checkpoint.campaignSid,registrationSid);
 }
});

test('activation accepts the SDK sender sid and rejects a number outside its service',async()=>{
 for(const attached of [true,false]){
  const calls=[],ctx={operation:{state:'pending',operation:'activation_canary'},registration:{state:'webhook_verified'},provider:{account_sid:account,auth_token:'secret',messaging_service_sid:service,phone_number_sid:phoneSid}};
  const db={call:async(name,...args)=>{calls.push([name,...args]);if(name==='compliance_job_context')return ctx;}};
  const numbers=()=>({fetch:async()=>({accountSid:account})});
  const services=()=>({fetch:async()=>({inboundRequestUrl:'https://example.test/inbound',statusCallback:'https://example.test/status'}),phoneNumbers:{list:async()=>[{sid:attached?phoneSid:'PN'+'9'.repeat(32),accountSid:account,serviceSid:service}]}});
  const run=()=>processCompliance({id:'job',lease_token:'lease'},db,{clientFactory:()=>({incomingPhoneNumbers:numbers,messaging:{v1:{services}}})});
  if(attached){await run();assert.equal(calls.filter(x=>x[0]==='queue_activation_canary').length,1);}
  else {await assert.rejects(run,{code:'ACTIVATION_VERIFICATION_FAILED'});assert.equal(calls.some(x=>x[0]==='queue_activation_canary'),false);}
 }
});
