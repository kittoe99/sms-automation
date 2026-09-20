import {CADENCE_PRESETS} from '../../../src/lib/automations/rulePresets.js';

export function phone(value) {
 const raw=String(value || '').trim(); let digits=raw.replace(/\D/g,'');
 if(!raw.startsWith('+') && digits.length===10) digits='1'+digits;
 const result='+'+digits;
 if(!/^\+[1-9]\d{7,14}$/.test(result)) throw Object.assign(new Error('Valid international phone number required'),{status:400});
 return result;
}
export function groupRule(input={},timeZone='America/Denver') {
 const units=Object.fromEntries(Object.entries(CADENCE_PRESETS).map(([id,value])=>[id,[value.intervalCount,value.intervalUnit]]));
 units.custom=[input.intervalCount || 1,input.intervalUnit || 'day'];
 const cadence=input.cadence || 'daily'; if(!units[cadence]) throw new Error('Invalid cadence');
 const [intervalCount,intervalUnit]=units[cadence];
 const source=input.steps?.length?input.steps:Array.from({length:input.repeatCount || 1},()=>({template:input.template,delayCount:intervalCount,delayUnit:intervalUnit}));
 if(source.length<1 || source.length>30) throw new Error('Use 1–30 steps');
 const steps=source.map((s,i)=>{
   const template=String(s.template || '').trim(),delayCount=Number(s.delayCount ?? intervalCount),delayUnit=s.delayUnit || intervalUnit;
   if(!template || template.length>1600 || !Number.isInteger(delayCount) || delayCount<0 || delayCount>365 || !['day','week','month'].includes(delayUnit)) throw new Error('Invalid automation step');
   return {id:`send-${i+1}`,template,delayCount,delayUnit};
 });
 const startHour=Number(input.startHour ?? 9),endHour=Number(input.endHour ?? 19);
 if(!Number.isInteger(startHour)||!Number.isInteger(endHour)||startHour<0||endHour>24||endHour<=startHour) throw new Error('Invalid sending window');
 let firstSendAt=null;
 if(input.firstSendAt) firstSendAt=localDateTime(input.firstSendAt,timeZone).toISOString();
 return {cadence,intervalCount,intervalUnit,repeatCount:steps.length,aiDraft:input.aiDraft!==false,steps,template:steps[0].template,startHour,endHour,firstSendAt};
}
export function localDateTime(value,timeZone) {
 if(/(?:Z|[+-]\d\d:\d\d)$/i.test(value)) { const date=new Date(value); if(!Number.isFinite(+date)) throw new Error('Invalid date'); return date; }
 const match=String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:T| )(\d{2}):(\d{2})(?::\d{2})?$/);
 if(!match) throw new Error('Use an ISO date and time');
 const [,y,m,d,h,min]=match.map(Number),desired=Date.UTC(y,m-1,d,h,min); let candidate=desired;
 const parts=date=>Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
 for(let i=0;i<4;i++){const p=parts(new Date(candidate)); const delta=desired-Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute);candidate+=delta;if(!delta)break;}
 const p=parts(new Date(candidate)); if(p.year!==y||p.month!==m||p.day!==d||p.hour!==h||p.minute!==min) throw new Error('Date does not exist in this business timezone');
 return new Date(candidate);
}
export const business=b=>({id:b.tenant_id,name:b.name,shortName:b.name,timeZone:b.time_zone,status:b.status,sendingEnabled:b.sending_enabled});
export const message=m=>({...m,categoryId:m.category_id,contactPhone:m.contact_phone,to:m.direction==='outbound'?m.contact_phone:null,from:m.direction==='inbound'?m.contact_phone:null,deliverability:m.status==='submission_unknown'?'needs-review':m.status,createdAt:m.created_at,updatedAt:m.updated_at,errorCode:m.error_code,statusHistory:m.status_history || []});
export const contact=c=>({...c,smsMarketingConsent:c.marketing_consent,canEnroll:c.marketing_consent&&!c.opted_out,optedOut:c.opted_out,primarySource:c.source,sources:[c.source]});
export const thread=c=>({...c,unreadCount:c.unread_count,lastBody:c.last_body,lastDirection:c.last_direction,lastMessageAt:c.last_message_at,aiPausedAt:c.ai_paused?'paused':null});
export const group=g=>({...g,custom:g.kind==='custom',system:g.kind!=='custom',activeAutomation:g.active,rule:g.rule});
