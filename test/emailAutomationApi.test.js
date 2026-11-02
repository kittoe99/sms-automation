import test from 'node:test';
import assert from 'node:assert/strict';
import {createCrmHandler} from '../supabase/functions/crm-api/handler.js';
test('email automation routes authenticate, scope their RPC and reject invalid drafts as client errors',async()=>{
 const calls=[];
 const handler=createCrmHandler({call:async(...args)=>{calls.push(args);return {templates:[],connections:[],domains:[],contacts:[],forms:[],runs:[],jobs:[]};}},async()=> 'staff');
 let response=await handler(new Request('http://localhost/api/email-automations/read',{headers:{'X-Tenant-ID':'business'}}));
 assert.equal(response.status,200);assert.deepEqual(calls[0],['email_automations','staff','business','read',{}]);
 assert.ok((await response.json()).starters.length);
 response=await handler(new Request('http://localhost/api/email-automations/create',{method:'POST',headers:{'X-Tenant-ID':'business'},body:JSON.stringify({definition:{}})}));
 assert.equal(response.status,400);assert.equal(calls.length,1);
 const denied=createCrmHandler({call:async()=>{throw Error('must not access database');}},async()=>{throw Object.assign(new Error('Unauthorized'),{status:401});});
 assert.equal((await denied(new Request('http://localhost/api/email-automations/read'))).status,401);
});
