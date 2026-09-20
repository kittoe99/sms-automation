import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSequenceDraftPrompt,generateAutomationSequence,validateSequenceDraft} from '../src/lib/automations/sequenceDraft.js';
import {processAutomationDraft} from '../src/workers/automationDraft.js';
import {processAutomation,renderBusinessTemplate} from '../src/workers/automation.js';

const input={automationType:'Quote follow-up',contextLabel:'roof replacement',goal:'Answer quote questions',tone:'Friendly',steps:[{stepIndex:0,delayCount:1,delayUnit:'day'},{stepIndex:1,delayCount:2,delayUnit:'day'}]};
const context={draft:{id:'draft',input},business:{name:'Alpha Roofing'},profile:{facts:{services:['Roof replacement']}}};
const messages=[
 {stepIndex:0,message:'Hi {{first_name}}, {{business_name}} here about your {{service_name}} quote. What questions can we answer? Reply STOP to opt out.'},
 {stepIndex:1,message:'{{business_name}} checking back on your {{service_name}} quote. Would you like help with the next step? Reply STOP to opt out.'},
];
const response=value=>Response.json({status:'completed',usage:{input_tokens:100,output_tokens:50},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});

test('sequence drafting requests one progressive message per configured step',async()=>{
 let calls=0;
 const result=await generateAutomationSequence(context,{apiKey:'test',inputCostPerMillion:1,outputCostPerMillion:2,fetchImpl:async(_url,options)=>{
  calls++;const payload=JSON.parse(options.body);assert.equal(payload.text.format.schema.properties.messages.minItems,2);return response({messages});
 }});
 assert.equal(calls,1);assert.deepEqual(result.messages,messages);assert.equal(result.estimatedCostMicros,200);
 assert.match(buildSequenceDraftPrompt(context),/Quote follow-up/);assert.match(buildSequenceDraftPrompt(context),/roof replacement/);
});

test('sequence validation rejects the entire result when a message is missing required context',()=>{
 assert.throws(()=>validateSequenceDraft({messages:[messages[0],{stepIndex:1,message:'Generic check in. Reply STOP to opt out.'}]},input),/invalid message/i);
 assert.throws(()=>validateSequenceDraft({messages:[messages[0]]},input),/wrong number/i);
});

test('draft worker completes one queued dashboard generation',async()=>{
 const calls=[];const db={call:async(name,...args)=>{calls.push([name,...args]);if(name==='draft_job_context')return context;return {status:'completed'};}};
 await processAutomationDraft({id:'job',lease_token:'lease'},db,{apiKey:'test',fetchImpl:async()=>response({messages})});
 assert.deepEqual(calls.map(x=>x[0]),['draft_job_context','complete_automation_draft']);
 assert.deepEqual(calls[1][3].messages,messages);
});

test('scheduled automation delivery is deterministic and never invokes OpenAI',async()=>{
 let fetches=0;const completed=[];
 const delivery={business:{name:'Alpha Roofing',time_zone:'UTC'},contact:{name:'Alex',phone:'+13035550123'},enrollment:{id:'enr',status:'active',step_index:0,next_run_at:'2026-01-01T00:00:00Z',created_at:'2026-01-01T00:00:00Z',generation:1,metadata:{}},group:{id:'quote',kind:'quote',version:1,rule:{startHour:0,endHour:24,contextLabel:'roof replacement'}},steps:[{template:'Hi {{first_name}}, {{business_name}} about your {{service_name}}. Reply STOP to opt out.',delay_count:0,delay_unit:'day'}]};
 const db={call:async(name,...args)=>{if(name==='job_context')return delivery;if(name==='complete_automation'){completed.push(args[2]);return {ok:true};}}};
 await processAutomation({id:'job',lease_token:'lease'},db,{fetchImpl:async()=>{fetches++;}});
 assert.equal(fetches,0);assert.match(completed[0].body,/Alpha Roofing/);assert.match(completed[0].body,/roof replacement/);assert.equal(completed[0].ai_drafted,undefined);
});

test('runtime context prefers enrollment metadata over the saved automation context',()=>{
 const body=renderBusinessTemplate('{{service_name}} / {{role_name}} / {{context_name}}',{contact:{},business:{},enrollment:{metadata:{service_name:'solar install'}},group:{rule:{contextLabel:'roof replacement'}}});
 assert.equal(body,'solar install / solar install / solar install');
});
