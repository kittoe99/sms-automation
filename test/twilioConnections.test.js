import test from 'node:test';
import assert from 'node:assert/strict';
import {createTwilioConnections} from '../supabase/functions/crm-api/twilio-connections.js';
import {createCrmHandler} from '../supabase/functions/crm-api/handler.js';
const account='AC'+'1'.repeat(32),child='AC'+'2'.repeat(32),service='MG'+'3'.repeat(32),phone='PN'+'4'.repeat(32),profile='BU'+'5'.repeat(32),verification='HH'+'6'.repeat(32),brand='BN'+'7'.repeat(32),campaign='QE'+'8'.repeat(32);
const base='https://example.supabase.co/functions/v1/twilio-webhook';
function fixture(changes={}) {
 const calls=[],mutations=[],data={
  account:{sid:account,ownerAccountSid:account,status:'active',friendlyName:'Platform',authToken:'private-token-do-not-leak'},
  profiles:[{sid:profile,friendlyName:'Example Services LLC',status:'twilio-approved'}],
  services:[{sid:service,accountSid:account,friendlyName:'Service SMS',inboundRequestUrl:base+'/inbound',inboundMethod:'POST',statusCallback:base+'/status',useInboundWebhookOnNumber:false}],
  numbers:[{sid:phone,accountSid:account,phoneNumber:'+18775550180',countryCode:'US',capabilities:['SMS']}],
  verifications:[{sid:verification,accountSid:account,tollfreePhoneNumberSid:phone,status:'TWILIO_APPROVED',customerProfileSid:profile,businessName:'Example Services LLC'}],brands:[],campaigns:[],...changes,
 };
 const accounts=()=>({fetch:async()=>data.account});accounts.list=async()=>[data.account];
 const services=()=>({phoneNumbers:{list:async()=>data.numbers},usAppToPerson:{list:async()=>data.campaigns},
  fetch:async()=>data.services[0],update:async p=>{mutations.push(p);Object.assign(data.services[0],p);return data.services[0];}});services.list=async()=>data.services;
 const client={api:{v2010:{accounts}},trusthub:{v1:{customerProfiles:{list:async()=>data.profiles}}},
  messaging:{v1:{services,brandRegistrations:{list:async()=>data.brands},tollfreeVerifications:{list:async params=>{assert.equal(params.pageSize,50);return data.verifications;}}}},
  incomingPhoneNumbers:()=>({fetch:async()=>({sid:phone,accountSid:data.numberOwner||account,phoneNumber:data.numbers[0].phoneNumber,capabilities:{sms:true}})})};
 const db={call:async(name,...args)=>{calls.push([name,...args]);if(name==='twilio_connection_access')return {bindings:[],business:{name:'Example Services'}};if(name==='reserve_twilio_connection')return {id:'reservation'};if(name==='complete_twilio_connection')return {connected:true,sendingEnabled:false};}};
 const api=createTwilioConnections({clientFactory:()=>client,environment:key=>({TWILIO_MASTER_ACCOUNT_SID:account,TWILIO_MASTER_AUTH_TOKEN:'private-token-do-not-leak',SMS_WEBHOOK_BASE_URL:base})[key]});
 const input={tenantId:'business',accountSid:account,messagingServiceSid:service,phoneNumberSid:phone,registrationSid:verification,revision:0,confirmedBusinessIdentity:true};
 return {api,db,data,calls,mutations,input};
}
test('inventory exposes only approved associated senders and never credentials',async()=>{
 const x=fixture();const a=await x.api.accounts(x.db,'admin'),p=await x.api.profiles(x.db,'admin',account,'business');
 assert.equal(a.accounts[0].sid,account);assert.equal(p.options.length,1);assert.equal(p.options[0].profileName,'Example Services LLC');assert.equal(p.options[0].phoneNumber,'+18775550180');
 assert.equal(JSON.stringify([a,p]).includes('private-token'),false);assert.deepEqual(x.calls[0],['twilio_connection_access','admin',null]);
});
test('rejected or pending verification, unapproved profiles and ambiguous sender pools are unavailable',async()=>{
 for(const status of ['IN_REVIEW','TWILIO_REJECTED']){const x=fixture();x.data.verifications[0].status=status;assert.equal((await x.api.profiles(x.db,'admin',account,'business')).options.length,0);}
 const x=fixture();x.data.profiles[0].status='pending-review';assert.match((await x.api.profiles(x.db,'admin',account,'business')).unavailable[0].reason,/profile/);
 x.data.profiles[0].status='twilio-approved';x.data.numbers.push({...x.data.numbers[0],sid:'PN'+'9'.repeat(32)});assert.equal((await x.api.profiles(x.db,'admin',account,'business')).options.length,0);
});
test('A2P requires verified campaign, approved non-mock brand and approved business profile',async()=>{
 const x=fixture({verifications:[],brands:[{sid:brand,accountSid:account,status:'APPROVED',customerProfileBundleSid:profile}],campaigns:[{sid:campaign,accountSid:account,messagingServiceSid:service,campaignStatus:'VERIFIED',brandRegistrationSid:brand}]});
 x.data.numbers[0].phoneNumber='+13035550180';let result=await x.api.profiles(x.db,'admin',account,'business');assert.equal(result.options[0].senderType,'local_a2p');assert.match(result.options[0].numberRegistrationNote,/Carrier registration/);
 x.data.campaigns[0].campaignStatus='FAILED';assert.equal((await x.api.profiles(x.db,'admin',account,'business')).options.length,0);
 x.data.campaigns[0].campaignStatus='VERIFIED';x.data.brands[0].mock=true;assert.equal((await x.api.profiles(x.db,'admin',account,'business')).options.length,0);
});
test('connection revalidates Twilio resources, stores credentials only in private RPC, and does not send or purchase',async()=>{
 const x=fixture();const result=await x.api.connect(x.db,'admin',{...x.input,authToken:'forged-token',phoneNumber:'+19995550123',profileName:'forged'});
 assert.equal(result.connected,true);assert.equal(result.sendingEnabled,false);assert.equal(x.mutations.length,0);
 const reserved=x.calls.find(c=>c[0]==='reserve_twilio_connection')[3];assert.equal(reserved.phoneNumber,'+18775550180');assert.equal(reserved.profileName,'Example Services LLC');assert.equal('authToken' in reserved,false);
 const stored=x.calls.find(c=>c[0]==='complete_twilio_connection');assert.equal(stored[1],'admin');assert.equal(stored[4].authToken,'private-token-do-not-leak');
});
test('foreign accounts, revoked approval, wrong ownership and missing identity confirmation cannot mutate',async()=>{
 for(const change of ['account','approval','number','confirm']){
  const x=fixture();if(change==='account')x.data.account.ownerAccountSid=child;if(change==='approval')x.data.verifications[0].status='TWILIO_REJECTED';if(change==='number')x.data.numberOwner=child;if(change==='confirm')x.input.confirmedBusinessIdentity=false;
  await assert.rejects(()=>x.api.connect(x.db,'admin',x.input));assert.equal(x.calls.some(c=>c[0]==='reserve_twilio_connection'),false);assert.equal(x.mutations.length,0);
 }
});
test('webhook changes are reserved first, verified and failures remain reviewable',async()=>{
 const x=fixture();x.data.services[0].inboundRequestUrl='https://old.example.test/inbound';await x.api.connect(x.db,'admin',x.input);assert.equal(x.mutations.length,1);assert.equal(x.mutations[0].inboundRequestUrl,base+'/inbound');
 const y=fixture();y.data.services[0].inboundRequestUrl=null;y.db.call=async(name,...args)=>{y.calls.push([name,...args]);if(name==='twilio_connection_access')return {};if(name==='reserve_twilio_connection')return {id:'reservation'};if(name==='complete_twilio_connection')throw new Error('database unavailable');};
 await assert.rejects(()=>y.api.connect(y.db,'admin',y.input),/database unavailable/);assert.equal(y.calls.at(-1)[0],'fail_twilio_connection');
});
test('staff check happens before any provider inventory request',async()=>{
 const x=fixture();x.db.call=async()=>{throw Object.assign(new Error('Staff required'),{code:'42501'});};
 await assert.rejects(()=>x.api.accounts(x.db,'reader'),/Staff/);await assert.rejects(()=>x.api.profiles(x.db,'reader',account,'business'),/Staff/);await assert.rejects(()=>x.api.connect(x.db,'reader',x.input),/Staff/);
});
test('platform Twilio routes preserve the verified identity and requested business',async()=>{
 const x=fixture(),routes=[];const handler=createCrmHandler(x.db,async()=> 'verified',{twilioConnections:{
  accounts:async(...args)=>{routes.push(['accounts',...args.slice(1)]);return {};},profiles:async(...args)=>{routes.push(['profiles',...args.slice(1)]);return {};},connect:async(...args)=>{routes.push(['connect',...args.slice(1)]);return {};},
 }});
 for(const [path,method,body] of [['accounts','GET'],['profiles?accountSid='+account+'&tenantId=business','GET'],['connect','POST',{...x.input,user:'forged'}]]){
  assert.equal((await handler(new Request('https://api.example.test/crm-api/platform/twilio/'+path,{method,body:body?JSON.stringify(body):undefined}))).status,200);
 }
 assert.equal(routes[0][1],'verified');assert.deepEqual(routes[1],['profiles','verified',account,'business']);assert.equal(routes[2][1],'verified');
});
