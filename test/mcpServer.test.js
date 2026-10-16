import test from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {generateKeyPair,SignJWT} from 'jose';
import {createOAuthVerifier,validateOAuthToken,mcpConfig,getOAuthMetadata} from '../src/mcp/auth.js';
import {createMcpApp} from '../src/mcp/app.js';
import {toolDefinitions} from '../src/mcp/tools.js';
import {createCrmHandler} from '../supabase/functions/crm-api/handler.js';
import {permittedGroups} from '../public/workspaceNavigation.js';

const config={resource:'https://mcp.example.test/mcp',issuer:'https://staff.example.test',customerIssuer:'https://customer.example.test',origins:['https://crm.example.test']};
const token={subject:'user_staff',clientId:'https://client.example.test/codex.json',aud:[config.resource],expiration:Math.floor(Date.now()/1000)+3600,revoked:false,expired:false};
const localFetch=(url,options={})=>new Promise((resolve,reject)=>{const req=httpRequest(url,{method:options.method||'GET',headers:options.headers},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));});req.on('error',reject);req.end(options.body);});
test('OAuth requires resource, expiry, human subject and unrevoked token; JWT issuer is verified',async()=>{
 assert.equal(validateOAuthToken(token,config).issuer,config.issuer);
 for(const patch of [{aud:[]},{aud:['https://other.example.test/mcp']},{expiration:null},{expiration:1},{revoked:true},{expired:true},{subject:'machine_1'},{clientId:''},{act:{sub:'machine'}}])assert.throws(()=>validateOAuthToken({...token,...patch},config));
 const {publicKey,privateKey}=await generateKeyPair('RS256');
 const {jwtVerify}=await import('jose');let calls=0;
 const verifier=createOAuthVerifier(config,{client:{idPOAuthAccessToken:{verify:async(raw,options)=>{calls++;assert.equal(options.audience,config.resource);return token;}}},verifyJwt:(raw,_key,options)=>jwtVerify(raw,publicKey,options)});
 const signed=issuer=>new SignJWT({}).setProtectedHeader({alg:'RS256'}).setIssuer(issuer).setAudience(config.resource).setSubject('user_staff').setIssuedAt().setExpirationTime('5m').sign(privateKey);
 await assert.rejects(verifier(await signed(config.customerIssuer)));assert.equal(calls,0);
 assert.equal((await verifier(await signed(config.issuer))).subject,'user_staff');assert.equal(calls,1);
});
test('configuration and discovery fail closed when CRM realm or PKCE/CIMD are missing',async()=>{
 const env={MCP_RESOURCE_URL:config.resource,CRM_CLERK_ISSUER:config.issuer,E2_CLERK_ISSUER:config.customerIssuer,CRM_CLERK_SECRET_KEY:'synthetic',MCP_DATABASE_URL:'synthetic'};
 assert.equal(mcpConfig(env).resource,config.resource);assert.throws(()=>mcpConfig({...env,E2_CLERK_ISSUER:config.issuer}));
 assert.throws(()=>mcpConfig({...env,MCP_RESOURCE_URL:'http://mcp.example.test/mcp'}));
 await assert.rejects(getOAuthMetadata(config,async()=>Response.json({issuer:config.issuer})),/PKCE/);
 const data={issuer:config.issuer,code_challenge_methods_supported:['S256'],client_id_metadata_document_supported:true,authorization_endpoint:config.issuer+'/oauth/authorize',token_endpoint:config.issuer+'/oauth/token'};
 assert.deepEqual(await getOAuthMetadata(config,async()=>Response.json(data)),data);
});
test('Streamable HTTP initializes, lists, calls, reconnects and validates every request',async()=>{
 const calls=[],seen=[],logs=[];let reject=false;
 const app=createMcpApp({config,metadata:{issuer:config.issuer},verify:async raw=>{seen.push(raw);if(reject)throw new Error('Revoked');return {subject:'user_staff',clientId:'verified-client',issuer:config.issuer};},
  invoke:async(...args)=>{calls.push(args);if(args[1]==='crm_create_sms_automation')return {ok:false,error:{code:'VALIDATION_ERROR',message:'Synthetic result',retryable:false}};return {ok:true,data:{connectionId:'00000000-0000-4000-8000-000000000001',status:'pending',permissions:[],businessScope:'none',businesses:[]}};},log:e=>logs.push(e)});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 const headers={host:'mcp.example.test',authorization:'Bearer token-one',accept:'application/json, text/event-stream','content-type':'application/json'};
 const rpc=async(method,params={},extra={})=>localFetch(base+'/mcp',{method:'POST',headers:{...headers,...extra},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
 try{
  const unauth=await localFetch(base+'/mcp',{method:'POST',headers:{host:'mcp.example.test'}});assert.equal(unauth.status,401);assert.match(unauth.headers.get('www-authenticate'),/oauth-protected-resource/);
  assert.equal((await localFetch(base+'/.well-known/oauth-protected-resource/mcp',{headers:{host:'mcp.example.test'}})).status,200);
  assert.equal((await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}})).status,200);
  const listed=await (await rpc('tools/list')).json();assert.equal(listed.result.tools.length,59);
  for(const name of ['crm_preview_conversation_reply','crm_list_conversations','crm_get_conversation','crm_list_leads','crm_get_lead','crm_list_handoffs','crm_get_handoff','crm_get_enquiry_status','crm_list_enquiries','crm_get_enquiry','crm_preview_form','crm_list_forms','crm_get_form','crm_list_sms_automations','crm_get_sms_automation','crm_search_sms_contacts','crm_list_form_submissions','crm_get_sms_run_start_context','crm_list_sms_runs','crm_get_sms_run','crm_get_sms_run_activity']){
   const tool=listed.result.tools.find(x=>x.name===name);assert.ok(tool);
   assert.equal(tool.annotations.readOnlyHint,true);assert.equal(tool.annotations.destructiveHint,false);assert.equal(tool.annotations.openWorldHint,false);
   assert.ok(tool.inputSchema.required.includes('businessId'));assert.equal(tool.inputSchema.additionalProperties,false);
   assert.ok(tool.outputSchema.properties.data);
  }
  assert.equal(listed.result.tools.find(t=>t.name==='crm_review_business_profile').annotations.readOnlyHint,false);
  const markRead=listed.result.tools.find(t=>t.name==='crm_mark_conversation_messages_read');
  assert.deepEqual([...markRead.inputSchema.required].sort(),['businessId','conversationId','revision','messageIds','idempotencyKey'].sort());
  assert.equal(markRead.inputSchema.additionalProperties,false);
  assert.equal(markRead.inputSchema.properties.messageIds.minItems,1);assert.equal(markRead.inputSchema.properties.messageIds.maxItems,100);
  for(const name of ['crm_reply_to_conversation','crm_mark_conversation_messages_read','crm_assign_lead','crm_set_lead_status','crm_assign_handoff','crm_set_handoff_status','crm_set_form_collection_enabled','crm_apply_form_draft','crm_create_form','crm_save_form_draft','crm_create_sms_automation','crm_save_sms_automation_draft','crm_preview_sms_automation','crm_publish_sms_automation','crm_set_form_followups_enabled','crm_start_sms_automation_run','crm_pause_sms_run','crm_resume_sms_run','crm_stop_sms_run']){
   const tool=listed.result.tools.find(t=>t.name===name);assert.ok(tool);assert.equal(tool.annotations.readOnlyHint,name==='crm_preview_sms_automation');
   assert.equal(tool.annotations.idempotentHint,true);assert.equal(tool.annotations.openWorldHint,name==='crm_reply_to_conversation');
  }
  const result=await (await rpc('tools/call',{name:'crm_get_access',arguments:{}})).json();assert.equal(result.result.structuredContent.data.status,'pending');assert.equal(calls[0][0].clientId,'verified-client');
  await rpc('tools/call',{name:'crm_get_access',arguments:{}},{authorization:'Bearer refreshed-token'});assert.ok(seen.includes('refreshed-token'));
  const before=calls.length;const invalid=await (await rpc('tools/call',{name:'crm_set_service_visibility',arguments:{businessId:'a'}})).json();assert.ok(invalid.error||invalid.result.isError);assert.equal(calls.length,before);
  const markArgs={businessId:'a',conversationId:crypto.randomUUID(),revision:1,messageIds:[crypto.randomUUID()],idempotencyKey:'mark-read-test'};
  for(const patch of [{revision:undefined},{idempotencyKey:undefined},{markAll:true},{messageIds:[]},{messageIds:[...markArgs.messageIds,...markArgs.messageIds]}]){
   const r=await (await rpc('tools/call',{name:'crm_mark_conversation_messages_read',arguments:{...markArgs,...patch}})).json();assert.ok(r.error||r.result.isError);assert.equal(calls.length,before);
  }
  for(const args of [{},{businessId:'a',pageSize:101},{businessId:'a',tenantId:'b'}]){
   const r=await (await rpc('tools/call',{name:'crm_list_sms_automations',arguments:args})).json();assert.ok(r.error||r.result.isError);assert.equal(calls.length,before);
  }
  const largeDraft={businessId:'a',kind:'contact',name:'Large draft',idempotencyKey:'large-request',sequence:{trigger:'submission',leadHours:24,replyPolicy:'pause',startHour:0,endHour:24,
   steps:Array.from({length:50},()=>({body:'x'.repeat(1600),delayCount:0,delayUnit:'day',sendCount:1,intervalCount:1,intervalUnit:'day'}))}};
  assert.equal((await rpc('tools/call',{name:'crm_create_sms_automation',arguments:largeDraft})).status,200);assert.equal(calls.length,before+1);
  assert.equal((await rpc('tools/call',{name:'crm_create_sms_automation',arguments:{...largeDraft,name:'x'.repeat(512*1024)}})).status,413);assert.equal(calls.length,before+1);
  assert.equal((await rpc('tools/list',{}, {origin:'https://evil.example.test'})).status,403);
  assert.equal((await rpc('tools/list',{}, {host:'evil.example.test'})).status,403);
  reject=true;assert.equal((await rpc('tools/list')).status,401);
  assert.equal(logs.length,0);
 } finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('AI connection management uses browser identity and remains staff navigation only',async()=>{
 process.env.CRM_ALLOWED_ORIGINS='https://crm.example.test';const calls=[];
 const handler=createCrmHandler({call:async(...args)=>{calls.push(args);return {};}},async()=> 'verified-staff');
 for(const [path,method,action] of [['ai-connections','GET','list'],['ai-connections/activity','GET','activity'],['ai-connections','POST','save']]){
  const response=await handler(new Request(`https://api.example.test/crm-api/platform/${path}`,{method,...(method==='POST'?{body:JSON.stringify({user:'forged'})}:{})}));
  assert.equal(response.status,200);assert.deepEqual(calls.at(-1).slice(0,3),['mcp_admin','verified-staff',action]);
 }
 assert.ok(permittedGroups(true,null).flatMap(x=>x.views).some(x=>x.view==='platform-ai-connections'));
 assert.equal(permittedGroups(false,{smsRead:true}).flatMap(x=>x.views).some(x=>x.view==='platform-ai-connections'),false);
 assert.equal(toolDefinitions.some(([name])=>name.includes('grant')),false);
 assert.deepEqual(toolDefinitions.filter(([name])=>name.includes('send')).map(([name])=>name),['crm_send_contact_sms']);
});
