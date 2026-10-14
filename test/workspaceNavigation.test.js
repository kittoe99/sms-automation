import test from 'node:test';
import assert from 'node:assert/strict';
import {permittedGroups,navigationMarkup,groupForView,syncNavigation,syncNavigationTabs} from '../public/workspaceNavigation.js';
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


// Minimal DOM model: replacing markup destroys the original pointer/focus target.
class NavigationHost {
 writes=0;nodes=[];groups=[];attributes={};
 set innerHTML(html) {
  this.writes++;this.nodes=[...html.matchAll(/<button([^>]+)>/g)].map(([,attrs])=>{
   const classes=new Set((attrs.match(/class="([^"]+)"/)?.[1]||'').split(' '));
   return {dataset:{view:attrs.match(/data-view="([^"]+)"/)?.[1]},attributes:{},
    classList:{contains:key=>classes.has(key),toggle:(key,on)=>on?classes.add(key):classes.delete(key)},
    setAttribute(key,value){this.attributes[key]=value;},removeAttribute(key){delete this.attributes[key];}};
  });
  this.groups=[...html.matchAll(/<details[^>]+data-navigation-group="([^"]+)"([^>]*)>/g)].map(([,id,attrs])=>({dataset:{navigationGroup:id},open:attrs.includes('open')}));
 }
 querySelectorAll(selector){return selector==='[data-view]'?this.nodes:this.groups.filter(g=>g.open);}
 querySelector(selector){return this.groups.find(g=>selector===`[data-navigation-group="${g.dataset.navigationGroup}"]`);}
 setAttribute(key,value){this.attributes[key]=value;}
}

test('async shell completion preserves click targets, active groups and manually collapsed navigation',()=>{
 const nav=new NavigationHost(),options={view:'inbound-ai',staff:true,tenant:{smsRead:true},query:''};
 assert.equal(syncNavigation(nav,options),true);
 const target=nav.nodes.find(n=>n.dataset.view==='messages'),group=nav.groups.find(g=>g.dataset.navigationGroup==='ai');
 group.open=false;
 syncNavigation(nav,options);assert.equal(nav.writes,1);assert.equal(group.open,false);
 assert.equal(nav.nodes.find(n=>n.dataset.view==='messages'),target);
 syncNavigation(nav,{...options,view:'messages'});assert.equal(nav.writes,1);assert.equal(target.attributes['aria-current'],'page');
 assert.equal(nav.groups.find(g=>g.dataset.navigationGroup==='reports').open,true);
 syncNavigation(nav,{...options,view:'call'});assert.equal(nav.nodes.find(n=>n.dataset.view==='messaging').attributes['aria-current'],'page');
 syncNavigation(nav,{...options,staff:false,tenant:{smsRead:false,formsManage:true}});
 assert.equal(nav.writes,2);assert.deepEqual(nav.nodes.map(n=>n.dataset.view),['web-forms']);
});

test('sibling tabs keep their original targets while selection updates and search rebuilds only when needed',()=>{
 const tabs=new NavigationHost(),group=groupForView('messages');
 syncNavigationTabs(tabs,group,'messages');const target=tabs.nodes[1];
 syncNavigationTabs(tabs,group,'deliverability');syncNavigationTabs(tabs,group,'deliverability');
 assert.equal(tabs.writes,1);assert.equal(tabs.nodes[1],target);assert.equal(target.attributes['aria-selected'],'true');assert.equal(target.tabIndex,0);
 const nav=new NavigationHost(),options={view:'messages',staff:true,tenant:{smsRead:true},query:'delivery'};
 syncNavigation(nav,options);syncNavigation(nav,{...options,query:' DELIVERY '});assert.equal(nav.writes,1);
 syncNavigation(nav,{...options,query:'forms'});assert.equal(nav.writes,2);
});
