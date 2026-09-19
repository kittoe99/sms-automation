import test from 'node:test';
import assert from 'node:assert/strict';
import {processCompliance} from '../src/workers/compliance.js';

const account='AC'+'1'.repeat(32),service='MG'+'2'.repeat(32),phoneSid='PN'+'3'.repeat(32);
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
 const services=()=>({phoneNumbers:{list:async()=>[{phoneNumberSid:phoneSid}]}});
 await processCompliance({id:'job',lease_token:'lease'},db,{clientFactory:()=>({incomingPhoneNumbers:numbers,messaging:{v1:{services}}})});
 const checkpoint=calls.find(x=>x[0]==='compliance_checkpoint');assert.equal(checkpoint[4].registrationState,'in_review');assert.equal(checkpoint[4].phoneNumberSid,phoneSid);assert.equal(checkpoint[4].reconciledOperationId,uncertainId);
 assert.equal(calls.some(x=>x[0]==='compliance_checkpoint'&&x[3]==='submitting'),false);
});
