import {env} from '../_shared/http.js';

// Staff access controls that reach Clerk. The database (sms_private.platform_action)
// checks staff access, records the change and returns the account's Clerk
// identities; each identity's issuer picks the Clerk application and its key.
const CLERK='https://api.clerk.com/v1/';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});

export function createAccountAccess({environment=env,fetchImpl=fetch}={}) {
 function keyFor(issuer) {
  if(issuer&&issuer===environment('CRM_CLERK_ISSUER'))return environment('CRM_CLERK_SECRET_KEY');
  if(issuer&&issuer===environment('E2_CLERK_ISSUER'))return environment('E2_CLERK_SECRET_KEY');
  return null;
 }
 async function clerk(issuer,method,path,query) {
  const key=keyFor(issuer);
  if(!key)throw fail('Clerk is not configured for this account\'s sign-in application.',503);
  const url=new URL(path,CLERK);if(query)url.search=new URLSearchParams(query).toString();
  const response=await fetchImpl(url,{method,headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(15000)});
  const value=await response.json().catch(()=>null);
  if(!response.ok)throw fail(value?.errors?.[0]?.long_message||value?.errors?.[0]?.message||'Clerk request failed.',response.status>=500?502:400);
  return value;
 }
 const user=subject=>`users/${encodeURIComponent(subject)}`;
 async function revokeSessions(identity) {
  const sessions=await clerk(identity.issuer,'GET','sessions',{user_id:identity.subject,status:'active',limit:'100'});
  const list=Array.isArray(sessions)?sessions:sessions?.data||[];
  for(const session of list)await clerk(identity.issuer,'POST',`sessions/${encodeURIComponent(session.id)}/revoke`);
  return list.length;
 }
 // Run a Clerk step on every identity; report what failed instead of hiding it.
 async function each(identities,step) {
  const results=[];
  for(const identity of identities||[]) {
   try{results.push({issuer:identity.issuer,ok:true,...(await step(identity)||{})});}
   catch(error){results.push({issuer:identity.issuer,ok:false,error:error.message});}
  }
  return results;
 }
 const outcome=(account,clerkResults,done)=>{
  const failed=clerkResults.filter(r=>!r.ok);
  return {account,clerk:clerkResults,message:failed.length?`${done} Clerk step failed: ${failed.map(f=>f.error).join('; ')} Retry to finish.`:done};
 };

 // Block: suspend and record first (safe even if Clerk is down), then ban and sign out.
 async function block(db,u,input) {
  const account=await db.call('platform_action',u,'access_block',input);
  const results=await each(account.identities,async identity=>{await clerk(identity.issuer,'POST',`${user(identity.subject)}/ban`);return {sessionsRevoked:await revokeSessions(identity)};});
  return outcome(account,results,'Account blocked and signed out.');
 }
 // Unblock: lift the Clerk ban first; if the database step then fails the account stays suspended.
 async function unblock(db,u,input) {
  const current=await db.call('platform_action',u,'access_identity',{accountId:input.accountId});
  if(!current.blocked)throw fail('This account is not blocked.');
  const results=await each(current.identities,async identity=>{await clerk(identity.issuer,'POST',`${user(identity.subject)}/unban`);});
  if(results.some(r=>!r.ok))return {account:current,clerk:results,message:`Clerk could not unblock sign-in: ${results.filter(r=>!r.ok).map(r=>r.error).join('; ')} The account is still blocked.`};
  const account=await db.call('platform_action',u,'access_unblock',input);
  return outcome(account,results,'Account unblocked and access restored.');
 }
 async function signOut(db,u,input) {
  const account=await db.call('platform_action',u,'access_sign_out',input);
  const results=await each(account.identities,async identity=>({sessionsRevoked:await revokeSessions(identity)}));
  const count=results.reduce((sum,r)=>sum+(r.sessionsRevoked||0),0);
  return outcome(account,results,`Signed out of ${count} active session${count===1?'':'s'}.`);
 }
 // Live Clerk state for the account page: banned, last sign-in, active sessions.
 async function status(db,u,accountId) {
  const current=await db.call('platform_action',u,'access_identity',{accountId});
  const clerkState=await each(current.identities,async identity=>{
   const row=await clerk(identity.issuer,'GET',user(identity.subject));
   const sessions=await clerk(identity.issuer,'GET','sessions',{user_id:identity.subject,status:'active',limit:'100'});
   return {app:identity.issuer===environment('CRM_CLERK_ISSUER')?'Admin CRM':'E2 Local',banned:Boolean(row.banned),locked:Boolean(row.locked),
    lastSignInAt:row.last_sign_in_at?new Date(row.last_sign_in_at).toISOString():null,activeSessions:(Array.isArray(sessions)?sessions:sessions?.data||[]).length};
  });
  return {...current,identities:undefined,clerk:clerkState};
 }
 return {block,unblock,signOut,status};
}
