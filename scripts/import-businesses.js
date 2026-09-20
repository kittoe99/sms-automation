import 'dotenv/config';
import {readFile} from 'node:fs/promises';
import {connectDatabase} from '../src/workers/database.js';
import {defaultTenantFromEnv} from '../src/lib/tenantContext.js';
const admin=process.env.CRM_ADMIN_CLERK_USER_ID;if(!admin) throw new Error('CRM_ADMIN_CLERK_USER_ID required');
const db=connectDatabase(process.env.SMS_API_DATABASE_URL);
const read=async path=>{try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT') return null;throw e;}};
const builtin=[
 {id:'quote-requests',name:'Quote follow-up',kind:'quote',rule:{trigger:'quote.created',aiDraft:true,startHour:9,endHour:19,steps:[
  {id:'send-1',delayCount:1,delayUnit:'day',template:'Hi {{first_name}}, thanks for requesting a quote from {{business_name}}. Do you have any questions about the estimate or what is included? Reply STOP to opt out.'},
  {id:'send-2',delayCount:1,delayUnit:'day',template:'Hi {{first_name}}, checking in on your quote. Has anything changed with the scope, timing, or details we should know about? Reply STOP to opt out.'},
  {id:'send-3',delayCount:1,delayUnit:'day',template:'Hi {{first_name}}, if you are ready to move forward with your quote, reply with the day or time that works best and we can help with the next step. Reply STOP to opt out.'},
  {id:'send-4',delayCount:2,delayUnit:'day',template:'Hi {{first_name}}, are you still considering the quote from {{business_name}}? If a question or concern is holding things up, reply here and we will help. Reply STOP to opt out.'},
  {id:'send-5',delayCount:2,delayUnit:'day',template:'Hi {{first_name}}, if your plans or project details changed, reply and we can review the quote with you before you decide. Reply STOP to opt out.'},
  {id:'send-6',delayCount:7,delayUnit:'day',template:'Hi {{first_name}}, this is our final quote follow-up for now. We will close the reminder sequence, but you can reply anytime if you would like to revisit it. Reply STOP to opt out.'},
 ]}},
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
