import test from 'node:test';
import assert from 'node:assert/strict';
import {createCrmHandler} from '../supabase/functions/crm-api/handler.js';

test('booking API is tenant scoped and requires cancellation idempotency',async()=>{
 process.env.CRM_ALLOWED_ORIGINS='https://crm.example.com';
 const calls=[];const db={call:async(name,...args)=>{calls.push([name,...args]);if(name==='booking_settings')return {enabled:false};if(name==='save_booking_settings')return args[2];if(name==='list_bookings')return {bookings:[],total:0};if(name==='booking_detail')return {id:args[2]};if(name==='cancel_booking'){if(!args[3])throw Object.assign(new Error('Idempotency-Key required'),{code:'P0001'});return {id:args[2],status:'cancelled'};}}};
 const handler=createCrmHandler(db,async()=> 'admin'),headers={Origin:'https://crm.example.com','X-Tenant-ID':'alpha','Content-Type':'application/json'};
 assert.equal((await handler(new Request('https://example.com/functions/v1/crm-api/booking-settings',{headers}))).status,200);
 assert.equal((await handler(new Request('https://example.com/functions/v1/crm-api/booking-settings',{method:'PUT',headers,body:JSON.stringify({enabled:true})}))).status,200);
 assert.equal((await handler(new Request('https://example.com/functions/v1/crm-api/bookings?page=1',{headers}))).status,200);
 assert.equal((await handler(new Request('https://example.com/functions/v1/crm-api/bookings/sms%3A1',{headers}))).status,200);
 assert.equal((await handler(new Request('https://example.com/functions/v1/crm-api/bookings/sms%3A1/cancel',{method:'POST',headers,body:'{}'}))).status,400);
 assert.equal((await handler(new Request('https://example.com/functions/v1/crm-api/bookings/sms%3A1/cancel',{method:'POST',headers:{...headers,'Idempotency-Key':'cancel-key'},body:'{}'}))).status,200);
 assert.ok(calls.every(call=>call[1]==='admin'&&call[2]==='alpha'));
 delete process.env.CRM_ALLOWED_ORIGINS;
});
