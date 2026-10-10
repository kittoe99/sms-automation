import test from 'node:test';import assert from 'node:assert/strict';
import {createCrmHandler} from '../supabase/functions/crm-api/handler.js';
import {mountContactAutomations,validateDirectSequence} from '../public/contactAutomations.js';
import {emptySequence,newMessage} from '../public/formAutomation.js';
test('direct APIs bind actor/business, enforce methods and forward retry keys',async()=>{
 const calls=[],handler=createCrmHandler({call:async(...p)=>{calls.push(p);return {};}},async()=> 'verified');
 const r=await handler(new Request('https://example.test/crm-api/contact-automations/enroll',{method:'POST',headers:{'X-Tenant-ID':'selected','Idempotency-Key':'stable'},body:JSON.stringify({tenant:'forged',user:'forged',contactId:'customer'})}));assert.equal(r.status,200);assert.deepEqual(calls.at(-1).slice(0,4),['contact_automations','verified','selected','enroll']);assert.equal(calls.at(-1)[4].idempotencyKey,'stable');
 assert.equal((await handler(new Request('https://example.test/crm-api/contact-automations/block',{headers:{'X-Tenant-ID':'selected'}}))).status,405);
});
test('direct editor permits Stop but rejects appointment sequences and unknown fields',()=>{
 const s={...emptySequence(),replyPolicy:'stop',steps:[newMessage('Hello {{name}}')]};assert.equal(validateDirectSequence(s).replyPolicy,'stop');assert.throws(()=>validateDirectSequence({...s,trigger:'appointment'}));assert.throws(()=>validateDirectSequence({...s,steps:[newMessage('{{field.unsaved}}')]}));
});
class Host{isConnected=true;nodes=new Map();html='';set innerHTML(v){this.html=v;this.nodes.clear();}get innerHTML(){return this.html;}querySelector(k){if(!this.nodes.has(k))this.nodes.set(k,new Host());return this.nodes.get(k);}querySelectorAll(){return [];}addEventListener(){} }
test('contact switching aborts stale reads and stale results cannot repaint or mutate',async()=>{
 const root=new Host();let resolve,oldSignal;const slow=mountContactAutomations(root,{apiFetch:(_,o)=>{oldSignal=o.signal;return new Promise(r=>resolve=r);}});
 await mountContactAutomations(root,{apiFetch:async()=>new Response(JSON.stringify({templates:[],canManage:false}))});assert.equal(oldSignal.aborted,true);resolve(new Response(JSON.stringify({templates:[{id:'old',name:'OLD BUSINESS'}],canManage:true})));await slow;assert.doesNotMatch(root.innerHTML,/OLD BUSINESS/);
});
