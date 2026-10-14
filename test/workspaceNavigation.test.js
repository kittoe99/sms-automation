import test from 'node:test';
import assert from 'node:assert/strict';
import {permittedGroups,navigationMarkup,groupForView} from '../public/workspaceNavigation.js';
import {readHome,homeMarkup} from '../public/workspaceHome.js';

test('daily work stays directly accessible while permission-filtered siblings remain separate',()=>{
 const staff=permittedGroups(true,{smsRead:true});
 assert.deepEqual(staff.filter(g=>g.daily).map(g=>g.label),['Home','Inbox','Contacts','Bookings','Follow-ups','Forms']);
 const formsOnly=permittedGroups(false,{formsManage:true,smsRead:false});
 assert.deepEqual(formsOnly.flatMap(g=>g.views.map(v=>v.view)),['web-forms']);
 const reader=permittedGroups(false,{smsRead:true});
 assert.ok(!reader.some(g=>['ai','settings','admin'].includes(g.id)));
 assert.ok(!reader.flatMap(g=>g.views).some(v=>['handoffs','email'].includes(v.view)));
 assert.deepEqual(permittedGroups(true,null).map(g=>g.id),['admin']);
 assert.deepEqual(permittedGroups(false,null),[]);
});
test('legacy labels find their current destination and bookmarks retain their group',()=>{
 for(const [query,view] of [['shadow','inbound-ai'],['deliverability','deliverability'],['direct automation','contact-templates'],['opt-outs','optouts']]) {
  assert.match(navigationMarkup({view:'overview',staff:true,tenant:{},query}),new RegExp(`data-view="${view}"`));
 }
 assert.equal(groupForView('call').id,'inbox');
 assert.equal(groupForView('platform-twilio').id,'admin');
 assert.doesNotMatch(navigationMarkup({view:'overview',staff:false,tenant:{smsRead:true},query:'shadow'}),/data-view="inbound-ai"/);
});
test('Home reads existing endpoints only, separates partial failure from zero and escapes customer text',async()=>{
 const calls=[];const data=await readHome(async path=>{
  calls.push(path);
  if(path.endsWith('/overview'))return Response.json({conversationCount:0,total:0,deliveryRate:null});
  if(path.includes('/enquiries'))return Response.json({from:'2026-10-01',to:'2026-10-14',timeZone:'America/Denver',rows:[{id:'one',customer:'<script>bad</script>',status:'paused',form_title:'Contact'}]});
  return new Response('',{status:503});
 });
 assert.equal(calls.length,4);assert.equal(data.summary,null);assert.equal(data.totals.total,0);
 const html=homeMarkup(data);assert.match(html,/Unavailable/);assert.match(html,/>0<\/strong>/);
 assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
 assert.doesNotMatch(html,/data-home-view="business-setup"/);
 assert.match(html,/2026-10-01 to 2026-10-14/);
});
test('Home propagates cancellation and authorization failures instead of showing empty work',async()=>{
 for(const status of [401,403])await assert.rejects(readHome(async()=>new Response('',{status})),e=>e.status===status);
 await assert.rejects(readHome(async()=>{throw new DOMException('Navigation changed','AbortError');}),{name:'AbortError'});
});
