import test from 'node:test';
import assert from 'node:assert/strict';
import {formTotals,filterForms,formCards} from '../public/formDirectory.js';
import {readDashboard} from '../public/dashboardData.js';
const forms=[
  {public_id:'one',title:'Estimate',preset:'quote_requests',enabled:true,automationEnabled:true,submissionCount:12},
  {public_id:'two',title:'Appointment',enabled:false,publishedVersion:2,submissionCount:0},
  {public_id:'three',title:'Old contact',archived:true,enabled:true,automationEnabled:true,submissionCount:5},
];
test('directory includes archived submissions but excludes archived forms from active totals',()=>{
  assert.deepEqual(formTotals(forms),{forms:3,live:1,automations:1,submissions:17});
  assert.equal(filterForms(forms).length,3);
  assert.deepEqual(filterForms(forms,'','live').map(f=>f.public_id),['one']);
  assert.deepEqual(filterForms(forms,'contact','archived').map(f=>f.public_id),['three']);
  assert.equal(filterForms(forms,'missing').length,0);
  assert.equal(formTotals([{...forms[0],submissionCount:undefined}]).submissions,null);
});
test('cards escape form content, preserve zero counts and respect submission permissions',()=>{
  const html=formCards([{...forms[1],title:'<script>bad</script>',description:'<img onerror=bad>',fields:[{label:'<b>Name</b>',required:true}],created_at:'2026-10-08T12:00:00Z'}],{canReadSubmissions:false,timeZone:'UTC'});
  assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('<dd>0</dd>'));assert.ok(html.includes('Paused · v2'));
  assert.ok(!html.includes('data-form-tab="submissions"'));assert.ok(!html.includes('data-form-tab="automation"'));
  assert.ok(html.includes('&lt;b&gt;Name&lt;/b&gt; (required)'));
});
test('dashboard keeps form failures distinct from an empty list and preserves cancellation',async()=>{
  const read=async(path)=>path==='/api/web-forms'?new Response(null,{status:503}):Response.json({});
  assert.equal((await readDashboard(read,async()=>{})).formsData,null);
  const result=await readDashboard(async path=>Response.json(path==='/api/web-forms'?{forms}:{}),async()=>{});
  assert.deepEqual(result.formsData.forms,forms);
  await assert.rejects(readDashboard(async path=>{if(path==='/api/web-forms')throw new DOMException('Changed page','AbortError');return Response.json({});},async()=>{}),{name:'AbortError'});
});
