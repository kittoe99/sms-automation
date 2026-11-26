import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccountAccess} from '../supabase/functions/crm-api/account-access.js';
import {accessBadge} from '../public/accountAccess.js';

const CRM='https://crm-clerk.example.test',E2='https://clerk.example.test';
const environment=name=>({CRM_CLERK_ISSUER:CRM,CRM_CLERK_SECRET_KEY:'sk_crm',E2_CLERK_ISSUER:E2,E2_CLERK_SECRET_KEY:'sk_e2'})[name];
function fixture({identities=[{issuer:E2,subject:'user_1'}],fail={},blocked=true}={}) {
 const db=[],clerk=[];
 const database={call:async(name,u,action,p)=>{db.push([action,p]);
  if(action==='access_identity')return {accountId:p.accountId,status:blocked?'suspended':'active',blocked,identities};
  return {accountId:p.accountId,status:action==='access_block'?'suspended':'active',blocked:action==='access_block',identities};}};
 const fetchImpl=async(url,init)=>{
  const u=new URL(url),path=u.pathname.replace('/v1/','');clerk.push([init.method,path,init.headers.Authorization,u.search]);
  if(fail[path])return new Response(JSON.stringify({errors:[{message:fail[path]}]}),{status:422});
  const body=path==='sessions'?{data:[{id:'sess_1'},{id:'sess_2'}]}:path.startsWith('users/')&&init.method==='GET'?{banned:true,locked:false,last_sign_in_at:1795000000000}:{};
  return new Response(JSON.stringify(body),{status:200});
 };
 return {api:createAccountAccess({environment,fetchImpl}),database,db,clerk};
}

test('block: database first, then Clerk ban with the matching app key and session revocation',async()=>{
 const x=fixture();const r=await x.api.block(x.database,'staff',{accountId:'a1',revision:3,reason:'Abuse'});
 assert.deepEqual(x.db[0],['access_block',{accountId:'a1',revision:3,reason:'Abuse'}]);
 assert.deepEqual(x.clerk.map(c=>[c[0],c[1],c[2]]),[['POST','users/user_1/ban','Bearer sk_e2'],['GET','sessions','Bearer sk_e2'],['POST','sessions/sess_1/revoke','Bearer sk_e2'],['POST','sessions/sess_2/revoke','Bearer sk_e2']]);
 assert.equal(r.message,'Account blocked and signed out.');assert.equal(r.clerk[0].sessionsRevoked,2);
});

test('block reports a Clerk failure instead of hiding it; the database block stands',async()=>{
 const x=fixture({fail:{'users/user_1/ban':'Not allowed'}});const r=await x.api.block(x.database,'staff',{accountId:'a1',revision:1,reason:'x'});
 assert.equal(x.db[0][0],'access_block');assert.match(r.message,/Clerk step failed: Not allowed/);
});

test('CRM accounts use the CRM Clerk key; unknown issuers are refused',async()=>{
 let x=fixture({identities:[{issuer:CRM,subject:'user_staff'}]});await x.api.signOut(x.database,'staff',{accountId:'a1'});
 assert.equal(x.clerk[0][2],'Bearer sk_crm');
 x=fixture({identities:[{issuer:'https://other.example.test',subject:'u'}]});const r=await x.api.block(x.database,'staff',{accountId:'a1',revision:1,reason:'x'});
 assert.match(r.message,/not configured/);assert.equal(x.clerk.length,0);
});

test('unblock: staff-checked identity first, Clerk unban, then database restore',async()=>{
 const x=fixture();const r=await x.api.unblock(x.database,'staff',{accountId:'a1',reason:'Resolved'});
 assert.deepEqual(x.db.map(d=>d[0]),['access_identity','access_unblock']);
 assert.deepEqual(x.clerk.map(c=>c[1]),['users/user_1/unban']);assert.equal(r.message,'Account unblocked and access restored.');
});

test('unblock stops if Clerk cannot unban, leaving the account blocked',async()=>{
 const x=fixture({fail:{'users/user_1/unban':'Clerk down'}});const r=await x.api.unblock(x.database,'staff',{accountId:'a1'});
 assert.deepEqual(x.db.map(d=>d[0]),['access_identity']);assert.match(r.message,/still blocked/);
});

test('unblock refuses accounts that are not blocked',async()=>{
 const x=fixture({blocked:false});await assert.rejects(x.api.unblock(x.database,'staff',{accountId:'a1'}),/not blocked/);assert.equal(x.clerk.length,0);
});

test('sign out everywhere counts revoked sessions; status reads live Clerk state',async()=>{
 let x=fixture();let r=await x.api.signOut(x.database,'staff',{accountId:'a1'});assert.equal(r.message,'Signed out of 2 active sessions.');
 x=fixture();r=await x.api.status(x.database,'staff','a1');
 assert.equal(r.identities,undefined);assert.deepEqual(r.clerk[0],{issuer:E2,ok:true,app:'E2 Local',banned:true,locked:false,lastSignInAt:new Date(1795000000000).toISOString(),activeSessions:2});
});

test('access badge',()=>{
 assert.match(accessBadge({access:'blocked'}),/data-access="blocked">Blocked</);
 assert.match(accessBadge({status:'active'}),/>Active</);
});
