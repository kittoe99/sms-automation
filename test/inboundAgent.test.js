import test from 'node:test';
import assert from 'node:assert/strict';
import {processInboundAgent,INBOUND_AGENT_MODEL} from '../src/workers/inboundAgent.js';
import {createCrmHandler} from '../supabase/functions/crm-api/handler.js';
import {inboundAgentCases} from './fixtures/inboundAgentEval.js';
const job={id:'job',lease_token:'lease',attempts:1};
test('evaluation inventory covers 50 supported and 20 adversarial scenarios',()=>{
 assert.equal(inboundAgentCases.filter(x=>x.kind==='supported').length,50);
 assert.equal(inboundAgentCases.filter(x=>x.kind==='adversarial').length,20);
 assert.equal(new Set(inboundAgentCases.map(x=>x.message)).size,70);
});
const ctx={settings:{mode:'shadow',system_prompt:'Be helpful'},business:{name:'Test',timeZone:'UTC'},profile:{hours:'9 to 5'},history:[{direction:'inbound',body:'Hi'}],services:[],latestMessage:'Hi'};
const final=reply=>({status:'completed',usage:{input_tokens:100,input_tokens_details:{cached_tokens:20},output_tokens:10},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({reply,citationIds:[]})}]}]});
function harness({context=ctx,toolResult={bookings:[]},results=[final('Hello!')]}={}) {
 const calls=[],requests=[];
 return {calls,requests,db:{call:async(name,...args)=>{
  calls.push([name,...args]);if(name==='inbound_ai_context')return context;if(name==='search_job_knowledge')return [];
  if(name==='inbound_ai_tool')return toolResult;return args.at(-1);
 }},fetchImpl:async(url,options)=>{requests.push(JSON.parse(options.body));const value=results.shift();return value instanceof Response?value:new Response(JSON.stringify(value),{status:200});}};
}
test('Responses uses the pinned model and bounded configuration, with cached usage',async()=>{
 const h=harness();const result=await processInboundAgent(job,h.db,{apiKey:'test',fetchImpl:h.fetchImpl});
 assert.equal(h.requests[0].model,INBOUND_AGENT_MODEL);assert.equal(h.requests[0].store,false);
 assert.equal(h.requests[0].reasoning.effort,'low');assert.equal(h.requests[0].max_output_tokens,4096);
 assert.equal(result.reply,'Hello!');assert.equal(result.estimatedCostMicros,262);
});
test('tool continuation returns all reasoning items and function results',async()=>{
 const reasoning={type:'reasoning',id:'rs1',encrypted_content:'opaque',summary:[]};
 const h=harness({results:[{status:'completed',output:[reasoning,{type:'function_call',name:'lookup_bookings',arguments:'{}',call_id:'c1'}]},final('I do not see an appointment.')]});
 await processInboundAgent(job,h.db,{apiKey:'test',fetchImpl:h.fetchImpl});
 assert.deepEqual(h.requests[1].input.at(-3),reasoning);assert.equal(h.requests[1].input.at(-1).call_id,'c1');
});
test('mutation reply is sent directly without an extra model call',async()=>{
 const h=harness({toolResult:{customerReply:'Please confirm the date.'},results:[{status:'completed',output:[{type:'function_call',name:'prepare_booking',arguments:'{}',call_id:'c1'}]}]});
 const result=await processInboundAgent(job,h.db,{apiKey:'test',fetchImpl:h.fetchImpl});assert.equal(result.reply,'Please confirm the date.');assert.equal(h.requests.length,1);
});
test('committed actions recover without an API call',async()=>{
 const h=harness({context:{...ctx,recoveredReply:'Booking confirmed.'}});
 assert.equal((await processInboundAgent(job,h.db,{apiKey:'',fetchImpl:h.fetchImpl})).reply,'Booking confirmed.');assert.equal(h.requests.length,0);
});
test('crash recovery cannot start a fourth provider attempt',async()=>{
 const h=harness();await processInboundAgent({...job,attempts:4},h.db,{apiKey:'test',fetchImpl:h.fetchImpl});
 assert.equal(h.requests.length,0);assert.equal(h.calls.at(-1).at(-1).code,'AI_ATTEMPTS_EXHAUSTED');
});
for(const [label,result,code] of [
 ['unauthorized',new Response('',{status:401}),'OPENAI_401'],['model unavailable',new Response('',{status:404}),'OPENAI_404'],
 ['rate limit',new Response('',{status:429}),'OPENAI_429'],['server failure',new Response('',{status:503}),'OPENAI_503'],
 ['token exhaustion',{status:'incomplete',output:[]},'AI_INCOMPLETE'],
 ['refusal',{status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'no'}]}]},'AI_REFUSAL'],
 ['malformed',{status:'completed',output:[]},'AI_INVALID_OUTPUT'],
 ['long response',final('x'.repeat(601)),'AI_INVALID_OUTPUT'],
 ['unknown tool',{status:'completed',output:[{type:'function_call',name:'sql',arguments:'{}'}]},'AI_UNKNOWN_TOOL'],
 ['foreign identity',{status:'completed',output:[{type:'function_call',name:'lookup_bookings',arguments:'{"phone":"+13035550000"}'}]},'AI_INVALID_TOOL'],
]) test(label+' fails through durable failure handler',async()=>{
 const h=harness({results:[result]});await processInboundAgent(job,h.db,{apiKey:'test',fetchImpl:h.fetchImpl});assert.equal(h.calls.at(-1)[0],'fail_inbound_ai');assert.equal(h.calls.at(-1).at(-1).code,code);
});
test('missing credentials and stale jobs do not call the model',async()=>{
 const h=harness();await processInboundAgent(job,h.db,{apiKey:'',fetchImpl:h.fetchImpl});assert.equal(h.calls.at(-1).at(-1).code,'AI_NOT_CONFIGURED');assert.equal(h.requests.length,0);
 const stale=harness({context:null});await processInboundAgent(job,stale.db,{apiKey:'test',fetchImpl:stale.fetchImpl});assert.equal(stale.calls.at(-1)[0],'finish');assert.equal(stale.requests.length,0);
});
test('deadline and tool budget prevent additional actions',async()=>{
 const h=harness();let time=0;await processInboundAgent(job,h.db,{apiKey:'test',fetchImpl:h.fetchImpl,now:()=>{time+=36000;return time;}});assert.equal(h.calls.at(-1).at(-1).code,'AI_TIMEOUT');assert.equal(h.requests.length,0);
 const cycle=harness({results:Array.from({length:4},(_,i)=>({status:'completed',output:[{type:'function_call',name:'lookup_bookings',arguments:'{}',call_id:'c'+i}]}))});
 await processInboundAgent(job,cycle.db,{apiKey:'test',fetchImpl:cycle.fetchImpl});assert.equal(cycle.calls.filter(c=>c[0]==='inbound_ai_tool').length,3);assert.equal(cycle.calls.at(-1).at(-1).code,'AI_TOOL_LIMIT');
});
test('settings and scoped pause routes coexist with disabled legacy group mutations',async()=>{
 const calls=[];const handler=createCrmHandler({call:async(...args)=>{calls.push(args);return {}; }},async()=> 'admin');
 const send=(path,method='GET',body)=>handler(new Request('https://example.com/crm-api'+path,{method,headers:{'X-Tenant-ID':'alpha'},...(body?{body:JSON.stringify(body)}:{})}));
 assert.equal((await send('/inbound-ai')).status,200);assert.equal(calls.at(-1)[0],'inbound_ai_settings_api');
 assert.equal((await send('/inbound-ai','PUT',{revision:0,mode:'off',systemPrompt:'',bookingEnabled:false})).status,200);
 assert.equal((await send('/conversations/00000000-0000-0000-0000-000000000001/ai/pause','POST',{})).status,200);
 assert.equal((await send('/automation-groups/old','PUT',{})).status,410);
});
