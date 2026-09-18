import 'dotenv/config';
import {readFile} from 'node:fs/promises';
import {connectDatabase} from '../src/workers/database.js';
import {defaultTenantFromEnv} from '../src/lib/tenantContext.js';
const admin=process.env.CRM_ADMIN_CLERK_USER_ID;if(!admin) throw new Error('CRM_ADMIN_CLERK_USER_ID required');
const db=connectDatabase(process.env.SMS_API_DATABASE_URL);
const read=async path=>{try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT') return null;throw e;}};
const builtin=[
 {id:'quote-requests',name:'Quote follow-up',kind:'quote',rule:{startHour:9,endHour:19,steps:[1,1,1,2,2,7].map((delayCount,i)=>({id:`send-${i+1}`,delayCount,delayUnit:'day',template:'Hi {{first_name}}, {{business_name}} here. Are you still interested in your quote? Reply with any questions. Reply STOP to opt out.'}))}},
 {id:'appointment-reminders',name:'Appointment reminder',kind:'reminder',rule:{startHour:9,endHour:19,steps:[{id:'reminder',delayCount:1,delayUnit:'day',template:'Hi {{first_name}}, a reminder from {{business_name}} about your appointment on {{appointment_date}}. Reply if you need to reschedule. Reply STOP to opt out.'}]}},
];
try {
 const existing=(await db.call('api_read',admin,null,'businesses',{})).rows;
 const local=[defaultTenantFromEnv(),...(await read('data/local-businesses.json') || [])];
 const custom=(await read('data/automation-groups.json'))?.groups || [];
 for(const b of local) {
  if(!existing.some(x=>x.tenant_id===b.id)) await db.call('api_action',admin,null,'create_business',b);
  const groups=(await db.call('api_read',admin,b.id,'groups',{pageSize:250})).rows;
  for(const g of [...builtin,...custom.filter(x=>x.tenantId===b.id)]) {
   if(!groups.some(x=>x.id===g.id)) await db.call('api_action',admin,b.id,'group',{...g,active:g.activeAutomation!==false});
  }
 }
 console.log('Business definitions imported. Sending remains disabled; no contacts or consent were imported.');
} finally {await db.close();}
