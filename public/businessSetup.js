const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
import {profileFromForm,profileEditorHtml,bindProfileEditor} from './businessProfileEditor.js?v=20261016-document';
import {mountTwilioConnection} from './twilioConnection.js?v=20261003-sms-nav';
import {mountVoiceSetup} from './voiceSetup.js';
export {profileFromForm};
// Staff-run marketing services: no CRM workspace; release shows a managed status panel to the customer.
const managedKinds=['search_ads','seo','facebook_ads'];
const serviceLabels={sms:'SMS',enquiries:'Website enquiries',bookings:'Bookings',voice:'Voice',email:'Email',search_ads:'Google Search Ads',seo:'SEO',facebook_ads:'Facebook Ads'};
export function mountBusinessSetup(container,row,{read,write,reload,onCreateWebsite,onWebsite,onWorkspace,lookup}) {
 const setup=row.setup||{revision:0,draft:{}},profile={...row.registration?.profile,...setup.draft};
 const services=row.services||[],reviewed=Boolean(setup.reviewed_profile_id);
 // Pending customer requests from the dashboard. Adding the service marks a request activated.
 const requests=row.serviceRequests||[],requested=new Set(requests.map(r=>r.kind));
 const serviceName=kind=>serviceLabels[kind]||(kind==='website'?'Website':kind);
 container.innerHTML=`<div data-twilio-connection></div><section class="card business-profile-card">
   <form class="compose business-profile-form" data-profile><p data-profile-error class="login-error" role="alert"></p>
   ${profileEditorHtml(profile)}
   <div class="profile-savebar"><div><strong>${reviewed?'Reviewed profile':'Ready when you are'}</strong><p>${reviewed?'Reviewed '+esc(new Date(setup.reviewed_at).toLocaleString())+'. Draft edits take effect after review.':'Save your progress, or review the facts to continue with service setup.'}</p></div>
   <div class="compose-actions"><button class="btn ghost" type="submit" name="intent" value="draft" formnovalidate>Save draft</button><button class="btn" type="submit" name="intent" value="review">Save business info</button></div></div>
   <p class="profile-note">Saving a reviewed profile does not publish a website or activate SMS sending.</p>
   </form>
   ${row.registration?`<details class="profile-registration"><summary>View original customer registration</summary><pre>${esc(JSON.stringify(row.registration.profile,null,2))}</pre></details>`:''}
   </section>
   <div data-voice-setup></div><section class="card"><h3>Other services</h3><p>Set live makes a service visible in the customer dashboard. Publishing a website and activating SMS are separate controls. Use the Voice setup panel above for voice agents and customer access.</p>
   <p data-service-error class="login-error" role="alert"></p>
   ${requests.length?`<section class="card" data-service-requests><h4>Customer requests</h4>
    <p>The customer asked for these from their dashboard. Add the service below to activate it, or decline the request.</p>
    ${requests.map(r=>`<article class="card"><p><strong>${esc(serviceName(r.kind))}</strong> · requested ${esc(new Date(r.requestedAt).toLocaleString())}${r.requestedBy?' by '+esc(r.requestedBy):''}</p>
     ${services.some(s=>s.kind===r.kind)?'<p>Already added. Setting it live below completes this request.</p>':''}
     <button type="button" class="btn ghost" data-decline-request="${esc(r.id)}">Decline</button></article>`).join('')}</section>`:''}
   ${services.filter(s=>s.kind!=='voice').map(s=>`<article class="card"><h4>${esc(s.kind==='website'?s.siteName||'Website':serviceLabels[s.kind])}</h4>
    <p>${s.visibility==='live'?'Live · visible to customer':'Draft · hidden from customer'}${s.kind==='sms'?` · Setup: ${esc(s.providerState||'pending')}${s.phoneNumber?' · '+esc(s.phoneNumber):''}`:''}</p>
    <button type="button" class="btn" data-release="${esc(s.id)}" ${!reviewed&&s.visibility!=='live'?'disabled':''}>${s.visibility==='live'?'Hide from customer':'Set live'}</button>
    ${s.kind==='website'?`<button type="button" class="btn ghost" data-site="${esc(s.site_id)}">Manage website</button>`:managedKinds.includes(s.kind)?'<p>Managed by E2 Local staff. The customer dashboard shows an active status panel once live.</p>':`<button type="button" class="btn ghost" data-configure="${s.kind}">Configure ${s.kind==='sms'?'SMS':s.kind}</button>`}</article>`).join('')||'<p>No services added.</p>'}
   <div class="compose-actions">${['sms','enquiries','bookings','email',...managedKinds].filter(kind=>!services.some(s=>s.kind===kind)).map(kind=>`<button type="button" class="btn ghost" data-add="${kind}" ${!reviewed?'disabled':''}>Add ${managedKinds.includes(kind)?serviceLabels[kind]:kind==='sms'?'SMS':kind==='voice'?'Voice':kind}${requested.has(kind)?' · requested':''}</button>`).join('')}
   <button type="button" class="btn ghost" data-new-site ${!reviewed?'disabled':''}>Create website</button>
   <button type="button" class="btn ghost" data-link-site ${!reviewed?'disabled':''}>Link existing website</button></div><div data-site-link></div></section>`;
 mountTwilioConnection(container.querySelector('[data-twilio-connection]'),row,{read,write,reload,onWorkspace});
 async function perform(button,error,action){if(button)button.disabled=true;error.textContent='';try{await action();await reload();}catch(e){error.textContent=e.message;if(button)button.disabled=false;}}
 void mountVoiceSetup(container.querySelector('[data-voice-setup]'),{load:()=>read('voice-setup',{tenantId:row.tenant_id}),write,onLibrary:()=>onWorkspace(row.tenant_id,'voice'),onAgent:id=>onWorkspace(row.tenant_id,'voice',id),onBusiness:()=>container.querySelector('[data-profile]').scrollIntoView({block:'start'})});
 const editor=bindProfileEditor(container.querySelector('[data-profile]'));
 container.querySelector('[data-profile]').addEventListener('submit',event=>{
  event.preventDefault();const form=event.currentTarget,button=event.submitter;
  const intent=button?.value==='draft'?'draft':'review';
  try{editor.prepare(intent==='review');}catch(error){form.querySelector('[data-profile-error]').textContent=error.message;return;}
  void perform(button,form.querySelector('[data-profile-error]'),()=>write(`business-profile/${intent}`,{
    tenantId:row.tenant_id,revision:setup.revision,profile:profileFromForm(new FormData(form),profile),
  }));
 });
 const error=container.querySelector('[data-service-error]');
 container.querySelectorAll('[data-add]').forEach(button=>button.addEventListener('click',()=>void perform(button,error,()=>write('services',{tenantId:row.tenant_id,kind:button.dataset.add}))));
 container.querySelectorAll('[data-decline-request]').forEach(button=>button.addEventListener('click',()=>void perform(button,error,()=>write('service-requests/decline',{tenantId:row.tenant_id,requestId:button.dataset.declineRequest}))));
 container.querySelectorAll('[data-release]').forEach(button=>button.addEventListener('click',()=>{
  const service=services.find(s=>s.id===button.dataset.release);
  void perform(button,error,()=>write('services/visibility',{tenantId:row.tenant_id,serviceId:service.id,revision:service.revision,visibility:service.visibility==='live'?'draft':'live'}));
 }));
 container.querySelectorAll('[data-site]').forEach(button=>button.addEventListener('click',()=>onWebsite(button.dataset.site)));
 container.querySelectorAll('[data-configure]').forEach(button=>button.addEventListener('click',()=>onWorkspace(row.tenant_id,button.dataset.configure)));
 container.querySelector('[data-new-site]').addEventListener('click',()=>onCreateWebsite(row.tenant_id));
 container.querySelector('[data-link-site]').addEventListener('click',async()=>{
  const target=container.querySelector('[data-site-link]');target.innerHTML='<form class="compose"><div data-lookup></div><button class="btn">Link website</button></form>';
  try {
   const select=await lookup(target.querySelector('[data-lookup]'),'websites','Website');
   target.querySelector('form').addEventListener('submit',event=>{event.preventDefault();void perform(event.submitter,error,async()=>{
    if(!select.value)throw new Error('Choose a website.');
    await write('services',{tenantId:row.tenant_id,kind:'website',siteId:select.value,siteRevision:Number(select.selectedOptions[0].dataset.revision)});
   });});
  }catch(e){error.textContent=e.message;}
 });
}
