import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,SignJWT} from 'jose';
import {createCrmAuthenticator} from '../supabase/functions/_shared/http.js';
import {syncCrmLogin} from '../supabase/functions/_shared/crm-account.js';
import {createCrmHandler} from '../supabase/functions/crm-api/handler.js';

test('signed CRM sessions accept only the CRM issuer, signature and authorized party',async()=>{
 const {publicKey,privateKey}=await generateKeyPair('RS256');
 const foreign=await generateKeyPair('RS256');
 let config={issuer:'https://crm.clerk.example.test',customerIssuer:'https://customer.clerk.example.test',origins:['https://crm.example.test']};
 const authenticate=createCrmAuthenticator({config:()=>config,keyForIssuer:()=>publicKey});
 const token=async(overrides={},key=privateKey)=>new SignJWT({azp:'https://crm.example.test',...overrides}).setProtectedHeader({alg:'RS256'}).setSubject('same-subject').setIssuedAt().setExpirationTime('5m').setIssuer(overrides.iss||config.issuer).sign(key);
 const request=value=>new Request('https://api.example.test',{headers:{Authorization:`Bearer ${value}`}});
 assert.equal(await authenticate(request(await token())),'same-subject');
 for(const jwt of [await token({iss:config.customerIssuer}),await token({azp:'https://customer.example.test'}),await token({},foreign.privateKey)]){
  await assert.rejects(()=>authenticate(request(jwt)),error=>error.status===401);
 }
 await assert.rejects(()=>authenticate(new Request('https://api.example.test')),error=>error.status===401);
 config={...config,issuer:config.customerIssuer};
 await assert.rejects(()=>authenticate(request('irrelevant')),error=>error.status===503);
});

test('CRM login provisions only metadata fetched with its dedicated backend key',async()=>{
 process.env.CRM_CLERK_SECRET_KEY='test-only-crm-key';
 const calls=[],db={call:async(...args)=>{calls.push(args);return 'account-id';}};
 let user={id:'verified-user',first_name:' Staff ',last_name:' Member ',updated_at:2,primary_email_address_id:'primary',email_addresses:[{id:'secondary',email_address:'wrong@example.test'},{id:'primary',email_address:'same@example.test'}]};
 const fetchImpl=async(url,options)=>{
  assert.equal(url,'https://api.clerk.com/v1/users/verified-user');
  assert.equal(options.headers.Authorization,'Bearer test-only-crm-key');
  return Response.json(user);
 };
 assert.equal(await syncCrmLogin(db,'verified-user',{fetchImpl}),'account-id');
 assert.deepEqual(calls[0],['sync_crm_account','verified-user','Staff Member','same@example.test',2]);
 user={id:'verified-user',updated_at:3};await syncCrmLogin(db,'verified-user',{fetchImpl});
 assert.deepEqual(calls[1],['sync_crm_account','verified-user',null,null,3]);
 user={id:'another-user',updated_at:4};await assert.rejects(()=>syncCrmLogin(db,'verified-user',{fetchImpl}));
 assert.equal(calls.length,2);
 await assert.rejects(()=>syncCrmLogin(db,'verified-user',{fetchImpl:async()=>new Response(null,{status:404})}),error=>error.status===401);
 delete process.env.CRM_CLERK_SECRET_KEY;
 await assert.rejects(()=>syncCrmLogin(db,'verified-user',{fetchImpl}),error=>error.status===503);
});

test('public CRM configuration cannot fall back to the customer Clerk application',async()=>{
 process.env.CRM_ALLOWED_ORIGINS='https://crm.example.test';
 process.env.CLERK_PUBLISHABLE_KEY='legacy-customer-key';process.env.CLERK_ISSUER='https://customer.clerk.example.test';
 process.env.E2_CLERK_ISSUER='https://customer.clerk.example.test';
 const handler=createCrmHandler({call(){throw new Error('No database call expected');}});
 const request=()=>new Request('https://api.example.test/crm-api/auth/config');
 let data=await (await handler(request())).json();assert.equal(data.configured,false);assert.equal(data.publishableKey,null);
 process.env.CRM_CLERK_ISSUER=process.env.E2_CLERK_ISSUER;process.env.CRM_CLERK_PUBLISHABLE_KEY='crm-only-public-key';
 data=await (await handler(request())).json();assert.equal(data.configured,false);
 process.env.CRM_CLERK_ISSUER='https://crm.clerk.example.test';
 data=await (await handler(request())).json();assert.equal(data.configured,true);assert.equal(data.loginApplication,'crm');assert.equal(data.publishableKey,'crm-only-public-key');
});

test('CRM login fallback uses the verified subject and stops requests on synchronization failures',async()=>{
 const subjects=[];let fail=false;
 const handler=createCrmHandler({call:async name=>name==='api_read'?{rows:[]}:{platformStaff:false}},async()=> 'verified-user',{
  platform:true,provision:async(_db,subject)=>{subjects.push(subject);if(fail)throw Object.assign(new Error('Account unavailable'),{code:'42501'});},
 });
 const request=()=>new Request('https://api.example.test/crm-api/auth/me?user=forged-user');
 assert.equal((await handler(request())).status,200);assert.deepEqual(subjects,['verified-user']);
 fail=true;assert.equal((await handler(request())).status,403);
});
