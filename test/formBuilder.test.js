import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase,call} from './helpers/database.js';
import {defaultDefinition,normalizeDefinition,normalizeAnswers,routeSubmission,publicDefinition} from '../public/form-schema.js';
import {FormService} from '../src/lib/forms/service.js';
import {signFormToken,verifyFormToken} from '../src/lib/forms/tokens.js';
import {executeFormTool,TOOL_NAMES} from '../src/lib/forms/mcp.js';
import {agentConfiguration,runBuilderTurn} from '../src/lib/forms/agent.js';
import {createFormsApp} from '../src/formsServer.js';
let sql,db;
before(async()=>{sql=await testDatabase();db={call:(name,...args)=>call(sql,name,...args)};process.env.FORMS_SIGNING_SECRET='test-signing-secret-not-for-production-12345';});
after(async()=>{await sql?.close();delete process.env.FORMS_SIGNING_SECRET;delete process.env.FORMS_PUBLIC_BASE_URL;delete process.env.CRM_ALLOWED_ORIGINS;});
let tenantSequence=0;
async function setup() {
 const tenant='forms'+(++tenantSequence);
 await call(sql,'api_action','admin',null,'create_business',{id:tenant,name:'Helpful Company',timeZone:'UTC'});
 await sql.query('insert into sms_private.form_features values($1,true)',[tenant]);
 for(const id of ['leads','commercial']) await call(sql,'api_action','admin',tenant,'group',{id,name:id,rule:{startHour:0,endHour:24,aiDraft:false,steps:[{template:'Hello {{first_name}} from {{business_name}} about {{service_name}}. Reply STOP to opt out.',delayCount:0,delayUnit:'day'}]}});
 const service=new FormService(db,'admin',tenant);let form=await service.create();
 form.draft.routing={defaultGroupId:'leads',rules:[{when:{field:'service',operator:'eq',value:'commercial'},groupId:'commercial'}],reviewedVersions:{leads:1,commercial:1}};
 form=await service.save(form.id,form.revision,form.draft,[]);
 return {service,form,tenant};
}
function answers(consent=true,service='residential',phone='+13035550123'){return {name:'Alex',phone,email:'alex@example.com',service,details:'A sofa',sms_consent:consent};}
async function submit(service,form,{input=answers(),key=crypto.randomUUID()}={}) {
 const d=form.draft;const {mapAnswers}=await import('../public/form-schema.js');
 const clean=normalizeAnswers(d,input);
 return db.call('forms_public',form.public_id,'submit',{versionId:form.published_version,idempotencyKey:key,answers:clean,mapped:mapAnswers(d,clean),groupId:routeSubmission(d,clean),disclosure:d.fields.at(-1).disclosure,origin:'https://website.example'});
}

test('schema validates mappings, dates, choices, hidden values and deterministic routing',()=>{
 const d=defaultDefinition();d.routing.defaultGroupId='leads';
 d.fields.splice(4,0,{id:'budget',type:'number',label:'Budget',required:true,visibleWhen:{field:'service',operator:'eq',value:'commercial'}});
 d.routing.rules=[{when:{field:'service',operator:'contains',value:'commercial'},groupId:'commercial'},{when:{field:'service',operator:'eq',value:'commercial'},groupId:'other'}];
 const parsed=normalizeDefinition(d),a=normalizeAnswers(parsed,{...answers(),budget:200});assert.equal(a.budget,undefined);assert.equal(routeSubmission(parsed,a),'leads');
 assert.throws(()=>normalizeAnswers(parsed,answers(true,'commercial')),/Budget is required/);
 assert.equal(routeSubmission(parsed,normalizeAnswers(parsed,{...answers(true,'commercial'),budget:'20'})),'commercial');
 assert.throws(()=>normalizeAnswers(parsed,{...answers(),tenantId:'other'}),/Unknown answer/);
 assert.throws(()=>normalizeAnswers(parsed,{...answers(),sms_consent:'true'}),/true or false/);
 assert.throws(()=>normalizeDefinition({...d,fields:[...d.fields,{id:'phone',type:'text',label:'Duplicate'}]}),/duplicate/);
 assert.throws(()=>normalizeDefinition({...d,fields:d.fields.map(f=>f.type==='consent'?{...f,required:true}:f)}),/optional/);
 assert.throws(()=>normalizeDefinition({...d,theme:{color:'red;display:none'}}),/color/);
 assert.throws(()=>normalizeDefinition({...d,allowedOrigins:['https://site.test/path']}),/origins/);
 assert.throws(()=>normalizeDefinition({...d,instantSms:{enabled:true,body:'Hi {{unknown}}'}}),/unmapped placeholder/);
 assert.equal(normalizeDefinition({...d,instantSms:{enabled:true,body:'Hi {{ name }} about {{service_name}}'}}).instantSms.body,'Hi {{name}} about {{service_name}}');
 assert.equal(publicDefinition(d).routing,undefined);assert.equal(publicDefinition(d).mappings,undefined);
});

test('publishing is atomic, revisions are fenced, and new automations remain drafts until publish',async()=>{
 const {service,tenant}=await setup();let form=await service.create();
 const id=`form-${form.id}-followup`,g={id,name:'Form follow-up',rule:{steps:[{template:'Thanks for your request. Reply STOP to opt out.',delayCount:1,delayUnit:'day'}]}};
 form.draft.routing.defaultGroupId=id;
 form=await service.save(form.id,form.revision,form.draft,[g]);
 assert.equal((await service.catalog()).groups.some(g=>g.id===id),false);
 await assert.rejects(()=>service.save(form.id,1,form.draft),/Draft changed/);
 form=await service.publish(form.id,form.revision);assert.ok(form.published_version);assert.equal(form.draft_groups.length,0);
 assert.equal((await service.catalog()).groups.some(g=>g.id===id),true);
 const old=form.published_version;
 await call(sql,'api_action','admin',tenant,'group',{...g,name:'Changed',rule:g.rule});
 await assert.rejects(()=>service.publish(form.id,form.revision),/latest version/);
 assert.equal((await service.get(form.id)).published_version,old);
 const newId=`form-${form.id}-second`;form=await service.save(form.id,form.revision,form.draft,[{...g,id:newId}]);
 // Exercise the DB transaction's own stale reference check after inserting a draft group.
 await assert.rejects(()=>service.call('publish',{id:form.id,revision:form.revision}),/Automation changed/);
 assert.equal((await service.catalog()).groups.some(g=>g.id===newId),false);
});

test('new leads retain consent evidence and context; duplicate requests never restart an active sequence',async()=>{
 const {service,tenant,form:initial}=await setup();const form=await service.publish(initial.id,initial.revision);
 const key=crypto.randomUUID(),first=await submit(service,form,{key});const duplicate=await submit(service,form,{key});assert.equal(first.id,duplicate.id);
 await assert.rejects(()=>submit(service,form,{key,input:answers(true,'commercial')}),/conflict/);
 const processed=await db.call('forms_process');assert.equal(processed.status,'enrolled');assert.equal(await db.call('forms_process'),null);
 const rows=(await sql.query('select * from public.sms_automation_enrollments where tenant_id=$1',[tenant])).rows;
 assert.equal(rows.length,1);assert.equal(rows[0].metadata.service_name,'residential');assert.equal(rows[0].metadata.submission_id,first.id);
 const evidence=(await sql.query('select evidence from public.sms_consent_events where tenant_id=$1',[tenant])).rows[0].evidence;
 assert.equal(JSON.parse(evidence).versionId,form.published_version);
 await submit(service,form,{key:crypto.randomUUID()});assert.equal((await db.call('forms_process')).status,'already_enrolled');
 assert.equal((await sql.query('select generation from public.sms_automation_enrollments where tenant_id=$1',[tenant])).rows[0].generation,rows[0].generation);
 // The existing worker can consume the enrollment and its mapped service context.
 await sql.query("update public.sms_businesses set sending_enabled=true,status='active' where tenant_id=$1",[tenant]);
 await sql.exec('update sms_private.runtime set scheduler_enabled=true');
 await call(sql,'tick');const job=await call(sql,'claim','automation_jobs','form-test');
 assert.ok(job);const context=await call(sql,'job_context',job.id,job.lease_token);assert.equal(context.enrollment.metadata.service_name,'residential');
});

test('optional instant SMS is queued once before a delayed automation enrollment',async()=>{
 const {service,tenant,form:initial}=await setup();
 initial.draft.instantSms={enabled:true,body:'Thanks {{name}} — we received your {{service_name}} request.'};
 let saved=await service.save(initial.id,initial.revision,initial.draft,[]);const form=await service.publish(saved.id,saved.revision);
 await sql.query("update public.sms_businesses set sending_enabled=true,status='active' where tenant_id=$1",[tenant]);
 await submit(service,form);assert.equal((await db.call('forms_process')).status,'enrolled');
 const job=(await sql.query("select payload from sms_private.jobs where tenant_id=$1 and queue='sms_send_jobs' and dedupe_key like 'form-instant:%'",[tenant])).rows[0];
 assert.equal(job.payload.request.body,'Thanks Alex — we received your residential request.');
 const enrollment=(await sql.query('select next_run_at,metadata from public.sms_automation_enrollments where tenant_id=$1',[tenant])).rows[0];
 assert.equal(enrollment.metadata.instant_sms,true);assert.ok(new Date(enrollment.next_run_at).getTime()>Date.now()+40000);
 await submit(service,form,{key:crypto.randomUUID()});assert.equal((await db.call('forms_process')).status,'already_enrolled');
 assert.equal((await sql.query("select count(*)::int n from sms_private.jobs where tenant_id=$1 and dedupe_key like 'form-instant:%'",[tenant])).rows[0].n,1);
});

test('missing consent and STOP suppression save leads without creating SMS enrollments',async()=>{
 const {service,tenant,form:initial}=await setup();const form=await service.publish(initial.id,initial.revision);
 await submit(service,form,{input:answers(false)});assert.equal((await db.call('forms_process')).reason,'CONSENT_REQUIRED');
 await call(sql,'api_action','admin',tenant,'consent',{phone:'+13035550123',consent:false,evidence:'Customer STOP'});
 await submit(service,form);assert.equal((await db.call('forms_process')).reason,'STOP_SUPPRESSED');
 const contact=(await sql.query('select * from public.sms_contacts where tenant_id=$1',[tenant])).rows[0];assert.equal(contact.opted_out,true);assert.equal(contact.marketing_consent,false);
 assert.equal((await sql.query('select count(*)::int as n from public.sms_automation_enrollments where tenant_id=$1',[tenant])).rows[0].n,0);
});

test('tenant permissions, paused enrollments, inactive groups and unpublished forms are enforced',async()=>{
 const {service,tenant,form:initial}=await setup();const form=await service.publish(initial.id,initial.revision);
 await assert.rejects(()=>new FormService(db,'stranger',tenant).get(form.id),/access required/);
 const other=await setup();await assert.rejects(()=>other.service.get(form.id),/not found/);
 await sql.query("insert into public.sms_business_memberships values($1,'viewer','viewer')",[tenant]);
 await assert.rejects(()=>new FormService(db,'viewer',tenant).get(form.id),/access required/);
 await submit(service,form);await db.call('forms_process');
 await sql.query("update public.sms_automation_enrollments set status='paused' where tenant_id=$1",[tenant]);
 await submit(service,form);assert.equal((await db.call('forms_process')).status,'already_enrolled');
 await call(sql,'api_action','admin',tenant,'delete_group',{id:'commercial'});
 await submit(service,form,{input:answers(true,'commercial')});assert.equal((await db.call('forms_process')).reason,'AUTOMATION_UNAVAILABLE');
 await service.call('unpublish',{id:form.id,revision:form.revision});await assert.rejects(()=>db.call('forms_public',form.public_id,'get',{}),/unavailable/);
});

test('MCP is form-bound, draft-only, expires and enforces a shared tool budget',async()=>{
 const {service,tenant,form}=await setup();let sess=await service.call('session',{id:form.id});sess=await service.call('begin_turn',{id:form.id,message:'Build a form'});
 const claims={tenant,user:'admin',form:form.id,session:sess.id};
 const token=await signFormToken(claims,'forms-mcp');assert.equal((await verifyFormToken(token,'forms-mcp')).form,form.id);
 await assert.rejects(()=>verifyFormToken(token,'forms-submit'),/Invalid/);
 await assert.rejects(async()=>verifyFormToken(await signFormToken(claims,'forms-mcp',1),'forms-mcp'),/Invalid/);
 assert.equal((await executeFormTool(db,claims,'get_form_draft')).id,form.id);
 await assert.rejects(()=>executeFormTool(db,claims,'publish_form'),/not allowed/);
 const result=await executeFormTool(db,claims,'simulate_submission',{answers:answers()});assert.equal(result.simulation,true);
 assert.equal((await sql.query('select count(*)::int n from public.sms_contacts where tenant_id=$1',[tenant])).rows[0].n,0);
 await assert.rejects(()=>executeFormTool(db,{...claims,form:crypto.randomUUID()},'get_form_draft'),/expired/);
 await sql.query('update public.sms_form_agent_sessions set tool_count=30 where tenant_id=$1',[tenant]);
 await assert.rejects(()=>executeFormTool(db,claims,'get_form_draft'),/budget/);
 await sql.query("update public.sms_form_agent_sessions set authorized_until=now()-interval '1 second' where tenant_id=$1",[tenant]);
 await assert.rejects(()=>executeFormTool(db,claims,'get_form_draft'),/expired/);
 assert.ok(!TOOL_NAMES.some(n=>/publish|send_sms|sql/.test(n)));
});

test('processing failures roll back contact and consent changes and can be retried safely',async()=>{
 const {service,tenant,form:initial}=await setup();const form=await service.publish(initial.id,initial.revision);
 const submitted=await submit(service,form);
 await sql.exec(`create function public.form_test_failure() returns trigger language plpgsql as $$ begin raise exception 'temporary failure'; end $$;
 create trigger form_test_failure before insert on public.sms_automation_enrollments for each row execute function public.form_test_failure();`);
 try {
  assert.equal((await db.call('forms_process')).status,'retry');
  assert.equal((await sql.query('select count(*)::int n from public.sms_contacts where tenant_id=$1',[tenant])).rows[0].n,0);
  assert.equal((await sql.query('select count(*)::int n from public.sms_consent_events where tenant_id=$1',[tenant])).rows[0].n,0);
  await sql.query('update public.sms_form_submissions set attempts=4,available_at=now() where tenant_id=$1 and id=$2',[tenant,submitted.id]);
  assert.equal((await db.call('forms_process')).status,'failed');
 } finally {await sql.exec('drop trigger form_test_failure on public.sms_automation_enrollments;drop function public.form_test_failure();');}
 await service.call('retry',{id:form.id,submissionId:submitted.id});assert.equal((await db.call('forms_process')).status,'enrolled');
 await assert.rejects(()=>service.call('retry',{id:form.id,submissionId:submitted.id}),/Only failed/);
});

test('public database roles cannot read forms or invoke form mutations directly',async()=>{
 await sql.exec('set role anon');
 try {
  await assert.rejects(()=>sql.query('select * from public.sms_forms'),/permission denied/);
  await assert.rejects(()=>call(sql,'forms_admin','admin','forms1','list',{}),/permission denied/);
 } finally {await sql.exec('reset role');}
});

test('agent tool workflow repairs invalid fields, wires discovered groups and validates its saved draft',async()=>{
 const {service,form,tenant}=await setup();let claims;
 const client={beta:{agents:{sessions:{
  create:async p=>{claims=await verifyFormToken(p.agent.tools[0].transport.authorization.slice(7),'forms-mcp');assert.ok(p.input.length);assert.equal(p.stream,true);return client.beta.agents.sessions.events.stream();},
  events:{create:async()=>{},stream:async()=>({async *[Symbol.asyncIterator](){
   yield {type:'agent.session.turn.created',turn_id:'repair',session_id:'repair-session'};
   const groups=await executeFormTool(db,claims,'list_automation_groups');
   let draft=await executeFormTool(db,claims,'get_form_draft');
   draft.draft.title='Commercial quote intake';
   await assert.rejects(()=>executeFormTool(db,claims,'save_form_draft',{revision:draft.revision,definition:{...draft.draft,mappings:{}}}),/phone field/);
   draft.draft.routing={defaultGroupId:'commercial',rules:[],reviewedVersions:{commercial:Number(groups.find(g=>g.id==='commercial').version)}};
   draft=await executeFormTool(db,claims,'save_form_draft',{revision:draft.revision,definition:draft.draft});
   assert.equal((await executeFormTool(db,claims,'validate_form')).valid,true);
   assert.equal((await executeFormTool(db,claims,'simulate_submission',{answers:answers()})).groupId,'commercial');
   yield {type:'agent.session.turn.completed',turn_id:'repair',usage:{total_tokens:100}};
  }})}
 }}}};
 await runBuilderTurn(service,form.id,'Create commercial intake',{client,baseUrl:'https://forms.example'});
 const saved=await service.get(form.id);assert.equal(saved.draft.title,'Commercial quote intake');assert.equal(saved.published_version,null);
 assert.equal((await sql.query('select count(*)::int n from public.sms_contacts where tenant_id=$1',[tenant])).rows[0].n,0);
});

test('Agents API creates and resumes sessions, records outcomes and rejects concurrent turns',async()=>{
 const {service,form}=await setup();const events=[];let creates=0,inputs=0;
 const client={beta:{agents:{sessions:{create:async p=>{creates++;assert.equal(p.environment.type,'none');assert.equal(p.agent.tools[0].required,true);assert.ok(p.input.length);assert.equal(p.stream,true);return client.beta.agents.sessions.events.stream();},retrieve:async()=>({status:'idle'}),events:{create:async(_id,p)=>{inputs++;assert.ok(p['Idempotency-Key']);assert.ok(p.events[0].type.startsWith('agent.session.input.'));},stream:async()=>({async *[Symbol.asyncIterator](){yield {type:'agent.session.turn.created',turn_id:'turn',session_id:'remote'};yield {type:'agent.session.turn.output_text.done',turn_id:'turn',text:'Draft ready'};yield {type:'agent.session.turn.completed',turn_id:'turn',usage:{total_tokens:12}};}})}}}}};
 for(let i=0;i<2;i++)await runBuilderTurn(service,form.id,'Build a form',{client,baseUrl:'https://forms.example',onEvent:e=>events.push(e)});
 assert.equal(creates,1);assert.equal(inputs,1);assert.equal(events.filter(e=>e.event==='agent_completed').length,2);
 const session=await service.call('session',{id:form.id});assert.equal(session.usage.total_tokens,12);assert.equal(session.status,'idle');
 await service.call('begin_turn',{id:form.id,message:'working'});await assert.rejects(()=>service.call('begin_turn',{id:form.id,message:'again'}),/already running/);
 const config=agentConfiguration('secret','https://forms.example');assert.deepEqual(config.tools[0].allowed_tools,TOOL_NAMES);
});

test('pinned OpenAI SDK sends valid session and continuation wire contracts',async()=>{
 const {service,form}=await setup();const {default:OpenAI}=await import('openai');const seen=[];
 const sse=()=>new Response([
  {type:'agent.session.created',session_id:'sdk-session'},
  {type:'agent.session.turn.created',session_id:'sdk-session',turn_id:'sdk-turn'},
  {type:'agent.session.turn.completed',session_id:'sdk-session',turn_id:'sdk-turn',usage:{total_tokens:3}}
 ].map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'Content-Type':'text/event-stream'}});
 const client=new OpenAI({apiKey:'mock',maxRetries:0,fetch:async(url,options)=>{
  const path=new URL(url).pathname,headers=new Headers(options.headers),body=options.body?JSON.parse(options.body):null;
  seen.push({path,method:options.method,body,headers});assert.equal(headers.get('OpenAI-Beta'),'agents=v1');
  if(path==='/v1/agents/sessions') {assert.equal(body.environment.type,'none');assert.equal(body.input[0].content[0].text,'Build');assert.equal(body.stream,true);assert.ok(headers.get('Idempotency-Key'));return sse();}
  if(path.endsWith('/events')&&options.method==='POST'){assert.deepEqual(Object.keys(body),['events']);assert.ok(headers.get('Idempotency-Key'));return new Response(null,{status:202});}
  if(path.endsWith('/events'))return sse();
  return new Response(JSON.stringify({id:'sdk-session',status:'idle'}),{headers:{'Content-Type':'application/json'}});
 }});
 await runBuilderTurn(service,form.id,'Build',{client,baseUrl:'https://forms.example'});
 await runBuilderTurn(service,form.id,'Refine',{client,baseUrl:'https://forms.example'});
 assert.equal((await service.call('session',{id:form.id})).status,'idle');
 assert.equal(seen.filter(x=>x.path==='/v1/agents/sessions').length,1);
 assert.equal(seen.filter(x=>x.path.endsWith('/events')&&x.method==='POST').length,1);
});

test('public HTTP renderer, validation, signed submission, shared limits and actual MCP transport',async()=>{
 const {service,form:initial,tenant}=await setup();initial.draft.allowedOrigins=['https://website.example'];const saved=await service.save(initial.id,initial.revision,initial.draft);const form=await service.publish(saved.id,saved.revision);
 process.env.CRM_ALLOWED_ORIGINS='https://crm.example';
 const {app}=createFormsApp(db,{verify:async()=> 'admin'});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}`;process.env.FORMS_PUBLIC_BASE_URL=base;
 try {
  const rendered=await fetch(base+'/forms/'+form.public_id);assert.equal(rendered.status,200);assert.equal(rendered.headers.get('x-frame-options'),null);assert.match(rendered.headers.get('content-security-policy'),/frame-ancestors 'self' https:\/\/website.example/);
  const config=await (await fetch(base+'/forms-public/'+form.public_id)).json();assert.equal(config.definition.routing,undefined);assert.equal(config.definition.mappings,undefined);assert.equal(config.botProtection,'proof_of_work');
  const oldToken=await new (await import('jose')).SignJWT({publicId:form.public_id,version:form.published_version}).setProtectedHeader({alg:'HS256'}).setIssuer('sms-form-builder').setAudience('forms-submit').setIssuedAt(Math.floor(Date.now()/1000)-10).setExpirationTime('1h').sign(new TextEncoder().encode(process.env.FORMS_SIGNING_SECRET));
  let proofCounter=0;for(;;proofCounter++){const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${oldToken}.${proofCounter}`)));if(hash[0]===0&&(hash[1]&0xf0)===0)break;}
  const post=body=>fetch(base+'/forms-public/'+form.public_id+'/submissions',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({token:oldToken,versionId:form.published_version,idempotencyKey:crypto.randomUUID(),answers:answers(),proofCounter,...body})});
  assert.equal((await post({website:'spam'})).status,400);assert.equal((await post({token:'forged'})).status,401);
  assert.equal((await post({answers:{...answers(),sms_consent:'yes'}})).status,400);
  assert.equal((await post({})).status,202);
  for(let i=0;i<10;i++)await post({website:'spam'});assert.equal((await post({})).status,429);
  const sess=await service.call('session',{id:form.id});await service.call('begin_turn',{id:form.id,message:'Inspect'});
  const token=await signFormToken({tenant,user:'admin',form:form.id,session:sess.id},'forms-mcp');
  const rpc=await fetch(base+'/mcp/forms',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})});
  const body=await rpc.json();assert.equal(rpc.status,200);assert.deepEqual(body.result.tools.map(t=>t.name),TOOL_NAMES);
  const denied=await fetch(base+'/mcp/forms',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(denied.status,401);
 } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});
