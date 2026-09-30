// Local visual QA with synthetic records only. Never included by build:frontend.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
const dir=resolve('dist'),accountId='00000000-0000-4000-8000-000000000001',siteId='00000000-0000-4000-8000-000000000002';
const membership={account_id:accountId,tenant_id:'demo',role:'owner',enabled:true,website_read:true,enquiries_read:false,bookings_read:false,revision:0,business_name:'Example Services',name:'Example Owner',email:'owner@example.test'};
const site={id:siteId,slug:'example-preview',name:'Example Website',sms_tenant_id:'demo',owner_account_id:accountId,business_name:'Example Services',revision:0,created_at:'2026-09-29T12:00:00Z',details:{businessName:'Example Services',services:['Home repairs'],serviceAreas:['Denver']}};
const records={accounts:[{id:accountId,clerk_display_name:'Example Owner',clerk_primary_email:'owner@example.test',status:'active',created_at:site.created_at,onboarding_completed_at:site.created_at,memberships:[membership],websites:[site],identityMapped:true,personal_info:{firstName:'Example',lastName:'Owner'},business_profile:{businessName:'Example Services'}}],businesses:[{tenant_id:'demo',name:'Example Services',time_zone:'America/Denver',owner_account_id:accountId,memberships:[membership],sites:[site]}],websites:[site]};
const page=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/e2-theme.css"><style>body{padding:24px;background:#f4f8fa}.preview{max-width:1100px;margin:auto}h1{margin:16px 0}</style><script type="importmap">{"imports":{"fflate":"/vendor/fflate.js"}}</script></head><body><main class="preview"><p>Synthetic records · local visual verification</p><nav id="qa-nav"><button class="btn" data-view="accounts">Users</button> <button class="btn" data-view="businesses">Businesses</button> <button class="btn" data-view="websites">Websites</button></nav><h1 id="title"></h1><p id="subtitle"></p><div id="view-root"></div><div id="pager"></div></main><script>globalThis.SMS_CONFIG={hostingApiBase:location.origin+'/hosting'};</script><script type="module">import {initAuth} from '/auth.js?v=20260924-auth-loop1';import {createPlatform} from '/platform.js';await initAuth();const ui=createPlatform({root:document.querySelector('#view-root'),title:document.querySelector('#title'),subtitle:document.querySelector('#subtitle'),pager:document.querySelector('#pager')});await ui.render('platform-accounts');document.querySelectorAll('#qa-nav button').forEach(b=>b.onclick=()=>ui.render('platform-'+b.dataset.view));</script></body></html>`;
http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');let data;
  if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end(page);return;}
  if(url.pathname==='/shell'){
    let shell=await readFile(resolve(dir,'index.html'),'utf8');
    shell=shell.replace('<script src="/config.js"></script>',`<script>globalThis.SMS_CONFIG={hostingApiBase:location.origin+'/hosting'};document.getElementById('demo-banner').hidden=false;document.getElementById('demo-banner').textContent='Design preview · Synthetic records only';</script>`);
    res.setHeader('Content-Type','text/html');res.end(shell);return;
  }
  if(url.pathname==='/mobile'){
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><body style="margin:0;background:#dde8ee"><iframe title="CRM mobile preview" src="/shell?view=platform-websites" style="display:block;margin:20px auto;width:390px;height:844px;border:0"></iframe></body></html>');return;
  }
  if(url.pathname==='/api/auth/config')data={mode:'local'};
  else if(url.pathname==='/api/auth/me'||url.pathname==='/api/tenants')data={user:{id:'preview'},tenants:[{id:'demo',name:'Example Services',timeZone:'America/Denver',smsRead:true}],currentTenant:{id:'demo',name:'Example Services',timeZone:'America/Denver',smsRead:true},capabilities:{platformStaff:true}};
  else if(url.pathname==='/api/categories')data={categories:[],cadences:[],rulePresets:[]};
  else if(url.pathname==='/api/overview')data={conversationCount:12,total:48,deliveryRate:98,counts:{delivered:47},byCategory:[]};
  else if(url.pathname==='/api/provisioning')data={sendingEnabled:true};
  else if(url.pathname==='/api/onboarding')data={onboardingComplete:true,profile:{businessName:'Example Services'}};
  else if(url.pathname.startsWith('/api/platform/')){const type=url.pathname.split('/')[3];if(req.method==='GET'){let rows=records[type]||[];const id=url.searchParams.get('id');if(id)rows=rows.filter(x=>(x.id||x.tenant_id)===id);data={rows,total:rows.length,page:1,pageSize:25,totalPages:1};}else data={saved:true};}
  else if(url.pathname==='/hosting')data={sites:[{...site,publicationStatus:'unpublished',deployments:[]}]};
  else if(url.pathname.endsWith('/forms'))data={business:{tenantId:'demo',name:'Example Services'},connections:[]};
  else if(url.pathname.endsWith('/leads'))data={rows:[],total:0,totalPages:1};
  else if(url.pathname==='/api/web-forms')data={forms:[{public_id:'00000000-0000-4000-8000-000000000003',title:'Contact form',enabled:true}]};
  if(data){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));return;}
  const file=resolve(dir,'.'+decodeURIComponent(url.pathname));if(!file.startsWith(dir+sep)){res.writeHead(403);res.end();return;}
  res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':file.endsWith('.svg')?'image/svg+xml':'application/octet-stream');res.end(await readFile(file));
 }catch{res.writeHead(404);res.end('Not found');}
}).listen(4319,'127.0.0.1',()=>console.log('Synthetic platform preview: http://127.0.0.1:4319'));
