import {json,readJson,cors,failure,authenticate,env} from '../_shared/http.js';
import {phone,groupRule,localDateTime,business,message,contact,thread,group} from '../_shared/domain.js';
export function createCrmHandler(db,verify=authenticate) {
 return async request=>{
  let headers={};
  try {
   headers=cors(request); if(request.method==='OPTIONS') return new Response(null,{status:204,headers});
   const url=new URL(request.url),path=url.pathname.replace(/^.*\/crm-api/,'').replace(/^\/api/,'') || '/';
   if(path==='/auth/config') return json({mode:'clerk',manualBusinesses:true,configured:Boolean(env('CLERK_PUBLISHABLE_KEY')&&env('CLERK_ISSUER')),publishableKey:env('CLERK_PUBLISHABLE_KEY'),frontendApiUrl:env('CLERK_ISSUER')},200,headers);
   const user=await verify(request),tenant=request.headers.get('X-Tenant-ID');
   const read=(resource,p={})=>db.call('api_read',user,tenant,resource,p);
   const write=(action,p)=>db.call('api_action',user,tenant,action,p);
   const params=Object.fromEntries(url.searchParams); const method=request.method;
   if(path==='/auth/me'||path==='/tenants'||(path==='/businesses'&&method==='GET')) {
    const data=await read('businesses');const tenants=data.rows.map(business);
    return json({user:{id:user},tenants,businesses:tenants,currentTenant:tenants.find(x=>x.id===tenant)||tenants[0]||null,tenant:tenants[0]||null,capabilities:{databaseIsolation:true,providerCredentialsPerTenant:true,twilioCredentialsPerTenant:true}},200,headers);
   }
   if(path==='/businesses'&&method==='POST') {
    const p=await readJson(request);p.id ||= String(p.name||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,64);p.timeZone ||= 'America/Denver';
    return json({business:await write('create_business',p)},201,headers);
   }
   if(!tenant) return json({error:'Select a business'},400,headers);
   if(method==='GET') {
    if(path==='/overview'||path==='/deliverability') {
     const data=await read('overview');const sent=Object.entries(data.counts).filter(([s])=>s!=='received').reduce((n,[,v])=>n+Number(v),0);
     return json({...data,deliveryRate:sent?Math.round(100*(data.counts.delivered||0)/sent):null},200,headers);
    }
   if(path==='/operations') return json(await read('operations'),200,headers);
    if(path==='/provisioning') return json(await db.call('provider_setup',user,tenant),200,headers);
    if(path==='/categories'||path==='/automation-groups') {
     const [data,ai]=await Promise.all([read('groups',{pageSize:250}),read('ai_settings',{pageSize:250})]);
     const groups=data.rows.map(g=>{const setting=ai.rows.find(a=>a.group_id===g.id);return {...group(g),ai:setting?{...setting,defaultForInbound:Boolean(setting.default_for_inbound)}:{enabled:false,instructions:'',defaultForInbound:false}}});return json({categories:groups,groups},200,headers);
    }
    if(path.startsWith('/automations/')) {
     const id=decodeURIComponent(path.split('/')[2]);const [data,steps]=await Promise.all([read('groups',{id}),read('steps',{id,pageSize:250})]);
     return json({sequence:data.rows[0]?{...group(data.rows[0]),steps:steps.rows.map(s=>({...s,index:s.step_index,label:`Message ${s.step_index+1}`,delayMs:s.delay_count*86400000}))}:null},200,headers);
    }
    if(path==='/messages') {const data=await read('messages',params);return json({...data,messages:data.rows.map(message),summary:await read('overview')},200,headers);}
    if(path==='/enrollments') {
     const data=await read('enrollments',params);
     return json({...data,enrollments:data.rows.map(e=>({...e,metadata:{...e.metadata,drip:{stepIndex:e.step_index,nextSendAt:e.next_run_at,status:e.status}}}))},200,headers);
    }
    if(['/directory','/contacts','/opt-outs'].includes(path)) {
     const data=await read('contacts',{...params,...(path==='/opt-outs'?{opted_out:'1'}:{})});
     return json({...data,contacts:data.rows.map(contact)},200,headers);
    }
    if(path==='/conversations') {const data=await read('threads',params);return json({...data,conversations:data.rows.map(thread),unreadTotal:data.rows.reduce((n,c)=>n+c.unread_count,0)},200,headers);}
    if(path==='/calls') {const data=await read('calls',params);return json({...data,calls:data.rows},200,headers);}
    const conversation=path.match(/^\/conversations\/([^/]+)(\/calls)?$/);
    if(conversation) {
     const ph=phone(decodeURIComponent(conversation[1]));
     if(conversation[2]) {const data=await read('calls',{...params,phone:ph});return json({...data,calls:data.rows},200,headers);}
     const [data,messages,contacts]=await Promise.all([read('threads',{phone:ph}),read('messages',{phone:ph,pageSize:250}),read('contacts',{phone:ph})]);
     return json({conversation:data.rows[0]?{...thread(data.rows[0]),...contact(contacts.rows[0]),messages:messages.rows.map(message).reverse(),messageCount:messages.total}:null},200,headers);
    }
   } else {
    const p=await readJson(request);
    const send=path.match(/^\/conversations\/([^/]+)\/reply$/);
    if(path==='/send'||path==='/directory/message'||send) {
     const ph=phone(send?decodeURIComponent(send[1]):p.phone || p.to);
     const key=request.headers.get('Idempotency-Key') || p.idempotencyKey;
     if(!key) return json({error:'Idempotency-Key required'},400,headers);
     return json(await write('send',{phone:ph,body:String(p.body||'').trim(),purpose:send?'transactional':'marketing',category_id:p.categoryId||null,idempotencyKey:key}),202,headers);
    }
    if(path==='/contacts') return json({contact:contact(await write('contact',{...p,phone:phone(p.phone)}))},201,headers);
    const consent=path.match(/^\/contacts\/([^/]+)\/(opt-in|opt-out)$/);
    if(consent) return json(await write('consent',{phone:phone(decodeURIComponent(consent[1])),consent:consent[2]==='opt-in',evidence:p.evidence || (consent[2]==='opt-out'?'Admin suppression':null)}),200,headers);
    if(path==='/directory/enroll'||path==='/directory/unenroll') {
     p.phone=phone(p.phone);
     if(p.appointmentDate) {const businesses=await read('businesses');const tz=businesses.rows.find(b=>b.tenant_id===tenant)?.time_zone;p.appointment_at=localDateTime(`${p.appointmentDate}T${/^\d\d:\d\d$/.test(p.preferredTime)?p.preferredTime:'09:00'}`,tz).toISOString();}
     return json(await write(path.endsWith('/unenroll')?'unenroll':'enroll',p),200,headers);
    }
    const ai=path.match(/^\/conversations\/([^/]+)\/(read|ai\/pause|ai\/resume)$/);
    if(ai) return json(await write(ai[2].split('/').at(-1),{phone:phone(decodeURIComponent(ai[1]))}),200,headers);
    const groups=path.match(/^\/automation-groups(?:\/([^/]+))?(\/ai-instructions)?$/);
    if(groups) {
     const id=decodeURIComponent(groups[1] || p.id || crypto.randomUUID());
     if(groups[2]) return json(await db.call('configure_ai',user,tenant,id,Boolean(p.enabled),String(p.instructions||''),Boolean(p.defaultForInbound)),200,headers);
     if(method==='DELETE') return json(await write('delete_group',{id}),200,headers);
     const businesses=await read('businesses'),tz=businesses.rows.find(b=>b.tenant_id===tenant)?.time_zone;
     let rule;try{rule=groupRule(p.rule,tz);}catch(error){error.status=400;throw error;}
     return json({group:group(await write('group',{...p,id,rule}))},200,headers);
    }
    const retry=path.match(/^\/jobs\/([^/]+)\/retry$/);if(retry) return json(await write('retry_job',{id:retry[1]}),202,headers);
    if(path==='/provisioning/details') return json(await db.call('save_provider_setup',user,tenant,p),200,headers);
    if(path==='/twilio/provision') return json(await db.call('queue_provision',user,tenant),202,headers);
   }
   return json({error:'Route not found'},404,headers);
  } catch(error) {return failure(error,headers);}
 };
}
