import test from 'node:test';
import assert from 'node:assert/strict';
import {readDashboard} from '../public/dashboardData.js';
import {formCards} from '../public/formDirectory.js';

test('dashboard follow-ups use the current forms contract and preserve each automation state',async()=>{
  const forms=[
    {public_id:'live',title:'Estimate',enabled:true,automationEnabled:true,publishedVersion:2,submissionCount:4},
    {public_id:'paused',title:'Appointment',enabled:false,automationEnabled:true,publishedVersion:3,submissionCount:0},
    {public_id:'archived',title:'Old enquiry',archived:true,enabled:false,submissionCount:9},
  ];
  const calls=[];
  const data=await readDashboard(async path=>{calls.push(path);return Response.json(path==='/api/web-forms'?{forms}:{});},async()=>{});
  const html=formCards(data.formsData.forms);
  assert.match(html,/Active · v2/);assert.match(html,/Paused · form inactive · v3/);assert.match(html,/Stopped/);
  for(const form of forms)assert.ok(html.includes(`data-form-open="${form.public_id}"`));
  assert.equal((html.match(/data-form-tab="automation"/g)||[]).length,3);
  assert.ok(calls.includes('/api/web-forms'));assert.ok(calls.every(path=>!path.includes('automation-groups')));
});
