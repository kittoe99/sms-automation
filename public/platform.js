import {createRenderQueue} from './tabWorkspace.js?v=20261002-workspace';
import {mountBusinessSetup} from './businessSetup.js?v=20261002-twilio-connect';
import {apiFetch,getAccessToken,runtimeConfig} from './auth.js?v=20261001-business-services';
const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const date=value=>value?new Date(value).toLocaleString():'—';
async function json(response){const data=await response.json();if(!response.ok)throw new Error(data.error||'Request failed. Please retry.');return data;}
const read=(resource,params={})=>apiFetch(`/api/platform/${resource}?${new URLSearchParams(params)}`,{tenant:false}).then(json);
const write=(action,input)=>apiFetch(`/api/platform/${action}`,{tenant:false,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}).then(json).then(data=>{window.dispatchEvent(new Event('crm:data-changed'));return data;});
async function hosting(path='',options={}){
 const base=runtimeConfig.hostingApiBase;
 if(!base)throw new Error('Website tools are not configured. Set HOSTING_API_BASE for the CRM deployment.');
 const token=await getAccessToken();if(!token)throw new Error('Sign in again to continue.');
 return json(await fetch(base.replace(/\/$/,'')+path,{...options,headers:{Authorization:`Bearer ${token}`,...(options.body?{'Content-Type':'application/json'}:{}),...options.headers},cache:'no-store'}));
}
const hostWrite=(path,body,method='POST')=>hosting(path,{method,...(body?{body:JSON.stringify(body)}:{})}).then(data=>{window.dispatchEvent(new Event('crm:data-changed'));return data;});
const button=(text,attrs='')=>`<button type="button" class="btn ghost" ${attrs}>${esc(text)}</button>`;
const field=(label,name,value='',attrs='')=>`<label class="compose-label">${esc(label)}<input name="${name}" value="${esc(value)}" ${attrs}/></label>`;
const checkbox=(label,name,checked=false)=>`<label><input type="checkbox" name="${name}" ${checked?'checked':''}/> ${esc(label)}</label>`;

export function createPlatform({root,title,subtitle,pager,onNavigate,onWorkspace,onOpenRecord}){
 let view='accounts',page=1,q='',selected=null,tab='dashboard',enquiryPage=1,enquiryType='all';
 // Cached website record + hosting payload so sub-tabs (dashboard,
 // domain, assets, business-info, leads) switch instantly without
 // refetching on every tab click. Invalidated by mutations.
 let siteCache=null, siteRecord=null;
 const sitePanels=new Map(), siteQueue=createRenderQueue();
 const pending = new Set();
 function openRecord(resource,id){if(onOpenRecord){onOpenRecord(resource,id);return;}view=resource;selected=id;tab='dashboard';siteCache=null;run(detail);}
 function bind(selector,event,callback){root.querySelectorAll(selector).forEach(node=>node.addEventListener(event,callback));}
 function run(callback){
  let task;try{task=Promise.resolve(callback());}catch(error){task=Promise.reject(error);}
  task=task.catch(error=>{const alert=root.querySelector('[data-error]');if(alert)alert.textContent=error.message;else root.insertAdjacentHTML('afterbegin',`<p role="alert">${esc(error.message)}</p>`);});
  pending.add(task);task.finally(()=>pending.delete(task));return task;
 }
 function error(){return '<p data-error class="login-error" role="alert"></p>';}
 async function directory(){
  title.textContent={accounts:'Users',businesses:'Businesses',websites:'Websites'}[view];subtitle.textContent='Platform management';pager.hidden=true;
  const result=await read(view,{page,pageSize:25,q});
  root.innerHTML=`<section class="card"><form data-search class="compose"><label>Search ${esc(title.textContent.toLowerCase())}<input name="q" value="${esc(q)}" maxlength="120"/></label><button class="btn">Search</button></form>${error()}
    ${view==='websites'?button('Create website','data-create-site'):''}
    ${view==='businesses'?button('Set up registered business','data-create-business'):''}
    <div class="platform-grid">${result.rows.map(row=>`<article class="card"><h2>${esc(row.clerk_display_name||row.name||row.clerk_primary_email||row.id)}</h2>
     <p>${esc(row.clerk_primary_email||row.tenant_id||(row.slug?`${row.slug}.e2local.com`:''))}</p>
     ${view==='accounts'?`<p>${esc(row.status)} · ${row.onboarding_completed_at?'Onboarding complete':'Onboarding pending'}${row.identityMapped?'':' · Identity mapping required'}</p><p>${row.loginApplication==='crm'?'Admin CRM':row.loginApplication==='customer'?'E2 Local':'Mapping required'} · ${esc(row.identity?.issuer)}</p>`:''}
     ${view==='businesses'?`<p>${row.owner_account_id?'Owner assigned':'Owner not assigned'} · ${row.setup?.reviewed_profile_id?'Profile reviewed':'Awaiting admin setup'}</p>`:''}
     ${view==='websites'?`<p>${esc(row.business_name||'Business not assigned')} · ${row.owner_account_id?'Owner assigned':'Owner not assigned'}</p>`:''}
     ${button('View details',`data-open="${esc(row.id||row.tenant_id)}"`)}</article>`).join('')||'<p>No matching records.</p>'}</div>
     <div class="compose-actions">${button('Previous',`data-page="${page-1}" ${page<=1?'disabled':''}`)}<span>Page ${page} of ${result.totalPages} · ${result.total} records</span>${button('Next',`data-page="${page+1}" ${page>=result.totalPages?'disabled':''}`)}</div></section>`;
  bind('[data-search]','submit',event=>{event.preventDefault();q=new FormData(event.currentTarget).get('q').trim();page=1;run(directory);});
  bind('[data-page]','click',event=>{page=Number(event.currentTarget.dataset.page);run(directory);});
  bind('[data-open]','click',event=>{if(selected!==event.currentTarget.dataset.open)siteCache=null;selected=event.currentTarget.dataset.open;tab='dashboard';run(detail);});
  bind('[data-create-site]','click',()=>run(createSite));
  bind('[data-create-business]','click',()=>run(registration));
 }
 async function lookup(container,resource,label,initial){
  container.innerHTML=`<label>${esc(label)}<input data-lookup-q placeholder="Search by name or email"/></label>${button('Search','data-lookup-search')}<select data-lookup required aria-label="${esc(label)}"></select>`;
  const select=container.querySelector('select');
  async function search(){const data=await read(resource,{q:container.querySelector('input').value,pageSize:100});select.innerHTML='<option value="">Choose…</option>'+data.rows.map(row=>`<option value="${esc(row.id||row.tenant_id)}" data-revision="${Number(row.revision||0)}">${esc(row.clerk_display_name||row.name||row.clerk_primary_email||row.id)}${row.clerk_primary_email?` (${esc(row.clerk_primary_email)})`:''}${resource==='accounts'&&row.identity?.issuer?` · ${esc(row.loginApplication||'unresolved')} · ${esc(row.identity.issuer)}`:''}</option>`).join('');if(initial&&!select.querySelector(`option[value="${CSS.escape(initial)}"]`))select.insertAdjacentHTML('beforeend',`<option value="${esc(initial)}">${esc(initial)}</option>`);if(initial)select.value=initial;}
  container.querySelector('button').addEventListener('click',()=>run(search));await search();return select;
 }
  async function detail(options={}){
  onNavigate?.(`platform-${view}`);
  const result=await read(view,{id:selected});const row=result.rows[0];if(!row)throw new Error('Record no longer exists.');
  if(view==='websites'){siteRecord=row;sitePanels.clear();if(!options.keepSite)siteCache=null;}
  title.textContent=row.clerk_display_name||row.name||row.clerk_primary_email||'Account';subtitle.textContent={accounts:row.loginApplication==='crm'?'CRM account':row.loginApplication==='customer'?'E2 Local account':'User account — mapping required',businesses:'Business workspace',websites:'Hosted website'}[view];
  root.innerHTML=`${button('Back to directory','data-back')}<section class="card">${error()}<div data-detail></div></section>`;
  bind('[data-back]','click',()=>{selected=null;siteCache=null;run(directory);});
  const body=root.querySelector('[data-detail]');
  if(view==='accounts')await account(body,row);else if(view==='businesses')await business(body,row);else await website(body,row);
 }
 // Instant website sub-tab switch: re-render from the cached record
 // instead of refetching the business directory + hosting payload.
 function switchSiteTab(next){
  return run(()=>siteQueue.run(async()=>{
    if(next===tab)return;
    const panel=root.querySelector('[data-website-body]');
    if(!panel||!siteRecord)return;
    sitePanels.set(tab,{nodes:[...panel.childNodes],enquiryPage,enquiryType});
    tab=next;
    const saved=sitePanels.get(tab);
    if(saved){panel.replaceChildren(...saved.nodes);enquiryPage=saved.enquiryPage;enquiryType=saved.enquiryType;}
    else {enquiryPage=1;panel.innerHTML='<p role="status">Opening tab…</p>';await renderWebsitePanel(panel,siteRecord);}
    root.querySelectorAll('[data-tab]').forEach(button=>{
      const active=button.dataset.tab===tab;
      button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;
      if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
    });
  }));
 }
 async function membershipEditor(container,{accountId,tenantId,membership,previousOwnerId=null}){
  const m=membership||{};
  container.innerHTML=`<form class="compose" data-membership><h3>${membership?'Edit access':'Assign business access'}</h3><div data-user-lookup></div><div data-business-lookup></div>
    <label>Role<select name="role"><option value="viewer">Customer viewer</option><option value="owner">Primary owner</option><option value="operator">Staff operator</option></select></label>
    <div class="platform-permissions">${checkbox('Enabled','enabled',m.enabled!==false)}${checkbox('View websites','websiteRead',m.website_read)}${checkbox('View website enquiries','enquiriesRead',m.enquiries_read)}${checkbox('View business bookings','bookingsRead',m.bookings_read)}${checkbox('Read SMS workspace (operators only)','smsRead',m.sms_read)}${checkbox('Manage forms (operators only)','formsManage',m.forms_manage)}</div>
    <p>Enquiries follow the current website ownership period. Booking access includes the business’s booking history. Ownership grants website viewing.</p><button class="btn">Save access</button></form>`;
  const userContainer=container.querySelector('[data-user-lookup]'),businessContainer=container.querySelector('[data-business-lookup]');
  const user=accountId?null:await lookup(userContainer,'accounts','Account',m.account_id);
  const tenant=tenantId?null:await lookup(businessContainer,'businesses','Business',m.tenant_id);
  if(accountId)userContainer.remove();if(tenantId)businessContainer.remove();
  const form=container.querySelector('form');form.elements.role.value=m.role||'viewer';
  function updateOperatorPermissions(){
    const operator=form.elements.role.value==='operator';
    for(const key of ['smsRead','formsManage']){form.elements[key].disabled=!operator;if(!operator)form.elements[key].checked=false;}
  }
  form.elements.role.addEventListener('change',updateOperatorPermissions);updateOperatorPermissions();
  form.addEventListener('submit',event=>{event.preventDefault();run(async()=>{
    const data=new FormData(form),id=accountId||user.value,t=tenantId||tenant.value,role=data.get('role');
    if(!id||!t)throw new Error('Choose an account and business.');
    const businessData=(await read('businesses',{id:t})).rows[0];
    const current=businessData.memberships.find(x=>x.account_id===id);
    const revision=membership?m.revision:current?.revision??-1;
    if(role==='owner'&&businessData.owner_account_id&&businessData.owner_account_id!==id&&!confirm('Transfer business ownership? The previous owner will lose customer access and the websites will start a new enquiry history period.'))return;
    await write(role==='owner'?'ownership':'memberships',{accountId:id,tenantId:t,role,revision,
      previousOwnerId:membership?previousOwnerId:businessData.owner_account_id,
      ...Object.fromEntries(['enabled','websiteRead','enquiriesRead','bookingsRead','smsRead','formsManage'].map(key=>[key,data.has(key)]))});await detail();
  });});
 }
 async function account(body,row){
  body.innerHTML=`<h2>${esc(row.clerk_display_name||'User')}</h2><p>${esc(row.clerk_primary_email)} · ${esc(row.status)} · ${row.onboarding_completed_at?'Onboarding complete':'Onboarding pending'}</p>
    <p>Account ID: <code>${esc(row.id)}</code></p><p>Created ${date(row.created_at)}</p>
    <p>Login application: <strong>${row.loginApplication==='crm'?'Admin CRM':row.loginApplication==='customer'?'E2 Local':'Mapping required'}</strong><br/>Clerk issuer: <code>${esc(row.identity?.issuer||'Mapping required')}</code><br/>Clerk subject: <code>${esc(row.identity?.subject||'Mapping required')}</code></p>
    ${row.status!=='deleted'?button(row.status==='active'?'Suspend access':'Restore access','data-status'):''}
    ${row.loginApplication==='customer'&&row.onboarding_completed_at?button('Set up business','data-setup-account'):''}
    ${row.registrationIssue?`<p role="alert">${esc(row.registrationIssue)}</p>`:''}
    <details><summary>Saved onboarding</summary><pre>${esc(JSON.stringify({personal:row.personal_info,business:row.business_profile},null,2))}</pre></details>
    <h3>Websites</h3>${(row.websites||[]).map(s=>button(s.name,`data-user-site="${esc(s.id)}"`)).join('')||'<p>No websites associated.</p>'}<h3>Businesses and access</h3>${row.memberships.map(m=>`<div class="card"><strong>${esc(m.business_name)}</strong><p>${esc(m.role)} · ${m.enabled?'Enabled':'Disabled'}</p>${button('Open business',`data-business="${esc(m.tenant_id)}"`)} ${button('Edit access',`data-edit-membership="${esc(m.tenant_id)}"`)}</div>`).join('')||'<p>No business access assigned.</p>'}<div data-editor></div>`;
  bind('[data-setup-account]','click',()=>run(()=>registration(row.id)));
  bind('[data-status]','click',()=>run(async()=>{if(row.status==='active'&&!confirm('Suspend access for this account? Its separate account in the other application will keep its own access.'))return;await write('status',{accountId:row.id,revision:row.revision,status:row.status==='active'?'suspended':'active'});await detail();}));
  bind('[data-user-site]','click',event=>{openRecord('websites',event.currentTarget.dataset.userSite);});
  bind('[data-business]','click',event=>{openRecord('businesses',event.currentTarget.dataset.business);});
  bind('[data-edit-membership]','click',event=>run(async()=>{const id=event.currentTarget.dataset.editMembership;const b=(await read('businesses',{id})).rows[0];await membershipEditor(body.querySelector('[data-editor]'),{accountId:row.id,tenantId:id,membership:row.memberships.find(m=>m.tenant_id===id),previousOwnerId:b.owner_account_id});}));
  if(row.status==='active')await membershipEditor(body.querySelector('[data-editor]'),{accountId:row.id});
 }
 async function business(body,row){
  body.innerHTML=`<h2>${esc(row.name)}</h2><p>Business ID: <code>${esc(row.tenant_id)}</code> · ${esc(row.time_zone)}</p>${button('Twilio connection','data-jump-twilio')}
    <div data-business-setup></div><h3>People</h3>${row.memberships.map(m=>`<div class="card"><strong>${esc(m.name||m.email||m.account_id)}</strong><p>${esc(m.role)} · ${m.enabled?'Enabled':'Disabled'}</p>${button('Open user',`data-user="${esc(m.account_id)}"`)} ${button('Edit access',`data-edit="${esc(m.account_id)}"`)}</div>`).join('')||'<p>No owner or customer access assigned.</p>'}
    <h3>Websites</h3>${row.sites.map(s=>button(s.name,`data-website="${esc(s.id)}"`)).join('')||'<p>No websites assigned.</p>'}<div data-editor></div>`;
  bind('[data-user]','click',event=>{openRecord('accounts',event.currentTarget.dataset.user);});
  bind('[data-website]','click',event=>{openRecord('websites',event.currentTarget.dataset.website);});
  bind('[data-edit]','click',event=>run(()=>membershipEditor(body.querySelector('[data-editor]'),{tenantId:row.tenant_id,accountId:event.currentTarget.dataset.edit,membership:row.memberships.find(m=>m.account_id===event.currentTarget.dataset.edit),previousOwnerId:row.owner_account_id})));
  mountBusinessSetup(body.querySelector('[data-business-setup]'),row,{read,write,reload:detail,lookup,
    onCreateWebsite:tenantId=>run(()=>createSite(tenantId)),
    onWebsite:id=>openRecord('websites',id),onWorkspace});
  bind('[data-jump-twilio]','click',()=>body.querySelector('[data-twilio-connection]').scrollIntoView({behavior:'auto',block:'start'}));
  await membershipEditor(body.querySelector('[data-editor]'),{tenantId:row.tenant_id});
 }
 async function registration(accountId=null){
  root.classList.add('platform-root');title.textContent='Business setup';subtitle.textContent='Registered customer';pager.hidden=true;
  onNavigate?.('platform-businesses');view='businesses';selected=null;
  root.innerHTML=`${button('Back to businesses','data-back')}<section class="card"><h2>Set up registered business</h2><p>Choose an E2 Local customer who has completed registration. Their submitted profile and owner link are retained.</p>${error()}<form class="compose" data-register><div data-account></div><details><summary>Resolve an existing business match</summary><p>Use this only when registration needs review. The selected business must belong to this customer or be unassigned.</p><div data-existing></div></details><button class="btn">Open business setup</button></form></section>`;
  bind('[data-back]','click',()=>run(directory));
  const account=await lookup(root.querySelector('[data-account]'),'accounts','Registered customer',accountId);
  const existing=await lookup(root.querySelector('[data-existing]'),'businesses','Existing business (optional)');existing.required=false;
  bind('[data-register]','submit',event=>{event.preventDefault();const button=event.submitter;button.disabled=true;run(async()=>{
    try{if(!account.value)throw new Error('Choose a registered customer.');
      const result=await write('business-register',{accountId:account.value,...(existing.value?{tenantId:existing.value}:{})});
      if(result.requiresReview)throw new Error('Several existing links need review. Choose the correct existing business above.');
      selected=result.id;await detail();
    }finally{button.disabled=false;}
  });});
 }
 async function createSite(tenantId=null){
  root.innerHTML=`${button('Back','data-back')}<section class="card">${error()}<form data-create class="compose"><h2>Create website</h2>${field('Name','name','','required maxlength="100"')}${field('E2 Local subdomain','slug','','required maxlength="32"')}<p>${tenantId?'This website will be linked to this business and hidden from the customer until you set it live.':'Assign its business after creation. Publishing is a separate action.'}</p><button class="btn">Create website</button></form></section>`;
  bind('[data-back]','click',()=>run(tenantId?detail:directory));bind('[data-create]','submit',event=>{event.preventDefault();const submit=event.submitter;submit.disabled=true;run(async()=>{try{
    const form=new FormData(event.currentTarget);const data=await hostWrite('',{name:form.get('name'),slug:form.get('slug')});
    // Navigate to the created record even if linking fails, so retry cannot create it twice.
    const siteId=data.site.id;selected=siteId;view='websites';tab='dashboard';
    if(tenantId){const site=(await read('websites',{id:siteId})).rows[0];await write('services',{tenantId,kind:'website',siteId,siteRevision:site.revision});view='businesses';selected=tenantId;}
    await detail();
  }catch(error){if(view==='websites'&&selected){await detail();throw new Error(`Website created. Link it from business setup: ${error.message}`);}throw error;}finally{submit.disabled=false;}});});
 }
  async function website(body,row){
  body.innerHTML=`<p>${esc(row.slug)}.e2local.com · ${esc(row.business_name||'Business not assigned')} · ${row.owner_account_id?'Owner assigned':'Owner not assigned'}</p>
   <nav class="compose-actions" role="tablist" aria-label="Website sections">${['dashboard','domain','assets','business-info','leads'].map(t=>`<button type="button" role="tab" class="btn ghost" data-tab="${t}" aria-selected="${String(tab===t)}" tabindex="${tab===t?'0':'-1'}" ${tab===t?'aria-current="page"':''}>${esc(t.replaceAll('-',' '))}</button>`).join('')}</nav><div data-website-body role="tabpanel"></div>`;
  bind('[data-tab]','click',event=>{switchSiteTab(event.currentTarget.dataset.tab);});
  body.querySelector('[role="tablist"]')?.addEventListener('keydown',event=>{
    if(event.key!=='ArrowRight'&&event.key!=='ArrowLeft')return;
    const tabs=[...body.querySelectorAll('[data-tab]')];if(!tabs.length)return;
    event.preventDefault();
    const current=tabs.indexOf(document.activeElement);
    const next=event.key==='ArrowRight'?tabs[(current+1+tabs.length)%tabs.length]:tabs[(current-1+tabs.length)%tabs.length];
    next.focus();switchSiteTab(next.dataset.tab);
  });
  const panel=body.querySelector('[data-website-body]');
  await renderWebsitePanel(panel,row);
 }
 async function renderWebsitePanel(panel,row){
  if(tab==='dashboard'){
    if(!siteCache||siteCache.id!==row.id){const all=await hosting();siteCache={id:row.id,all};}
    const site=siteCache.all.sites.find(s=>s.id===row.id);if(!site)throw new Error('Website not found.');
    panel.innerHTML=`<h3>${esc(site.name)}</h3><p>Publication: ${esc(site.publicationStatus)} · ${site.deployments.length} versions · Created ${date(site.created_at)}</p>
     ${site.publicationStatus==='published'?`<a class="btn" href="https://${esc(site.slug)}.e2local.com/" target="_blank" rel="noopener noreferrer">Visit website</a>`:''}
     <form data-assign class="compose"><h3>Assign business</h3><div data-lookup-business></div><p>The primary business owner receives website access. Form connections prevent cross-business reassignment.</p><button class="btn">Save assignment</button></form>
     ${button('Unpublish','data-unpublish')}${button('Delete website','data-delete-site')}`;
    const select=await lookup(panel.querySelector('[data-lookup-business]'),'businesses','Business',row.sms_tenant_id);
    bind('[data-assign]','submit',event=>{event.preventDefault();run(async()=>{if(!select.value)throw new Error('Choose a business.');await write('website-business',{siteId:row.id,tenantId:select.value,revision:row.revision});siteCache=null;await detail();});});
    bind('[data-unpublish]','click',()=>run(async()=>{if(confirm('Unpublish this website?')){await hostWrite(`/${row.id}`,null,'DELETE');siteCache=null;await detail();}}));
    bind('[data-delete-site]','click',()=>run(async()=>{const slug=prompt('Type the website subdomain to permanently delete its hosting files and records.');if(slug!==row.slug)return;await hostWrite(`/${row.id}?permanent=1`,{confirmSlug:slug},'DELETE');selected=null;siteCache=null;await directory();}));
  }else if(tab==='domain')panel.innerHTML=`<h3>E2 Local address</h3><p>https://${esc(row.slug)}.e2local.com/</p><p>Customer-owned domains are not configured in this release.</p>`;
  else if(tab==='business-info'){
    const d=row.details||{};panel.innerHTML=`<form data-details class="compose">${field('Website name','name',row.name,'required maxlength="100"')}${field('Business name','businessName',d.businessName,'maxlength="160"')}
      <label>Description<textarea name="description" maxlength="1500">${esc(d.description)}</textarea></label>${field('Contact email','contactEmail',d.contactEmail,'type="email"')}${field('Contact phone','contactPhone',d.contactPhone)}
      <label>Services (one per line)<textarea name="services">${esc((d.services||[]).join('\n'))}</textarea></label><label>Areas served (one per line)<textarea name="serviceAreas">${esc((d.serviceAreas||[]).join('\n'))}</textarea></label><button class="btn">Save website details</button></form>`;
    bind('[data-details]','submit',event=>{event.preventDefault();run(async()=>{const data=Object.fromEntries(new FormData(event.currentTarget));await hostWrite(`/${row.id}`,{name:data.name,details:{businessName:data.businessName,description:data.description,contactEmail:data.contactEmail,contactPhone:data.contactPhone,services:data.services.split('\n').map(x=>x.trim()).filter(Boolean),serviceAreas:data.serviceAreas.split('\n').map(x=>x.trim()).filter(Boolean)}},'PATCH');siteCache=null;await detail();});});
  }else if(tab==='assets')await assets(panel,row);
  else await leads(panel,row);
 }
  async function assets(panel,row){
  if(!siteCache||siteCache.id!==row.id){siteCache={id:row.id,all:await hosting()};}
  const all=siteCache.all,site=all.sites.find(s=>s.id===row.id);if(!site)throw new Error('Website not found.');
  panel.innerHTML=`<h3>Website files and versions</h3><form data-upload class="compose"><label>Choose a folder<input data-folder type="file" webkitdirectory multiple/></label><label>Or choose files / ZIP<input data-files type="file" multiple/></label><p>Root index.html required. Maximum 500 files, 20 MB per file, and 50 MB total.</p><button class="btn">Upload and build preview</button><p data-upload-status role="status"></p></form>
   ${site.deployments.map(d=>`<article class="card"><strong>${date(d.created_at)}</strong><p>${esc(d.status)} · ${Math.round(d.source_bytes/1024)} KB${site.liveDeploymentId===d.id?' · Live':''}</p>${d.error_message?`<p>${esc(d.error_message)}</p>`:''}
     ${button('View files',`data-files-id="${d.id}"`)} ${['staging','failed'].includes(d.status)?button('Build preview',`data-build="${d.id}"`):''}
     ${d.status==='ready'?`${d.preview_token?`<a class="btn ghost" href="https://p-${esc(d.preview_token)}.e2local.com/" target="_blank" rel="noopener noreferrer">Preview</a>`:''} ${button(site.liveDeploymentId===d.id?'Published':'Publish',`data-publish="${d.id}" ${site.liveDeploymentId===d.id?'disabled':''}`)}`:''}
     ${button('Delete version',`data-delete-version="${d.id}" ${site.liveDeploymentId===d.id||d.status==='building'?'disabled':''}`)}</article>`).join('')||'<p>No deployments uploaded.</p>'}<div data-file-list></div>`;
  bind('[data-build]','click',event=>run(async()=>{await hostWrite(`/${row.id}/deployments/${event.currentTarget.dataset.build}`,{action:'build'});siteCache=null;await detail();}));
  bind('[data-publish]','click',event=>run(async()=>{if(confirm('Publish this version to the live website?')){await hostWrite(`/${row.id}/deployments/${event.currentTarget.dataset.publish}`,{action:'publish'});siteCache=null;await detail();}}));
  bind('[data-delete-version]','click',event=>run(async()=>{if(confirm('Permanently delete this unpublished version?')){await hostWrite(`/${row.id}/deployments/${event.currentTarget.dataset.deleteVersion}`,null,'DELETE');siteCache=null;await detail();}}));
  bind('[data-files-id]','click',event=>run(async()=>{const data=await hosting(`/${row.id}/deployments/${event.currentTarget.dataset.filesId}`);panel.querySelector('[data-file-list]').innerHTML=`<h3>Saved files</h3><ul>${data.assets.files.map(f=>`<li>${esc(f.path)} · ${Math.round(f.size/1024)} KB</li>`).join('')}</ul>`;}));
  bind('[data-upload]','submit',event=>{event.preventDefault();run(async()=>{
    const form=event.currentTarget,submit=form.querySelector('button');submit.disabled=true;
    try{
      let files=[...form.querySelector('[data-folder]').files,...form.querySelector('[data-files]').files];
      const {prepareHostingFiles}=await import('./hostingUpload.js');files=await prepareHostingFiles(files);
      const status=form.querySelector('[data-upload-status]');status.textContent='Preparing upload…';
      const created=await hostWrite(`/${row.id}/deployments`,{mode:'static',files:files.map(f=>({path:f.path,size:f.file.size}))});
      for(const upload of created.uploads){const f=files.find(f=>f.path===upload.path);const response=await fetch(upload.url,{method:'PUT',headers:{'Content-Type':upload.contentType},body:f.file});if(!response.ok)throw new Error('Upload failed. Check R2 upload CORS and retry with a new version.');status.textContent=`Uploaded ${upload.path}`;}
      status.textContent='Building preview…';const built=await hostWrite(`/${row.id}/deployments/${created.deploymentId}`,{action:'build'});siteCache=null;await detail();
      if(built.previewUrl)root.querySelector('[data-detail]').insertAdjacentHTML('afterbegin',`<p><a href="${esc(built.previewUrl)}" target="_blank" rel="noopener noreferrer">Open the new preview</a></p>`);
    }finally{submit.disabled=false;}
  });});
 }
 async function leads(panel,row){
  const [connections,enquiries]=await Promise.all([hosting(`/${row.id}/forms`),hosting(`/${row.id}/leads?page=${enquiryPage}&pageSize=25&type=${enquiryType}`)]);
  panel.innerHTML=`<h3>Forms and enquiries</h3><p>${connections.business?esc(connections.business.name):'Not connected: assign a business first.'}</p>
    ${connections.connections.map(c=>`<article class="card"><strong>${esc(c.title)}</strong><p>${esc(c.type)} · Connection ${c.enabled?'enabled':'disabled'} · SMS form ${c.formEnabled?'enabled':'disabled'}</p><textarea readonly aria-label="Embed snippet">${esc(c.snippet)}</textarea>${button('Copy snippet',`data-copy="${esc(c.id)}"`)}${c.enabled?button('Disable connection',`data-disable="${esc(c.id)}"`):''}</article>`).join('')}
    ${connections.business?'<form data-connect class="compose"><label>SMS form<select data-form required></select></label><button class="btn">Connect form</button><p>Copy the snippet into website files, then upload, preview, and publish.</p></form>':''}
    <label>Submission type<select data-type>${['all','contacts','quote_requests','bookings'].map(t=>`<option value="${t}" ${t===enquiryType?'selected':''}>${esc(t.replaceAll('_',' '))}</option>`).join('')}</select></label>
    ${enquiries.rows.map(e=>`<article class="card"><h4>${esc(e.name||'Enquiry')}</h4><p>${esc(e.email)} · ${esc(e.phone)}</p><p>${esc(e.type)} · ${date(e.submittedAt)} · ${esc(e.automationStatus)}</p>${e.appointmentAt?`<p>Requested appointment: ${date(e.appointmentAt)}</p>`:''}<details><summary>Saved answers and labels</summary><pre>${esc(JSON.stringify({answers:e.details,labels:e.fieldSnapshot},null,2))}</pre></details></article>`).join('')||`<p>${connections.connections.length?'No enquiries for this filter.':'No website/form connections.'}</p>`}
    <div class="compose-actions">${button('Previous',`data-enquiry-page="${enquiryPage-1}" ${enquiryPage===1?'disabled':''}`)}<span>Page ${enquiryPage} of ${enquiries.totalPages} · ${enquiries.total} enquiries</span>${button('Next',`data-enquiry-page="${enquiryPage+1}" ${enquiryPage>=enquiries.totalPages?'disabled':''}`)}</div>`;
  bind('[data-copy]','click',event=>run(async()=>{const btn=event.currentTarget;await navigator.clipboard.writeText(connections.connections.find(c=>c.id===btn.dataset.copy).snippet);btn.textContent='Copied';}));
  bind('[data-disable]','click',event=>run(async()=>{if(confirm('Disable this connection? Customers will lose access to its enquiries.')){await hostWrite(`/${row.id}/forms?connection=${event.currentTarget.dataset.disable}`,null,'DELETE');await detail();}}));
  if(connections.business){const response=await apiFetch('/api/web-forms',{headers:{'X-Tenant-ID':connections.business.tenantId}});const data=await json(response);panel.querySelector('[data-form]').innerHTML=data.forms.filter(f=>f.enabled).map(f=>`<option value="${esc(f.public_id||f.publicId||f.id)}">${esc(f.title||f.preset)}</option>`).join('');}
  bind('[data-connect]','submit',event=>{event.preventDefault();run(async()=>{await hostWrite(`/${row.id}/forms`,{formId:panel.querySelector('[data-form]').value});await detail();});});
  bind('[data-type]','change',event=>{enquiryType=event.currentTarget.value;enquiryPage=1;run(()=>detail({keepSite:true}));});
  bind('[data-enquiry-page]','click',event=>{enquiryPage=Number(event.currentTarget.dataset.enquiryPage);run(()=>detail({keepSite:true}));});
 }
 return {snapshot(){return {view,page,q,selected,tab,enquiryPage,enquiryType,siteCache,siteRecord,panels:new Map(sitePanels)};},restore(saved){({view,page,q,selected,tab,enquiryPage,enquiryType,siteCache,siteRecord}=saved);sitePanels.clear();for(const [key,value] of saved.panels)sitePanels.set(key,value);},async whenIdle(){await Promise.all([...pending]);},async openRecord(resource,id){root.classList.add('platform-root');view=resource;selected=id;tab='dashboard';siteCache=null;await run(detail);},async openBusiness(id){root.classList.add('platform-root');view='businesses';selected=id;siteCache=null;await run(detail);},async openRegistration(){await run(registration);},async render(nextView){root.classList.add('platform-root');const resource=nextView.replace('platform-','');if(resource!==view){view=resource;selected=null;siteCache=null;page=1;q='';}await (selected?detail():directory());}};
}
