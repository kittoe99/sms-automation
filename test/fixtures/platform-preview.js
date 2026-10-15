// Local visual QA with synthetic records only. Never included by build:frontend.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
const dir=resolve('dist'),accountId='00000000-0000-4000-8000-000000000001',siteId='00000000-0000-4000-8000-000000000002';
const membership={account_id:accountId,tenant_id:'demo',role:'owner',enabled:true,website_read:true,enquiries_read:false,bookings_read:false,revision:0,business_name:'Example Services',name:'Example Owner',email:'owner@example.test'};
const site={id:siteId,slug:'example-preview',name:'Example Website',sms_tenant_id:'demo',owner_account_id:accountId,business_name:'Example Services',revision:0,created_at:'2026-09-29T12:00:00Z',details:{businessName:'Example Services',services:['Home repairs'],serviceAreas:['Denver']}};
const records={accounts:[{id:accountId,clerk_display_name:'Example Owner',clerk_primary_email:'owner@example.test',status:'active',created_at:site.created_at,onboarding_completed_at:site.created_at,memberships:[membership],websites:[site],identityMapped:true,personal_info:{firstName:'Example',lastName:'Owner'},business_profile:{businessName:'Example Services'}}],businesses:[{tenant_id:'demo',name:'Example Services',time_zone:'America/Denver',owner_account_id:accountId,memberships:[membership],sites:[site]}],websites:[site]};
const business=records.businesses[0];
const aiConnection={id:'00000000-0000-4000-8000-000000000099',staff_name:'Example Staff',subject:'user_example',client_id:'https://chatgpt.com/oauth/codex/example/client.json',status:'pending',permissions:[],business_ids:[],revision:0,created_at:'2026-10-14T12:00:00Z',last_used_at:null};
const aiActivity=[];
const previewForms=[{public_id:'00000000-0000-4000-8000-000000000003',title:'Contact form',description:'Website enquiries',button_label:'Submit',fields:[],enabled:true,archived:false,preset:'contacts',submissionCount:3,automationEnabled:true,publishedVersion:1,email_enabled:false}];
const websiteRequests=[{id:'00000000-0000-4000-8000-000000000020',title:'Refresh the homepage',category:'content',page:'Home',description:'Please update our homepage introduction.',status:'received',response:'',revision:0,created_at:'2026-10-08T12:00:00Z',updated_at:'2026-10-08T12:00:00Z'}];
business.registration={accountId,profile:{businessName:'Example Services',timeZone:'America/Denver',contactEmail:'owner@example.test',contactPhone:'+13035550123',summary:'Home repairs and maintenance for Denver customers.',services:['Home repairs'],locations:['Denver']}};
business.setup={revision:0,draft:{...business.registration.profile},reviewed_profile_id:null};
business.services=[];
records.accounts[0].loginApplication='customer';
const page=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/e2-theme.css"><style>body{padding:24px;background:#f4f8fa}.preview{max-width:1100px;margin:auto}h1{margin:16px 0}</style><script type="importmap">{"imports":{"fflate":"/vendor/fflate.js"}}</script></head><body><main class="preview"><p>Synthetic records · local visual verification</p><nav id="qa-nav"><button class="btn" data-view="accounts">Users</button> <button class="btn" data-view="businesses">Businesses</button> <button class="btn" data-view="websites">Websites</button></nav><h1 id="title"></h1><p id="subtitle"></p><div id="view-root"></div><div id="pager"></div></main><script>globalThis.SMS_CONFIG={hostingApiBase:location.origin+'/hosting'};</script><script type="module">import {initAuth} from '/auth.js?v=20261001-business-services';import {createPlatform} from '/platform.js';await initAuth();const ui=createPlatform({root:document.querySelector('#view-root'),title:document.querySelector('#title'),subtitle:document.querySelector('#subtitle'),pager:document.querySelector('#pager')});await ui.render('platform-accounts');document.querySelectorAll('#qa-nav button').forEach(b=>b.onclick=()=>ui.render('platform-'+b.dataset.view));</script></body></html>`;
http.createServer(async(req,res)=>{
 if(process.env.CRM_TAB_QA_LOG==='1' && req.url.startsWith('/api/')) console.log(req.method+' '+req.url);
 try{
  const url=new URL(req.url,'http://localhost');let data;
  if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end(page);return;}
  if(url.pathname==='/shell'){
    let shell=await readFile(resolve(dir,'index.html'),'utf8');
    shell=shell.replace('<script src="/config.js"></script>',`<script>globalThis.SMS_CONFIG={hostingApiBase:location.origin+'/hosting'};document.getElementById('demo-banner').hidden=false;document.getElementById('demo-banner').textContent='Design preview · Synthetic records only';</script>`);
    res.setHeader('Content-Type','text/html');res.end(shell);return;
  }
  if(url.pathname==='/mobile'){
    const mobileView=url.searchParams.get('view')==='web-forms'?'web-forms':'platform-websites';
    res.setHeader('Content-Type','text/html');res.end(`<!doctype html><html><body style="margin:0;background:#dde8ee"><iframe title="CRM mobile preview" src="/shell?view=${mobileView}" style="display:block;margin:20px auto;width:390px;height:844px;border:0"></iframe></body></html>`);return;
  }
  if(url.pathname==='/api/auth/config')data={mode:'local'};
  else if(url.pathname==='/api/auth/me'||url.pathname==='/api/tenants')data={user:{id:'preview'},tenants:[{id:'demo',name:'Example Services',timeZone:'America/Denver',smsRead:true}],currentTenant:{id:'demo',name:'Example Services',timeZone:'America/Denver',smsRead:true},capabilities:{platformStaff:process.env.SUMMARY_QA_READONLY!=='true'}};
  else if(url.pathname==='/api/sms/connection')data={businessName:'Example Services',profileName:'Example Services LLC',phoneNumber:'+18775550180',senderType:'toll_free',connectionStatus:'connected',approvalStatus:'approved',messagingStatus:'disabled'};
  else if(url.pathname==='/api/categories')data={categories:[],cadences:[],rulePresets:[]};
  else if(url.pathname==='/api/overview')data={conversationCount:12,total:48,deliveryRate:98,counts:{delivered:47},byCategory:[]};
  else if(url.pathname==='/api/provisioning')data=business.services.some(s=>s.kind==='sms')?{state:'configured',serviceAdded:true,sendingEnabled:false,existingConnection:true,phoneNumber:'+18775550180',connectionDetails:{accountSid:'AC'+'1'.repeat(32),accountName:'Example platform account',profileSid:'BU'+'2'.repeat(32),profileName:'Example Services LLC',phoneNumber:'+18775550180',messagingServiceSid:'MG'+'4'.repeat(32),serviceName:'Example Services · SMS',registrationSid:'HH'+'5'.repeat(32),senderType:'toll_free'}}:{sendingEnabled:true};
  else if(url.pathname==='/api/twilio/registration')data={state:'webhook_verified',updated_at:'2026-10-02T12:00:00Z'};
  else if(url.pathname==='/api/onboarding')data={onboardingComplete:true,profile:{businessName:'Example Services'}};
  else if(url.pathname==='/api/platform/twilio/accounts')data={accounts:[{sid:'AC'+'1'.repeat(32),name:'Example platform account',isParent:true}],truncated:false};
  else if(url.pathname==='/api/platform/twilio/profiles')data={connection:{revision:0},options:[{accountSid:'AC'+'1'.repeat(32),accountName:'Example platform account',profileSid:'BU'+'2'.repeat(32),profileName:'Example Services LLC',legalBusinessName:'Example Services LLC',phoneNumber:'+18775550180',phoneNumberSid:'PN'+'3'.repeat(32),messagingServiceSid:'MG'+'4'.repeat(32),serviceName:'Example Services · SMS',registrationSid:'HH'+'5'.repeat(32),senderType:'toll_free',approvalStatus:'Toll-free verified',webhookReady:true}],unavailable:[{name:'Example legacy service',phoneNumber:'+13035550180',reason:'A2P campaign is not verified'}],truncated:false};
  else if(url.pathname==='/api/platform/twilio/connect'){
   let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw);if(!input.confirmedBusinessIdentity)throw new Error('Identity confirmation required');
   business.services=[...business.services.filter(s=>s.kind!=='sms'),{id:'sms',tenant_id:'demo',kind:'sms',visibility:'draft',revision:0,providerState:'configured',phoneNumber:'+18775550180'}];data={connected:true,sendingEnabled:false};
  }
  else if(url.pathname==='/api/platform/ai-connections/activity')data={activity:aiActivity,page:1,total:aiActivity.length,totalPages:1};
  else if(url.pathname==='/api/platform/ai-connections'){
   if(req.method==='POST'){let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw);if(input.revision!==aiConnection.revision){res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Connection changed; refresh and retry'}));return;}Object.assign(aiConnection,{status:input.status,permissions:input.permissions,business_ids:input.businessIds,all_businesses:input.allBusinesses,revision:aiConnection.revision+1});aiActivity.unshift({created_at:new Date().toISOString(),tool:'connection_'+input.status,target:aiConnection.id,outcome:'success',request_id:crypto.randomUUID()});data={connection:aiConnection};}
   else data={connections:[aiConnection],page:1,total:1,totalPages:1};
  }
  else if(url.pathname.startsWith('/api/platform/')){const type=url.pathname.split('/')[3];if(req.method==='GET'){let rows=records[type]||[];const id=url.searchParams.get('id');if(id)rows=rows.filter(x=>(x.id||x.tenant_id)===id);data={rows,total:rows.length,page:1,pageSize:25,totalPages:1};}else {
   let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body||'{}');
   if(type==='business-profile'){
    business.setup.draft=input.profile;business.setup.revision++;
    if(url.pathname.endsWith('/review')){business.setup.reviewed_profile_id='reviewed';business.setup.reviewed_at=new Date().toISOString();}
   }else if(type==='services'&&url.pathname.endsWith('/visibility')){
    const service=business.services.find(s=>s.id===input.serviceId);service.visibility=input.visibility;service.revision++;
   }else if(type==='services'){
    business.services.push({id:input.kind,tenant_id:'demo',kind:input.kind,visibility:'draft',revision:0,providerState:'pending',...(input.kind==='website'?{site_id:siteId,siteName:site.name}:{})});
   }
   data=type==='business-register'?{id:'demo'}:{saved:true};
  }}
  else if(url.pathname===`/hosting/${siteId}/requests`){
    if(req.method==='PATCH'){let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw);const row=websiteRequests.find(r=>r.id===input.id);Object.assign(row,{status:input.status,response:input.response,revision:row.revision+1});}
    data={requests:websiteRequests};
  }
  else if(url.pathname==='/hosting'||url.pathname===`/hosting/${siteId}`){const detail={...site,publicationStatus:process.env.HOSTING_QA_VERSIONS==='1'?'published':'unpublished',liveDeploymentId:'live-fixture',deployments:process.env.HOSTING_QA_VERSIONS==='1'?[
   {id:'ready-fixture',status:'ready',created_at:'2026-10-10T16:30:00Z',source_bytes:2457600,preview_token:'a'.repeat(32)},
   {id:'live-fixture',status:'ready',created_at:'2026-10-09T16:30:00Z',source_bytes:2097152,preview_token:'b'.repeat(32)},
   {id:'failed-fixture',status:'failed',created_at:'2026-10-08T16:30:00Z',source_bytes:10240,error_message:'Missing or incomplete upload: index.html'},
  ]:[]};data=url.pathname==='/hosting'?{sites:[site],page:1,pageSize:25,total:1,totalPages:1}:{site:detail,page:1,pageSize:25,total:detail.deployments.length,totalPages:1};}
  else if(/^\/hosting\/[^/]+\/deployments\/[^/]+$/.test(url.pathname)&&req.method==='GET')data={assets:{files:[{path:'index.html',size:10240},{path:'styles.css',size:2048}]}};
  else if(url.pathname.endsWith('/forms'))data={business:{tenantId:'demo',name:'Example Services'},connections:[]};
  else if(url.pathname.endsWith('/leads'))data={rows:[],total:0,totalPages:1};
  else if(url.pathname==='/api/web-forms')data={canEdit:true,canManageAutomation:true,timeZone:'America/Denver',consentText:'Synthetic SMS consent',forms:previewForms};
  else if(/^\/api\/web-forms\/[^/]+(?:\/(archive|restore))?$/.test(url.pathname)&&['POST','PUT'].includes(req.method)){
   let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw||'{}');const form=previewForms.find(f=>f.public_id===url.pathname.split('/')[3]);
   if(!form)throw new Error('Form not found');
   if(url.pathname.endsWith('/archive'))Object.assign(form,{archived:true,enabled:false,automationEnabled:false});
   else if(url.pathname.endsWith('/restore'))Object.assign(form,{archived:false,enabled:false});
   else Object.assign(form,{title:input.title,description:input.description,fields:input.fields,button_label:input.buttonLabel,enabled:input.enabled,email_enabled:input.emailEnabled});
   data={form};
  }
  else if(url.pathname.startsWith('/api/automation-activity/')) {
    const rows=[{id:'00000000-0000-4000-8000-000000000030',customer:'Alex Example',phone:'+12025550123',form_title:'Contact form',status:'paused',origin:'form',form_id:previewForms[0].public_id,version:1,tags:[],unresolved_handoffs:1,ai_paused:true,latest_response:'Could someone help with my booking?',confirmed_bookings:0,cancelled_bookings:0,handoffs:1}];
    data={from:'2026-09-15',to:'2026-10-14',reportingAt:'2026-10-14T16:00:00Z',timeZone:'America/Denver',page:1,pageSize:25,total:1,rows,forms:[{id:previewForms[0].public_id,title:'Contact form'}],templates:[],tags:[],canManage:false,
      workload:{paused:1,aiPaused:1,unresolvedHandoffs:1,active:2,quiet:0},activity:{delivered:5,responses:2,accepted:5,aiSent:0},funnel:{contacted:2,responded:1,booked:0,responseRate:.5,conversionRate:0},outcomes:{linkedBookings:0,handoffs:1},definitions:{activity:'Actual message activity in selected dates.',cohort:'First accepted message in selected dates.',conversion:'Confirmed linked bookings.',workload:'Current workload across all dates.'}};
    if(url.pathname.endsWith('/timeline'))data={enquiry:rows[0],handoffs:[],bookings:[],canManage:false,events:[]};
  }
  else if(url.pathname==='/api/contact-automations/templates')data={templates:[],canManage:true};
  else if(url.pathname==='/api/inbound-ai')data={mode:'shadow',pilot:true,liveValidated:false,systemPrompt:'Use approved business information.',bookingEnabled:false,revision:1,runs:[],coordination:[],coordinationEnabled:true};
  else if(url.pathname==='/api/crm')data={leads:[],handoffs:[{id:'sample-request',contact_id:'sample-contact',reason:'Customer asked for a person.',status:'open',priority:'normal'}]};
  else if(url.pathname==='/api/automation-presets')data={presets:[]};
  else if(/^\/api\/web-forms\/[^/]+\/automation$/.test(url.pathname))data={draft:{steps:[]},enabled:false};
  else if(/^\/api\/web-forms\/[^/]+\/submissions$/.test(url.pathname))data={rows:[],total:0,totalPages:1};
  else if(/^\/api\/web-forms\/[^/]+\/test-runs$/.test(url.pathname))data={runs:[],sendingEnabled:false};
  else if(url.pathname==='/api/bookings'){
    const start=Date.now();res.on('close',()=>{if(process.env.CRM_TAB_QA_LOG==='1')console.log(`Bookings connection closed after ${Date.now()-start}ms`);});
    await new Promise(resolve=>setTimeout(resolve,Number(process.env.CRM_TAB_QA_DELAY_MS)||0));
    data={rows:[],total:0,totalPages:1};
  }
  if(data){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));return;}
  const file=resolve(dir,'.'+decodeURIComponent(url.pathname));if(!file.startsWith(dir+sep)){res.writeHead(403);res.end();return;}
  res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':file.endsWith('.svg')?'image/svg+xml':'application/octet-stream');res.end(await readFile(file));
 }catch{res.writeHead(404);res.end('Not found');}
}).listen(Number(process.env.CRM_TAB_QA_PORT)||4319,'127.0.0.1',()=>console.log('Synthetic platform preview ready'));
